// ==UserScript==
// @name         DeepNet Script Window Manager
// @namespace    https://macinsight.github.io/deepwiki/modding/
// @version      4.0.0
// @description  Window management: z-stacking, position persistence, anchor snapping, terminal focus — auto-discovers userscript panels
// @author       Rain
// @match        https://deepnet.us/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════════════
    //  AUTO-DISCOVERY: detect userscript panels by structure
    //  Convention: fixed-position element, ID ending in -panel,
    //  contains a titlebar child (class *-titlebar or id *-titlebar),
    //  toggles visibility via .visible class or display style.
    // ═══════════════════════════════════════════════════════════
    const panels = new Map(); // key → { sel, key, tb, btns, el }

    function deriveKey(el) {
        // #dntw-panel → dntw, #my-cool-panel → my-cool
        const id = el.id || '';
        return id.replace(/-panel$/i, '') || id;
    }

    function findTitlebarEl(el) {
        // 1. Child whose class contains -titlebar
        for (const child of el.children) {
            if (child.className && /\b\S+-titlebar\b/.test(child.className)) return child;
        }
        // 2. Child whose id contains -titlebar or titlebar
        for (const child of el.children) {
            if (child.id && /titlebar/i.test(child.id)) return child;
        }
        // 3. First child that looks like a header (narrow, has buttons)
        const first = el.firstElementChild;
        if (first && first.offsetHeight > 0 && first.offsetHeight < 40) return first;
        return null;
    }

    function findBtnSelector(el) {
        // Look for button elements with class containing -hdr-btn or -win-btn
        const btn = el.querySelector('[class*="-hdr-btn"], [class*="-win-btn"]');
        if (btn) {
            const match = btn.className.match(/\b(\S+(?:-hdr-btn|-win-btn)\S*)\b/);
            if (match) return '.' + match[1].split(' ')[0];
        }
        return null;
    }

    function isUserscriptPanel(el) {
        if (!el || !el.id || !el.id.endsWith('-panel')) return false;
        if (panels.has(deriveKey(el))) return false; // already registered
        const cs = window.getComputedStyle(el);
        if (cs.position !== 'fixed') return false;
        // Must have a titlebar-like child
        if (!findTitlebarEl(el)) return false;
        // Exclude native game panels (DeepOS windows, etc.)
        if (el.classList.contains('deepos-window')) return false;
        return true;
    }

    function registerPanel(el) {
        const key = deriveKey(el);
        if (panels.has(key)) return panels.get(key);
        const tbEl = findTitlebarEl(el);
        const btnSel = findBtnSelector(el);
        const entry = {
            sel: '#' + el.id,
            key,
            tb: tbEl,       // store element ref directly (more reliable than selector)
            btns: btnSel,
            el,
        };
        panels.set(key, entry);
        console.log(`[WM] registered panel: #${el.id} (key=${key})`);
        return entry;
    }

    function getPanelEntries() {
        return [...panels.values()];
    }

    // Scan DOM for unregistered panels
    function discoverPanels() {
        document.querySelectorAll('[id$="-panel"]').forEach(el => {
            if (isUserscriptPanel(el)) registerPanel(el);
        });
    }

    const STORAGE_KEY = 'dn-wm-positions';
    const SNAP_DIST = 14;
    const STICK_DIST = 6;
    const DETACH_DIST = 30;    // must drag child this far from anchor to detach
    const SHADOW_PAD = 20;
    const BASE_Z = 6000;
    let topZ = BASE_Z;
    let restoring = false;

    // ═══════════════════════════════════════════════════════════
    //  ANCHOR SYSTEM
    //  - anchorChildren: Map<anchorEl, Set<childEl>>
    //  - childOf: Map<childEl, anchorEl>
    //  - Only unattached panels can attach to an anchor
    //  - Dragging anchor moves anchor + children
    //  - Dragging child detaches it (moves solo)
    // ═══════════════════════════════════════════════════════════
    const anchorChildren = new Map();  // parent → Set of direct children
    const childOf = new Map();         // child → parent
    const snapEdge = new Map();        // child → { side, offset }

    function hasChildren(el) { return anchorChildren.has(el) && anchorChildren.get(el).size > 0; }
    function isChild(el) { return childOf.has(el); }

    // Walk up to find the root of a chain
    function getRootAnchor(el) {
        let cur = el;
        while (childOf.has(cur)) cur = childOf.get(cur);
        return cur;
    }

    // Collect all descendants recursively
    function getDescendants(el) {
        const result = new Set();
        const queue = [el];
        while (queue.length) {
            const cur = queue.shift();
            const kids = anchorChildren.get(cur);
            if (kids) {
                for (const c of kids) {
                    if (!result.has(c)) { result.add(c); queue.push(c); }
                }
            }
        }
        return result;
    }

    // Would attaching child to parent create a cycle?
    function wouldCycle(child, parent) {
        let cur = parent;
        while (cur) {
            if (cur === child) return true;
            cur = childOf.get(cur);
        }
        return false;
    }

    function detectEdge(childRect, anchorRect) {
        const gaps = [
            { side: 'right',  gap: Math.abs(childRect.left - anchorRect.right) },
            { side: 'left',   gap: Math.abs(childRect.right - anchorRect.left) },
            { side: 'bottom', gap: Math.abs(childRect.top - anchorRect.bottom) },
            { side: 'top',    gap: Math.abs(childRect.bottom - anchorRect.top) },
        ];
        const best = gaps.reduce((a, b) => a.gap < b.gap ? a : b);
        const offset = (best.side === 'right' || best.side === 'left')
            ? childRect.top - anchorRect.top
            : childRect.left - anchorRect.left;
        return { side: best.side, offset };
    }

    function attach(child, parent) {
        if (child === parent) return;
        if (isChild(child)) return; // already attached somewhere
        if (wouldCycle(child, parent)) return;
        if (!anchorChildren.has(parent)) anchorChildren.set(parent, new Set());
        anchorChildren.get(parent).add(child);
        childOf.set(child, parent);
        snapEdge.set(child, detectEdge(vRect(child), vRect(parent)));
    }

    function detach(child) {
        const parent = childOf.get(child);
        if (!parent) return;
        childOf.delete(child);
        snapEdge.delete(child);
        const kids = anchorChildren.get(parent);
        if (kids) {
            kids.delete(child);
            if (kids.size === 0) anchorChildren.delete(parent);
        }
    }

    function detachAll(el) {
        // Detach el from its parent
        detach(el);
        // Detach all descendants
        const desc = getDescendants(el);
        for (const c of desc) {
            childOf.delete(c);
            snapEdge.delete(c);
        }
        anchorChildren.delete(el);
        for (const c of desc) anchorChildren.delete(c);
    }

    function getDirectChildren(el) {
        return anchorChildren.get(el) || new Set();
    }

    // Reposition a child to maintain its snapped edge against the anchor
    function repositionChild(child) {
        const anchor = childOf.get(child);
        const edge = snapEdge.get(child);
        if (!anchor || !edge) return;
        const ar = vRect(anchor);
        const cr = vRect(child);

        // With transform-origin: top left, visual top-left = style.left/top
        // Visual width/height = offsetWidth * scale
        let newLeft, newTop;

        if (edge.side === 'right') {
            // Child sits to the right of anchor
            newLeft = Math.round(ar.right);
            newTop = Math.round(ar.top + edge.offset);
        } else if (edge.side === 'left') {
            // Child sits to the left of anchor
            newLeft = Math.round(ar.left - cr.width);
            newTop = Math.round(ar.top + edge.offset);
        } else if (edge.side === 'bottom') {
            // Child sits below anchor
            newLeft = Math.round(ar.left + edge.offset);
            newTop = Math.round(ar.bottom);
        } else if (edge.side === 'top') {
            // Child sits above anchor
            newLeft = Math.round(ar.left + edge.offset);
            newTop = Math.round(ar.top - cr.height);
        }

        child.style.left = newLeft + 'px';
        child.style.top = newTop + 'px';
        child.dataset.dragged = '1';
    }

    // When any panel resizes, reposition its descendants (and itself if it's a child)
    function onPanelResize(el) {
        if (restoring || drag) return;
        // If this panel has descendants, reposition them in tree order
        const desc = getDescendants(el);
        if (desc.size > 0) {
            for (const c of desc) {
                repositionChild(c);
                const entry = findEntry(c);
                if (entry) savePanel(entry.key, c);
            }
            updateShadowClips();
        }
        if (isChild(el)) {
            repositionChild(el);
            // Also reposition anything attached to this child
            const myDesc = getDescendants(el);
            for (const c of myDesc) {
                repositionChild(c);
                const entry = findEntry(c);
                if (entry) savePanel(entry.key, c);
            }
            const entry = findEntry(el);
            if (entry) savePanel(entry.key, el);
            updateShadowClips();
        }
    }

    const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) onPanelResize(entry.target);
    });

    // ═══════════════════════════════════════════════════════════
    //  POSITION PERSISTENCE
    // ═══════════════════════════════════════════════════════════
    function loadPositions() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch (_) { return {}; }
    }
    function savePositions(pos) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(pos)); } catch (_) {}
    }
    function savePanel(key, panel) {
        if (!panel || restoring) return;
        const x = parseInt(panel.style.left), y = parseInt(panel.style.top);
        if (isNaN(x) || isNaN(y)) return;
        const pos = loadPositions();
        if (pos[key]?.x === x && pos[key]?.y === y) return;
        pos[key] = { x, y };
        savePositions(pos);
    }
    function restorePanel(key, panel) {
        const pos = loadPositions();
        if (!pos[key]) return false;
        restoring = true;
        panel.style.left = pos[key].x + 'px';
        panel.style.top = pos[key].y + 'px';
        const m = (panel.style.transform || '').match(/scale\([^)]+\)/);
        panel.style.transform = m ? m[0] : 'none';
        panel.dataset.dragged = '1';
        restoring = false;
        return true;
    }

    // ═══════════════════════════════════════════════════════════
    //  Z-INDEX
    // ═══════════════════════════════════════════════════════════
    function bringToFront(panel) {
        if (!panel) return;
        topZ++;
        panel.style.zIndex = topZ;
    }

    // ═══════════════════════════════════════════════════════════
    //  HELPERS
    // ═══════════════════════════════════════════════════════════
    function findEntry(el) {
        for (const p of panels.values()) {
            if (p.el === el || el.matches?.(p.sel)) return p;
        }
        return null;
    }
    function getVisiblePanels() {
        const out = [];
        for (const p of panels.values()) {
            const el = p.el || document.querySelector(p.sel);
            if (el && isPanelVisible(el)) {
                p.el = el; // keep ref fresh
                out.push({ ...p, el });
            }
        }
        return out;
    }
    function isPanelVisible(el) {
        return el.classList.contains('visible') || el.style.display === 'flex' || el.style.display === 'block';
    }
    function vRect(el) { return el.getBoundingClientRect(); }

    function edgesTouching(ar, br) {
        const hOverlap = ar.left < br.right + STICK_DIST && ar.right > br.left - STICK_DIST;
        const vOverlap = ar.top < br.bottom + STICK_DIST && ar.bottom > br.top - STICK_DIST;
        if (hOverlap) {
            if (Math.abs(ar.top - br.bottom) <= STICK_DIST) return true;
            if (Math.abs(ar.bottom - br.top) <= STICK_DIST) return true;
        }
        if (vOverlap) {
            if (Math.abs(ar.left - br.right) <= STICK_DIST) return true;
            if (Math.abs(ar.right - br.left) <= STICK_DIST) return true;
        }
        return false;
    }

    function rectsOverlap(a, b) {
        return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    }

    // ═══════════════════════════════════════════════════════════
    //  SHADOW CLIPPING
    // ═══════════════════════════════════════════════════════════
    function updateShadowClips() {
        const visible = getVisiblePanels();
        for (const { el: a } of visible) {
            const ar = vRect(a);
            let clipT = false, clipR = false, clipB = false, clipL = false;

            for (const { el: b } of visible) {
                if (a === b) continue;
                // Only clip between parent-child pairs (direct relationship)
                const related = childOf.get(a) === b || childOf.get(b) === a;
                if (!related) continue;

                const br = vRect(b);
                const hOverlap = ar.left < br.right + STICK_DIST && ar.right > br.left - STICK_DIST;
                const vOverlap = ar.top < br.bottom + STICK_DIST && ar.bottom > br.top - STICK_DIST;
                if (hOverlap) {
                    if (Math.abs(ar.top - br.bottom) <= STICK_DIST) clipT = true;
                    if (Math.abs(ar.bottom - br.top) <= STICK_DIST) clipB = true;
                }
                if (vOverlap) {
                    if (Math.abs(ar.left - br.right) <= STICK_DIST) clipL = true;
                    if (Math.abs(ar.right - br.left) <= STICK_DIST) clipR = true;
                }
            }

            if (clipT || clipR || clipB || clipL) {
                const clip = `inset(${clipT?'0px':`-${SHADOW_PAD}px`} ${clipR?'0px':`-${SHADOW_PAD}px`} ${clipB?'0px':`-${SHADOW_PAD}px`} ${clipL?'0px':`-${SHADOW_PAD}px`})`;
                if (a.style.clipPath !== clip) a.style.clipPath = clip;
            } else {
                if (a.style.clipPath) a.style.clipPath = '';
            }
        }
        for (const p of panels.values()) {
            const el = p.el || document.querySelector(p.sel);
            if (el && !isPanelVisible(el) && el.style.clipPath) el.style.clipPath = '';
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  EDGE SNAPPING (single panel against others + screen)
    // ═══════════════════════════════════════════════════════════
    function calcSnap(panelRects, otherRects) {
        let snapDX = null, snapDY = null;
        let bestDX = SNAP_DIST + 1, bestDY = SNAP_DIST + 1;
        function tryX(d) { if (Math.abs(d) < bestDX) { bestDX = Math.abs(d); snapDX = d; } }
        function tryY(d) { if (Math.abs(d) < bestDY) { bestDY = Math.abs(d); snapDY = d; } }

        // Group bounding box
        let gL = Infinity, gT = Infinity, gR = -Infinity, gB = -Infinity;
        for (const r of panelRects) {
            gL = Math.min(gL, r.left); gT = Math.min(gT, r.top);
            gR = Math.max(gR, r.right); gB = Math.max(gB, r.bottom);
        }

        // Screen edges
        const deskbar = document.querySelector('#deepos-deskbar');
        const barH = deskbar ? deskbar.offsetHeight : 0;
        tryX(0 - gL); tryX(window.innerWidth - gR);
        tryY(barH - gT); tryY(window.innerHeight - gB);

        // Panel-to-panel
        for (const r of panelRects) {
            for (const o of otherRects) {
                const hNear = r.left < o.right + SNAP_DIST && r.right > o.left - SNAP_DIST;
                const vNear = r.top < o.bottom + SNAP_DIST && r.bottom > o.top - SNAP_DIST;
                if (hNear || Math.abs(r.top - o.top) < SNAP_DIST || Math.abs(r.bottom - o.bottom) < SNAP_DIST) {
                    tryX(o.right - r.left); tryX(o.left - r.right);
                    tryX(o.left - r.left); tryX(o.right - r.right);
                }
                if (vNear || Math.abs(r.left - o.left) < SNAP_DIST || Math.abs(r.right - o.right) < SNAP_DIST) {
                    tryY(o.bottom - r.top); tryY(o.top - r.bottom);
                    tryY(o.top - r.top); tryY(o.bottom - r.bottom);
                }
            }
        }

        const dx = snapDX ?? 0, dy = snapDY ?? 0;
        // Reject if causes overlap
        if (dx !== 0 || dy !== 0) {
            for (const r of panelRects) {
                const shifted = { left: r.left+dx, top: r.top+dy, right: r.right+dx, bottom: r.bottom+dy };
                for (const o of otherRects) { if (rectsOverlap(shifted, o)) return { dx: 0, dy: 0 }; }
            }
        }
        return { dx, dy };
    }

    // ═══════════════════════════════════════════════════════════
    //  DRAG HANDLER
    // ═══════════════════════════════════════════════════════════
    let drag = null;

    function findTitlebar(panelEl) {
        const entry = findEntry(panelEl);
        if (!entry) return null;
        // entry.tb is an element ref from registration; verify it's still in DOM
        if (entry.tb && panelEl.contains(entry.tb)) return entry.tb;
        // Re-detect
        const tb = findTitlebarEl(panelEl);
        if (tb) entry.tb = tb;
        return tb;
    }
    function isButton(target, panelEl) {
        const entry = findEntry(panelEl);
        if (!entry || !entry.btns) return false;
        return target.closest(entry.btns);
    }

    // Capture phase: intercept titlebar drags
    document.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        for (const { el } of getVisiblePanels()) {
            const tb = findTitlebar(el);
            if (!tb || !tb.contains(e.target)) continue;
            if (isButton(e.target, el)) continue;

            e.stopPropagation();
            e.preventDefault();
            bringToFront(el);

            const isCh = isChild(el);
            const movingSet = new Set([el]);

            // If this panel has any descendants, they all move with it
            for (const c of getDescendants(el)) movingSet.add(c);

            const startPositions = new Map();
            for (const g of movingSet) {
                startPositions.set(g, { x: parseInt(g.style.left) || 0, y: parseInt(g.style.top) || 0 });
            }

            drag = {
                panel: el,
                movingSet,
                startPositions,
                startMouse: { x: e.clientX, y: e.clientY },
                moved: false,
                wasChild: isCh,
            };
            return;
        }
    }, true);

    document.addEventListener('mousemove', (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.startMouse.x;
        const dy = e.clientY - drag.startMouse.y;
        if (!drag.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;

        // First move: detach child from its anchor
        if (!drag.moved && drag.wasChild) {
            detach(drag.panel);
        }
        drag.moved = true;

        // Move all panels in the set
        for (const [el, start] of drag.startPositions) {
            el.style.left = (start.x + dx) + 'px';
            el.style.top = (start.y + dy) + 'px';
            const m = (el.style.transform || '').match(/scale\([^)]+\)/);
            el.style.transform = m ? m[0] : 'none';
            el.dataset.dragged = '1';
        }

        // Snap against non-moving panels and screen edges
        const movingRects = [...drag.movingSet].map(vRect);
        const otherRects = getVisiblePanels()
            .filter(p => !drag.movingSet.has(p.el))
            .map(p => vRect(p.el));
        const snap = calcSnap(movingRects, otherRects);
        if (snap.dx !== 0 || snap.dy !== 0) {
            for (const [el, start] of drag.startPositions) {
                el.style.left = (start.x + dx + snap.dx) + 'px';
                el.style.top = (start.y + dy + snap.dy) + 'px';
            }
        }

        updateShadowClips();
    });

    document.addEventListener('mouseup', () => {
        if (!drag) return;

        if (drag.moved) {
            // Save positions
            for (const el of drag.movingSet) {
                const entry = findEntry(el);
                if (entry) savePanel(entry.key, el);
            }

            const panel = drag.panel;

            // If panel is not currently a child, try to attach it to something it's touching
            if (!isChild(panel)) {
                const panelRect = vRect(panel);
                for (const { el: other } of getVisiblePanels()) {
                    if (other === panel || drag.movingSet.has(other)) continue;
                    if (edgesTouching(panelRect, vRect(other))) {
                        attach(panel, other);
                        break;
                    }
                }
            }

            // Check if any non-moving panels are now touching any panel in our group
            // and should attach
            for (const { el: other } of getVisiblePanels()) {
                if (drag.movingSet.has(other)) continue;
                if (isChild(other)) continue; // already attached to something
                for (const el of drag.movingSet) {
                    if (edgesTouching(vRect(other), vRect(el))) {
                        attach(other, el);
                        break;
                    }
                }
            }
        }

        drag = null;
        updateShadowClips();
    });

    // ═══════════════════════════════════════════════════════════
    //  CLICK TO FRONT
    // ═══════════════════════════════════════════════════════════
    document.addEventListener('mousedown', (e) => {
        for (const { el } of getVisiblePanels()) {
            if (el.contains(e.target)) { bringToFront(el); return; }
        }
    }, false);

    // ═══════════════════════════════════════════════════════════
    //  VISIBILITY: RESTORE + Z-INDEX ON OPEN
    // ═══════════════════════════════════════════════════════════
    const wasVisible = new Map();

    function checkVisibility() {
        for (const [key, p] of panels) {
            const el = p.el || document.querySelector(p.sel);
            if (!el) continue;
            p.el = el;
            const vis = isPanelVisible(el);
            const prev = wasVisible.get(key) || false;

            if (vis && !prev) {
                bringToFront(el);
                const hasPos = loadPositions()[key];
                if (hasPos) {
                    el.style.visibility = 'hidden';
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            restorePanel(key, el);
                            el.style.visibility = '';
                            // Re-establish anchor relationships after restore
                            rebuildAnchors();
                            updateShadowClips();
                        });
                    });
                } else {
                    requestAnimationFrame(() => updateShadowClips());
                }
            } else if (!vis && prev) {
                savePanel(key, el);
                // Clean up anchor relationships
                detach(el);
                detachAll(el);
                updateShadowClips();
            }
            wasVisible.set(key, vis);
        }
    }

    // Rebuild anchor relationships from current positions
    function rebuildAnchors() {
        anchorChildren.clear();
        childOf.clear();
        snapEdge.clear();

        const visible = getVisiblePanels();
        // Multiple passes to build chains: each pass attaches unattached panels
        // to any touching panel. Repeat until no new attachments form.
        let changed = true;
        while (changed) {
            changed = false;
            for (let i = 0; i < visible.length; i++) {
                const a = visible[i];
                if (isChild(a.el)) continue; // already attached
                for (let j = 0; j < visible.length; j++) {
                    if (i === j) continue;
                    const b = visible[j];
                    if (a.el === b.el) continue;
                    if (edgesTouching(vRect(a.el), vRect(b.el))) {
                        // Try to attach a to b (b becomes parent)
                        if (!isChild(a.el) && !wouldCycle(a.el, b.el)) {
                            attach(a.el, b.el);
                            changed = true;
                            break; // a is now attached, move to next unattached
                        }
                    }
                }
            }
        }
    }

    const visObserver = new MutationObserver(() => { if (!restoring) checkVisibility(); });

    function observePanels() {
        discoverPanels();
        for (const [key, p] of panels) {
            const el = p.el || document.querySelector(p.sel);
            if (el && !el.dataset.dnWmObserved) {
                p.el = el;
                visObserver.observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
                resizeObserver.observe(el);
                el.dataset.dnWmObserved = '1';
                wasVisible.set(key, isPanelVisible(el));
            }
        }
    }

    setInterval(observePanels, 2000);
    new MutationObserver(observePanels).observe(document.body, { childList: true });

    // ═══════════════════════════════════════════════════════════
    //  CURSOR FIX
    // ═══════════════════════════════════════════════════════════
    function boostCursor() {
        const el = document.getElementById('cursor');
        if (!el) { setTimeout(boostCursor, 500); return; }
        const style = document.createElement('style');
        style.textContent = '#cursor{left:0px!important;top:0px!important;will-change:transform!important;transition:none!important;animation:none!important;pointer-events:none!important;}';
        document.head.appendChild(style);
        let lastX = 0, lastY = 0, raf = false;
        document.addEventListener('mousemove', (e) => {
            lastX = e.clientX; lastY = e.clientY;
            if (!raf) { raf = true; requestAnimationFrame(() => { el.style.transform = `translate3d(${lastX}px,${lastY}px,0)`; raf = false; }); }
        }, { capture: true, passive: true });
        let resetting = false;
        new MutationObserver(() => {
            if (resetting) return;
            if (el.style.left !== '0px' || el.style.top !== '0px') { resetting = true; el.style.left = '0px'; el.style.top = '0px'; resetting = false; }
        }).observe(el, { attributes: true, attributeFilter: ['style'] });
    }
    setTimeout(boostCursor, 1000);

    // ═══════════════════════════════════════════════════════════
    //  TERMINAL FOCUS
    // ═══════════════════════════════════════════════════════════
    function isTerminalActive() {
        const dos = window._DOS;
        if (dos && dos.active) {
            if (dos.terminalMinimized) return false;
            if (dos.foregroundApp) return false;
            const termWin = document.getElementById('deepos-win-terminal');
            if (!termWin || !termWin.classList.contains('visible')) return false;
            return true;
        }
        const prompt = document.querySelector('#prompt');
        return prompt && prompt.textContent.includes('@');
    }
    function isAnyOverlayOpen() {
        const overlays = document.querySelectorAll('[id*="overlay"]');
        for (const el of overlays) {
            if (el.id === 'deepos-win-terminal') continue;
            if (el.style.display === 'none') continue;
            if (el.offsetWidth === 0 && el.offsetHeight === 0) continue;
            const pos = getComputedStyle(el).position;
            if (pos === 'fixed' || pos === 'absolute') return true;
        }
        if (document.querySelector('.dn-select-popup')) return true;
        if (typeof SelectPopup !== 'undefined' && SelectPopup.isOpen && SelectPopup.isOpen()) return true;
        if (typeof MinigameEngine !== 'undefined' && MinigameEngine.isRunning && MinigameEngine.isRunning()) return true;
        if (typeof activeCancelableCommand !== 'undefined' && activeCancelableCommand) return true;
        return false;
    }
    function isInputBusy() {
        if (typeof commandBusy !== 'undefined' && commandBusy) return true;
        if (typeof inputCapture !== 'undefined' && inputCapture) return true;
        return false;
    }
    function isScriptPanel(target) {
        if (!target?.closest) return false;
        for (const p of panels.values()) {
            if (target.closest(p.sel)) return true;
        }
        return target.closest('.dn-select-popup, .dntw-slot-menu');
    }
    function shouldRefocus() {
        if (!isTerminalActive()) return false;
        if (isAnyOverlayOpen()) return false;
        if (isInputBusy()) return false;
        if (isScriptPanel(document.activeElement)) return false;
        const sel = window.getSelection();
        if (sel && sel.toString().length > 0) return false;
        return true;
    }
    document.addEventListener('click', (e) => {
        if (e.target.closest('button, a, select, input, textarea, [contenteditable]')) return;
        if (isScriptPanel(e.target)) return;
        if (!e.target.closest('#terminal, #output, #deepos-desktop, #deepos-win-terminal')) return;
        setTimeout(() => {
            if (shouldRefocus()) {
                const input = document.getElementById('cmd-input');
                if (input) input.focus({ preventScroll: true });
            }
        }, 50);
    });

    console.log('[WM] v4.0 — Auto-discovery + anchor snap + position persistence + terminal focus');
})();
