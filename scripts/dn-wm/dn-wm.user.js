// ==UserScript==
// @name         DeepNet Script Window Manager
// @namespace    https://macinsight.github.io/deepwiki/modding/
// @version      5.0.3
// @description  Window framework: panel lifecycle, shared API, z-stacking, anchor snapping, position persistence, terminal focus
// @author       Rain
// @match        https://deepnet.us/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════════════
    //  SHARED STATE
    // ═══════════════════════════════════════════════════════════
    const panels = new Map(); // key → { sel, key, tb, btns, el }
    const STORAGE_KEY = 'dn-wm-positions';
    const SCALE_KEY = 'dn-wm-scale';
    const SNAP_DIST = 14;
    const STICK_DIST = 6;
    const SHADOW_PAD = 20;
    const BASE_Z = 6000;
    const ICON_POS_KEY = 'deepos_icon_positions';
    let topZ = BASE_Z;
    let restoring = false;

    // ═══════════════════════════════════════════════════════════
    //  CORE HELPERS (used by both API and layout engine)
    // ═══════════════════════════════════════════════════════════
    function isPanelVisible(el) {
        return el && (el.classList.contains('visible') || el.style.display === 'flex' || el.style.display === 'block');
    }
    function findEntry(el) {
        for (const p of panels.values()) { if (p.el === el || el.matches?.(p.sel)) return p; }
        return null;
    }
    function getVisiblePanels() {
        const out = [];
        for (const p of panels.values()) {
            const el = p.el || document.querySelector(p.sel);
            if (el && isPanelVisible(el)) { p.el = el; out.push({ ...p, el }); }
        }
        return out;
    }
    function vRect(el) { return el.getBoundingClientRect(); }
    function bringToFront(panel) { if (panel) { topZ++; panel.style.zIndex = topZ; } }

    // ─── Position persistence ───
    function loadPositions() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch (_) { return {}; } }
    function savePositions(pos) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(pos)); } catch (_) {} }
    function savePanel(key, panel) {
        if (!panel || restoring) return;
        const x = parseInt(panel.style.left), y = parseInt(panel.style.top);
        if (isNaN(x) || isNaN(y)) return;
        const pos = loadPositions();
        if (pos[key]?.x === x && pos[key]?.y === y) return;
        pos[key] = { x, y }; savePositions(pos);
    }
    function restorePanel(key, panel) {
        const pos = loadPositions();
        if (!pos[key]) return false;
        restoring = true;
        panel.style.left = pos[key].x + 'px'; panel.style.top = pos[key].y + 'px';
        panel.style.transform = `scale(${getScale()})`;
        panel.dataset.dragged = '1';
        restoring = false;
        return true;
    }

    // ═══════════════════════════════════════════════════════════
    //  SHARED STYLES
    // ═══════════════════════════════════════════════════════════
    function injectSharedStyles() {
        const s = document.createElement('style'); s.id = 'dn-wm-styles';
        s.textContent = `
/* Panel shell */
.dn-panel{display:none;position:fixed;z-index:6000;flex-direction:column;font-family:var(--dos-font,Consolas,"Courier New",monospace);font-size:var(--dos-font-sm,12px);color:var(--dos-text,#b3b3b3);background:var(--dos-bg-window,#0a0a0a);border:1px solid var(--dos-border,#222);box-shadow:4px 4px 12px var(--dos-shadow,rgba(0,0,0,0.6));cursor:default;transform-origin:top left;max-height:85vh;overflow:hidden}
.dn-panel.visible{display:flex}
/* Titlebar */
.dn-titlebar{display:flex;align-items:center;padding:0 8px;height:26px;background:var(--dos-tab-bg,#1a1a1a);border-bottom:1px solid var(--dos-border,#222);flex-shrink:0;gap:6px}
.dn-title{font-size:11px;font-weight:normal;letter-spacing:.06em;text-transform:uppercase;color:var(--dos-text-label,#a3a3a3);flex:1}
.dn-hdr-btn{width:14px;height:14px;background:var(--dos-border,#222);border:1px solid var(--dos-border-hi,#333);display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--dos-text-dim,#7a7a7a);line-height:1;flex-shrink:0}
.dn-hdr-btn:hover{background:var(--dos-bg-hover);border-color:var(--dos-border-hi);color:var(--dos-text-hi)}
.dn-hdr-btn.close:hover{background:var(--dos-close-bg);border-color:var(--dos-close-border)}
/* Body */
.dn-body{flex:1;min-height:0;overflow-y:auto;padding:10px 12px;scrollbar-width:thin;scrollbar-color:var(--dos-border-hi) var(--dos-bg)}
.dn-body::-webkit-scrollbar{width:4px}.dn-body::-webkit-scrollbar-track{background:var(--dos-bg)}.dn-body::-webkit-scrollbar-thumb{background:var(--dos-border-hi)}
/* Buttons */
.dn-btn{flex:1;padding:5px 0;text-align:center;font-family:inherit;font-size:11px;font-weight:normal;letter-spacing:.06em;text-transform:uppercase;border:1px solid var(--dos-border,#222);background:var(--dos-bg-panel,#1a1a1a);color:var(--dos-text-label,#a3a3a3);transition:background .15s,color .15s}
.dn-btn:hover{background:var(--dos-bg-hover);color:var(--dos-text-hi);border-color:var(--dos-border-hi)}
.dn-btn:disabled{opacity:.4;pointer-events:none}
.dn-btn.danger:hover{background:var(--dos-close-bg);border-color:var(--dos-close-border)}
.dn-btn.active{background:var(--dos-bg-selected);color:var(--dos-accent-hi,#999);border-color:var(--dos-accent,#666)}
.dn-btn.sell{color:#3ddc84;border-color:#335533}.dn-btn.sell:hover{background:rgba(16,40,16,.5);border-color:#448844}
/* Log */
.dn-log{border:1px solid var(--dos-border-lo);background:var(--dos-bg,#0c0c0c);max-height:80px;overflow-y:auto;font-size:10px;padding:4px 6px}
.dn-log-line{color:var(--dos-text-dim);line-height:1.5}
.dn-log-ts{color:var(--dos-text-xdim);margin-right:6px}
/* Sections */
.dn-sec{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--dos-text-xdim,#696969);margin:10px 0 6px 0}
.dn-sec:first-child{margin-top:0}
/* Key-value rows */
.dn-row{display:flex;justify-content:space-between;align-items:center;padding:2px 0;font-size:11px}
.dn-k{color:var(--dos-text-dim)}.dn-v{color:var(--dos-text);text-align:right}
/* Loading */
.dn-loading{padding:20px;text-align:center;color:var(--dos-text-xdim);font-style:italic}
/* Status */
.dn-status{font-size:11px;letter-spacing:.04em}
.dn-s-idle{color:var(--dos-text-dim)}.dn-s-working{color:var(--dos-flag-active,#884444)}.dn-s-ready{color:#5a8f5a}.dn-s-error{color:#8f4a4a}
/* Info bar */
.dn-info{display:flex;align-items:center;justify-content:space-between;padding:6px 8px;background:var(--dos-bg-panel,#1a1a1a);border:1px solid var(--dos-border-lo,#1a1a1a)}
/* List */
.dn-list{border:1px solid var(--dos-border-lo,#1a1a1a);background:var(--dos-bg-panel,#1a1a1a);max-height:180px;overflow-y:auto}
.dn-list-empty{padding:8px;text-align:center;color:var(--dos-text-xdim,#696969);font-style:italic;font-size:11px}
/* Tabs */
.dn-tabs{display:flex;border-bottom:1px solid var(--dos-border-lo,#1a1a1a);flex-shrink:0}
.dn-tab{flex:1;padding:5px 0;text-align:center;font-family:inherit;font-size:10px;font-weight:normal;letter-spacing:.06em;text-transform:uppercase;border:none;border-right:1px solid var(--dos-border-lo,#1a1a1a);background:var(--dos-bg,#0c0c0c);color:var(--dos-text-xdim,#696969);transition:background .15s,color .15s}
.dn-tab:last-child{border-right:none}.dn-tab:hover{background:var(--dos-bg-hover);color:var(--dos-text)}.dn-tab.active{background:var(--dos-bg-panel,#1a1a1a);color:var(--dos-accent-hi,#999);border-bottom:1px solid var(--dos-accent,#666)}
/* Scale controls */
.dn-scale-row{display:flex;align-items:center;gap:4px}
.dn-scale-btn{width:22px;height:22px;background:var(--dos-bg-panel);border:1px solid var(--dos-border);color:var(--dos-text-label);font-size:13px;font-family:inherit;display:flex;align-items:center;justify-content:center}
.dn-scale-btn:hover{border-color:var(--dos-border-hi);color:var(--dos-text-hi);background:var(--dos-bg-hover)}
.dn-scale-label{font-size:11px;color:var(--dos-text);min-width:90px;text-align:center}
/* Checkbox */
.dn-chk{width:16px;height:16px;flex-shrink:0;background:var(--dos-bg-input,#1e1e1e);border:1px solid var(--dos-border,#222);display:flex;align-items:center;justify-content:center;font-size:11px;color:#3ddc84}
.dn-chk:hover{border-color:var(--dos-border-hi)}
/* CLI button base */
.dn-cli-btn{display:none;min-width:18px;padding:1px 5px;text-align:center;font-weight:bold;font-size:13px;font-family:inherit;color:#9cf7f7;border:1px solid #4a8f8f;background:rgba(12,42,42,.65);cursor:pointer;letter-spacing:.5px;white-space:nowrap}
.dn-cli-btn:hover{background:rgba(20,60,60,.8);border-color:#6abfbf;color:#bfffff}
`;
        document.head.appendChild(s);
    }

    // ═══════════════════════════════════════════════════════════
    //  CREDENTIAL SNIFFER + SHARED API
    // ═══════════════════════════════════════════════════════════
    let machineId = null, token = null;
    const _origFetch = window.fetch;
    (function installSniffer() {
        const orig = _origFetch;
        window.fetch = function (...args) {
            try {
                const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
                if ((url?.includes('api.php') || url?.includes('/api?')) && args[1]?.body) {
                    const b = JSON.parse(args[1].body);
                    if (b.machine_id) machineId = b.machine_id;
                    if (b.token) token = b.token;
                }
            } catch (_) {}
            return orig.apply(this, args);
        };
    })();

    function reqId() {
        const buf = new Uint8Array(16); crypto.getRandomValues(buf);
        return [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    function getApiBase() {
        try {
            if (window.CONFIG?.API_BASE) return window.CONFIG.API_BASE;
            if (window.APP_CONFIG?.API_BASE) return window.APP_CONFIG.API_BASE;
        } catch (_) {}
        return 'api';
    }
    async function api(action, extra = {}) {
        if (!machineId || !token) return null;
        try {
            const r = await _origFetch(`https://deepnet.us/${getApiBase()}?action=${action}`, {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ machine_id: machineId, token, request_id: reqId(), ...extra }),
            });
            return JSON.parse((await r.text()).replace(/^\ufeff/, ''));
        } catch (e) { console.error(`[WM] API ${action}:`, e); return null; }
    }
    function isLoggedIn() {
        const p = document.querySelector('#prompt');
        return p && p.textContent.includes('@deepnet') && !p.textContent.includes('guest@deepnet');
    }

    // ═══════════════════════════════════════════════════════════
    //  SCALE
    // ═══════════════════════════════════════════════════════════
    function loadScale() { try { return Number(localStorage.getItem(SCALE_KEY)) || 0; } catch (_) { return 0; } }
    function saveScale(v) { try { localStorage.setItem(SCALE_KEY, String(v)); } catch (_) {} }
    let _scaleOverride = loadScale();

    function getScale() {
        if (_scaleOverride > 0) return _scaleOverride;
        return Math.max(1.0, Math.min(1.8, 0.55 + window.innerHeight / 1600));
    }
    function setScale(v) { _scaleOverride = v; saveScale(v); }

    function renderScaleControls(container, onUpdate) {
        const lbl = _scaleOverride === 0 ? `Auto (${Math.round(getScale() * 100)}%)` : `${Math.round(_scaleOverride * 100)}%`;
        const wrap = document.createElement('div');
        wrap.innerHTML = `
            <div class="dn-sec">UI Scale</div>
            <div class="dn-scale-row">
                <div class="dn-scale-btn" data-act="down">\u2212</div>
                <span class="dn-scale-label">${lbl}</span>
                <div class="dn-scale-btn" data-act="up">+</div>
                <div class="dn-scale-btn" data-act="auto" style="width:auto;padding:0 6px;${_scaleOverride===0?'color:var(--dos-accent-hi);border-color:var(--dos-accent)':''}">Auto</div>
            </div>`;
        container.appendChild(wrap);
        wrap.addEventListener('click', (e) => {
            const act = e.target.dataset.act;
            if (!act) return;
            if (act === 'down') setScale(Math.max(0.8, Math.round(((getScale()) - 0.1) * 10) / 10));
            else if (act === 'up') setScale(Math.min(2.0, Math.round(((getScale()) + 0.1) * 10) / 10));
            else if (act === 'auto') setScale(0);
            // Re-apply scale to all visible panels
            for (const p of panels.values()) {
                if (p.el && isPanelVisible(p.el)) {
                    if (p.el.dataset.dragged) p.el.style.transform = `scale(${getScale()})`;
                    else if (p._center) p._center();
                }
            }
            if (onUpdate) onUpdate();
        });
    }

    // ═══════════════════════════════════════════════════════════
    //  ICON HELPERS
    // ═══════════════════════════════════════════════════════════
    let _sawDeepOS = false;
    function isDeepOSPending() {
        const p = window._deeposBootPending || document.body.classList.contains('deepos-active') || (window._DOS && window._DOS.active);
        if (p) _sawDeepOS = true; return p || _sawDeepOS;
    }
    function loadIconPositions() { try { return JSON.parse(localStorage.getItem(ICON_POS_KEY)) || {}; } catch (_) { return {}; } }
    function saveIconPositions() {
        const p = {}; document.querySelectorAll('#deepos-icons .deepos-icon').forEach(i => {
            const id = i.dataset.app || i.dataset.intApp || i.dataset.sysApp;
            if (id && i.style.left) p[id] = { x: parseInt(i.style.left) || 0, y: parseInt(i.style.top) || 0 };
        }); try { localStorage.setItem(ICON_POS_KEY, JSON.stringify(p)); } catch (_) {}
    }
    function calcIconSlot(idx) {
        const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16, vw = window.innerWidth / 100;
        const w = Math.min(6 * rem, Math.max(3.8 * rem, 5.2 * vw)), gh = Math.min(3.7 * rem, Math.max(2.1 * rem, 3.3 * vw));
        const ch = gh + 2.4 * rem, mr = Math.max(1, Math.floor((window.innerHeight - 40) / ch));
        return { x: 0.3 * rem + Math.floor(idx / mr) * w, y: 0.3 * rem + (idx % mr) * ch };
    }
    function applyIconPos(icon, id) {
        const s = loadIconPositions(); icon.style.position = 'absolute';
        if (s[id]) { icon.style.left = s[id].x + 'px'; icon.style.top = s[id].y + 'px'; }
        else { const p = calcIconSlot(document.querySelectorAll('#deepos-icons .deepos-icon').length); icon.style.left = p.x + 'px'; icon.style.top = p.y + 'px'; }
    }
    function makeIconDraggable(icon) {
        let ox = 0, oy = 0, d = false, m = false, w = false;
        icon.addEventListener('mousedown', e => { if (e.button) return; d = true; m = false; ox = e.clientX - (parseInt(icon.style.left) || 0); oy = e.clientY - (parseInt(icon.style.top) || 0); e.preventDefault(); });
        document.addEventListener('mousemove', e => { if (!d) return; if (!m && Math.abs(e.clientX - (ox + parseInt(icon.style.left || 0))) < 3 && Math.abs(e.clientY - (oy + parseInt(icon.style.top || 0))) < 3) return; m = true; const p = icon.parentElement.getBoundingClientRect(); icon.style.left = Math.max(0, Math.min(e.clientX - ox, p.width - icon.offsetWidth)) + 'px'; icon.style.top = Math.max(0, Math.min(e.clientY - oy, p.height - icon.offsetHeight)) + 'px'; });
        document.addEventListener('mouseup', () => { if (!d) return; if (m) { saveIconPositions(); w = true; setTimeout(() => { w = false; }, 400); } d = false; m = false; });
        return () => w;
    }

    // ═══════════════════════════════════════════════════════════
    //  createPanel() — builds panel shell, returns handle
    // ═══════════════════════════════════════════════════════════
    function createPanel(opts) {
        const key = opts.id;
        const panelId = key + '-panel';

        const el = document.createElement('div');
        el.id = panelId;
        el.className = 'dn-panel';
        el.style.width = (opts.width || 420) + 'px';

        // Titlebar
        const tb = document.createElement('div');
        tb.className = 'dn-titlebar';
        const titleSpan = document.createElement('span');
        titleSpan.className = 'dn-title';
        titleSpan.textContent = opts.title || key;
        tb.appendChild(titleSpan);

        let gearBtn = null;
        if (opts.settings !== false && (opts.onSettings || opts.settings)) {
            gearBtn = document.createElement('div');
            gearBtn.className = 'dn-hdr-btn';
            gearBtn.title = 'Settings';
            gearBtn.textContent = '\u2699';
            tb.appendChild(gearBtn);
        }

        const closeBtn = document.createElement('div');
        closeBtn.className = 'dn-hdr-btn close';
        closeBtn.textContent = '\u00D7';
        tb.appendChild(closeBtn);

        // Body
        const body = document.createElement('div');
        body.className = 'dn-body';
        body.id = key + '-body';

        el.appendChild(tb);
        el.appendChild(body);
        document.body.appendChild(el);

        // Register with WM
        const entry = { sel: '#' + panelId, key, tb, btns: '.dn-hdr-btn', el };
        panels.set(key, entry);

        // Set up observers
        visObserver.observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
        resizeObserver.observe(el);
        el.dataset.dnWmObserved = '1';

        let _view = 'main';

        function centerThis() {
            const s = getScale();
            const pw = (opts.width || 420) * s;
            const ph = (el.offsetHeight || 300) * s;
            el.style.left = Math.max(0, (window.innerWidth - pw) / 2) + 'px';
            el.style.top = Math.max(0, (window.innerHeight - ph) / 2) + 'px';
            el.style.transform = `scale(${s})`;
            delete el.dataset.dragged;
        }
        entry._center = centerThis;

        const handle = {
            el,
            body,
            titlebar: tb,
            show() {
                el.classList.add('visible');
                bringToFront(el);
                const hasPos = loadPositions()[key];
                if (hasPos) {
                    restorePanel(key, el);
                } else {
                    requestAnimationFrame(centerThis);
                }
                _view = 'main';
                if (gearBtn) gearBtn.style.color = '';
                if (opts.onMain) opts.onMain(body);
                if (opts.onShow) opts.onShow();
            },
            hide() {
                savePanel(key, el);
                el.classList.remove('visible');
                if (opts.onHide) opts.onHide();
            },
            toggle() { isPanelVisible(el) ? handle.hide() : handle.show(); },
            setView(view) {
                _view = view;
                if (gearBtn) gearBtn.style.color = view === 'settings' ? 'var(--dos-accent-hi)' : '';
                if (view === 'main' && opts.onMain) opts.onMain(body);
                else if (view === 'settings' && opts.onSettings) opts.onSettings(body);
            },
            getView() { return _view; },
            refresh() { if (_view === 'main' && opts.onMain) opts.onMain(body); },
        };

        closeBtn.addEventListener('click', () => handle.hide());
        if (gearBtn) {
            gearBtn.addEventListener('click', () => {
                handle.setView(_view === 'settings' ? 'main' : 'settings');
            });
        }

        return handle;
    }

    // ═══════════════════════════════════════════════════════════
    //  placeUI() — desktop icon + CLI btn
    // ═══════════════════════════════════════════════════════════
    function placeUI(opts) {
        let placed = false, cliBtnEl = null;

        function tryPlace() {
            if (placed) return true;
            const icons = document.querySelector('#deepos-icons');
            if (icons && opts.icon) {
                const icon = document.createElement('div');
                icon.className = 'deepos-icon';
                icon.dataset.app = opts.key;
                icon.innerHTML = `<div class="deepos-icon-gfx" style="background:var(--dos-icon-bg);color:var(--dos-icon-color);font-size:clamp(0.5rem,0.85vw,1rem);font-weight:bold;letter-spacing:.03em">${opts.icon.glyph}</div><span>${opts.icon.label}</span>`;
                applyIconPos(icon, opts.key);
                const chk = makeIconDraggable(icon);
                icon.addEventListener('dblclick', () => { if (!chk() && opts.onOpen) opts.onOpen(); });
                icons.appendChild(icon);
                placed = true;
                return true;
            }
            if (isDeepOSPending()) return false;
            if (opts.cliBtn) {
                cliBtnEl = document.createElement('span');
                cliBtnEl.id = opts.key + '-cli-btn';
                cliBtnEl.className = 'dn-cli-btn';
                cliBtnEl.textContent = opts.cliBtn.text || opts.key.toUpperCase();
                cliBtnEl.title = opts.cliBtn.title || '';
                if (opts.cliBtn.style) Object.assign(cliBtnEl.style, opts.cliBtn.style);
                cliBtnEl.addEventListener('click', () => { if (opts.onOpen) opts.onOpen(); });
                const sr = document.querySelector('#status-right'), sb = document.querySelector('#statusbar');
                if (sr && sb) sb.insertBefore(cliBtnEl, sr);
                else if (sb) sb.appendChild(cliBtnEl);
                else return false;
                placed = true;
                return true;
            }
            return false;
        }

        return { tryPlace, isPlaced: () => placed, showCliBtn() { if (cliBtnEl) cliBtnEl.style.display = 'inline-block'; } };
    }

    // ═══════════════════════════════════════════════════════════
    //  onReady() — fires when logged in + WM available
    // ═══════════════════════════════════════════════════════════
    const _readyCallbacks = [];
    let _ready = false;
    function onReady(fn) {
        if (_ready) { setTimeout(fn, 0); return; }
        _readyCallbacks.push(fn);
    }
    function _fireReady() {
        if (_ready) return;
        _ready = true;
        for (const fn of _readyCallbacks) { try { fn(); } catch (e) { console.error('[WM] onReady error:', e); } }
        _readyCallbacks.length = 0;
        window.dispatchEvent(new CustomEvent('dn-wm-ready'));
    }

    // ═══════════════════════════════════════════════════════════
    //  PUBLIC API
    // ═══════════════════════════════════════════════════════════
    window.DN = window.DN || {};
    window.DN.wm = {
        createPanel,
        placeUI,
        api,
        isLoggedIn,
        getScale,
        setScale,
        renderScaleControls,
        onReady,
    };

    // ═══════════════════════════════════════════════════════════
    //  AUTO-DISCOVERY (fallback for non-API panels)
    // ═══════════════════════════════════════════════════════════
    function deriveKey(el) { return (el.id || '').replace(/-panel$/i, '') || el.id; }
    function findTitlebarEl(el) {
        for (const child of el.children) { if (child.className && /\b\S+-titlebar\b/.test(child.className)) return child; }
        for (const child of el.children) { if (child.id && /titlebar/i.test(child.id)) return child; }
        const first = el.firstElementChild;
        if (first && first.offsetHeight > 0 && first.offsetHeight < 40) return first;
        return null;
    }
    function findBtnSelector(el) {
        const btn = el.querySelector('[class*="-hdr-btn"], [class*="-win-btn"]');
        if (btn) { const m = btn.className.match(/\b(\S+(?:-hdr-btn|-win-btn)\S*)\b/); if (m) return '.' + m[1].split(' ')[0]; }
        return null;
    }
    function isUserscriptPanel(el) {
        if (!el || !el.id || !el.id.endsWith('-panel')) return false;
        if (panels.has(deriveKey(el))) return false;
        const cs = window.getComputedStyle(el);
        if (cs.position !== 'fixed') return false;
        if (!findTitlebarEl(el)) return false;
        if (el.classList.contains('deepos-window')) return false;
        return true;
    }
    function registerPanel(el) {
        const key = deriveKey(el);
        if (panels.has(key)) return panels.get(key);
        const tbEl = findTitlebarEl(el);
        const entry = { sel: '#' + el.id, key, tb: tbEl, btns: findBtnSelector(el), el };
        panels.set(key, entry);
        console.log(`[WM] discovered panel: #${el.id} (key=${key})`);
        return entry;
    }
    function discoverPanels() {
        document.querySelectorAll('[id$="-panel"]').forEach(el => {
            if (isUserscriptPanel(el)) registerPanel(el);
        });
    }

    // ═══════════════════════════════════════════════════════════
    //  ANCHOR SYSTEM
    // ═══════════════════════════════════════════════════════════
    const anchorChildren = new Map();
    const childOf = new Map();
    const snapEdge = new Map();

    function hasChildren(el) { return anchorChildren.has(el) && anchorChildren.get(el).size > 0; }
    function isChild(el) { return childOf.has(el); }
    function getRootAnchor(el) { let c = el; while (childOf.has(c)) c = childOf.get(c); return c; }
    function getDescendants(el) {
        const r = new Set(), q = [el];
        while (q.length) { const c = q.shift(); const k = anchorChildren.get(c); if (k) for (const x of k) { if (!r.has(x)) { r.add(x); q.push(x); } } }
        return r;
    }
    function wouldCycle(child, parent) { let c = parent; while (c) { if (c === child) return true; c = childOf.get(c); } return false; }
    function detectEdge(cr, ar) {
        const gaps = [{ side:'right',gap:Math.abs(cr.left-ar.right)},{side:'left',gap:Math.abs(cr.right-ar.left)},{side:'bottom',gap:Math.abs(cr.top-ar.bottom)},{side:'top',gap:Math.abs(cr.bottom-ar.top)}];
        const best = gaps.reduce((a,b)=>a.gap<b.gap?a:b);
        return { side: best.side, offset: (best.side==='right'||best.side==='left') ? cr.top-ar.top : cr.left-ar.left };
    }
    function attach(child, parent) {
        if (child===parent||isChild(child)||wouldCycle(child,parent)) return;
        if (!anchorChildren.has(parent)) anchorChildren.set(parent, new Set());
        anchorChildren.get(parent).add(child); childOf.set(child,parent); snapEdge.set(child,detectEdge(vRect(child),vRect(parent)));
    }
    function detach(child) {
        const parent = childOf.get(child); if (!parent) return;
        childOf.delete(child); snapEdge.delete(child);
        const k = anchorChildren.get(parent); if (k) { k.delete(child); if (!k.size) anchorChildren.delete(parent); }
    }
    function detachAll(el) {
        detach(el); const d = getDescendants(el);
        for (const c of d) { childOf.delete(c); snapEdge.delete(c); }
        anchorChildren.delete(el); for (const c of d) anchorChildren.delete(c);
    }
    // Remove a closing panel from the tree, promoting its direct children
    // to its parent (or to root if none). Preserves the rest of the subtree.
    function promoteAndRemove(el) {
        const parent = childOf.get(el) || null;
        const kids = anchorChildren.get(el);
        if (kids && kids.size > 0) {
            for (const child of kids) {
                // Detach child from closing panel
                childOf.delete(child);
                snapEdge.delete(child);
                // Re-attach to grandparent if one exists
                if (parent) {
                    if (!anchorChildren.has(parent)) anchorChildren.set(parent, new Set());
                    anchorChildren.get(parent).add(child);
                    childOf.set(child, parent);
                    snapEdge.set(child, detectEdge(vRect(child), vRect(parent)));
                }
                // else child becomes a root node (no childOf entry)
            }
        }
        // Remove closing panel from its parent's children set
        if (parent) {
            const pk = anchorChildren.get(parent);
            if (pk) { pk.delete(el); if (!pk.size) anchorChildren.delete(parent); }
        }
        // Clean up closing panel's own entries
        childOf.delete(el);
        snapEdge.delete(el);
        anchorChildren.delete(el);
    }
    function repositionChild(child) {
        const anchor = childOf.get(child), edge = snapEdge.get(child);
        if (!anchor || !edge) return;
        const ar = vRect(anchor), cr = vRect(child);
        let nl, nt;
        if (edge.side==='right'){nl=Math.round(ar.right);nt=Math.round(ar.top+edge.offset);}
        else if (edge.side==='left'){nl=Math.round(ar.left-cr.width);nt=Math.round(ar.top+edge.offset);}
        else if (edge.side==='bottom'){nl=Math.round(ar.left+edge.offset);nt=Math.round(ar.bottom);}
        else if (edge.side==='top'){nl=Math.round(ar.left+edge.offset);nt=Math.round(ar.top-cr.height);}
        child.style.left=nl+'px'; child.style.top=nt+'px'; child.dataset.dragged='1';
    }
    function onPanelResize(el) {
        if (restoring||drag) return;
        const desc = getDescendants(el);
        if (desc.size>0) { for (const c of desc) { repositionChild(c); const e=findEntry(c); if (e) savePanel(e.key,c); } updateShadowClips(); }
        if (isChild(el)) { repositionChild(el); const md=getDescendants(el); for (const c of md) { repositionChild(c); const e=findEntry(c); if(e) savePanel(e.key,c); } const e=findEntry(el); if(e) savePanel(e.key,el); updateShadowClips(); }
    }
    const resizeObserver = new ResizeObserver(entries => { for (const e of entries) onPanelResize(e.target); });

    // ═══════════════════════════════════════════════════════════
    //  EDGE HELPERS + SHADOW CLIPPING
    // ═══════════════════════════════════════════════════════════
    function edgesTouching(ar, br) {
        const hO=ar.left<br.right+STICK_DIST&&ar.right>br.left-STICK_DIST, vO=ar.top<br.bottom+STICK_DIST&&ar.bottom>br.top-STICK_DIST;
        if(hO){if(Math.abs(ar.top-br.bottom)<=STICK_DIST)return true;if(Math.abs(ar.bottom-br.top)<=STICK_DIST)return true;}
        if(vO){if(Math.abs(ar.left-br.right)<=STICK_DIST)return true;if(Math.abs(ar.right-br.left)<=STICK_DIST)return true;}
        return false;
    }
    function rectsOverlap(a,b){return a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;}
    function updateShadowClips() {
        const visible = getVisiblePanels();
        for (const{el:a}of visible) {
            const ar=vRect(a); let cT=false,cR=false,cB=false,cL=false;
            for (const{el:b}of visible) {
                if(a===b)continue; const rel=childOf.get(a)===b||childOf.get(b)===a; if(!rel)continue;
                const br=vRect(b),hO=ar.left<br.right+STICK_DIST&&ar.right>br.left-STICK_DIST,vO=ar.top<br.bottom+STICK_DIST&&ar.bottom>br.top-STICK_DIST;
                if(hO){if(Math.abs(ar.top-br.bottom)<=STICK_DIST)cT=true;if(Math.abs(ar.bottom-br.top)<=STICK_DIST)cB=true;}
                if(vO){if(Math.abs(ar.left-br.right)<=STICK_DIST)cL=true;if(Math.abs(ar.right-br.left)<=STICK_DIST)cR=true;}
            }
            if(cT||cR||cB||cL){const c=`inset(${cT?'0px':`-${SHADOW_PAD}px`} ${cR?'0px':`-${SHADOW_PAD}px`} ${cB?'0px':`-${SHADOW_PAD}px`} ${cL?'0px':`-${SHADOW_PAD}px`})`;if(a.style.clipPath!==c)a.style.clipPath=c;}
            else{if(a.style.clipPath)a.style.clipPath='';}
        }
        for(const p of panels.values()){const el=p.el;if(el&&!isPanelVisible(el)&&el.style.clipPath)el.style.clipPath='';}
    }

    // ═══════════════════════════════════════════════════════════
    //  EDGE SNAPPING
    // ═══════════════════════════════════════════════════════════
    function calcSnap(panelRects, otherRects) {
        let snapDX=null,snapDY=null,bestDX=SNAP_DIST+1,bestDY=SNAP_DIST+1;
        function tryX(d){if(Math.abs(d)<bestDX){bestDX=Math.abs(d);snapDX=d;}}
        function tryY(d){if(Math.abs(d)<bestDY){bestDY=Math.abs(d);snapDY=d;}}
        let gL=Infinity,gT=Infinity,gR=-Infinity,gB=-Infinity;
        for(const r of panelRects){gL=Math.min(gL,r.left);gT=Math.min(gT,r.top);gR=Math.max(gR,r.right);gB=Math.max(gB,r.bottom);}
        const db=document.querySelector('#deepos-deskbar'),barH=db?db.offsetHeight:0;
        tryX(0-gL);tryX(window.innerWidth-gR);tryY(barH-gT);tryY(window.innerHeight-gB);
        for(const r of panelRects)for(const o of otherRects){
            const hN=r.left<o.right+SNAP_DIST&&r.right>o.left-SNAP_DIST,vN=r.top<o.bottom+SNAP_DIST&&r.bottom>o.top-SNAP_DIST;
            if(hN||Math.abs(r.top-o.top)<SNAP_DIST||Math.abs(r.bottom-o.bottom)<SNAP_DIST){tryX(o.right-r.left);tryX(o.left-r.right);tryX(o.left-r.left);tryX(o.right-r.right);}
            if(vN||Math.abs(r.left-o.left)<SNAP_DIST||Math.abs(r.right-o.right)<SNAP_DIST){tryY(o.bottom-r.top);tryY(o.top-r.bottom);tryY(o.top-r.top);tryY(o.bottom-r.bottom);}
        }
        const dx=snapDX??0,dy=snapDY??0;
        if(dx||dy){for(const r of panelRects){const sh={left:r.left+dx,top:r.top+dy,right:r.right+dx,bottom:r.bottom+dy};for(const o of otherRects)if(rectsOverlap(sh,o))return{dx:0,dy:0};}}
        return{dx,dy};
    }

    // ═══════════════════════════════════════════════════════════
    //  DRAG HANDLER
    // ═══════════════════════════════════════════════════════════
    let drag = null;
    function findTitlebar(panelEl) {
        const entry = findEntry(panelEl);
        if (!entry) return null;
        if (entry.tb && panelEl.contains(entry.tb)) return entry.tb;
        const tb = findTitlebarEl(panelEl); if (tb) entry.tb = tb; return tb;
    }
    function isButton(target, panelEl) {
        const entry = findEntry(panelEl);
        if (!entry || !entry.btns) return false;
        return target.closest(entry.btns);
    }

    document.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        for (const { el } of getVisiblePanels()) {
            const tb = findTitlebar(el);
            if (!tb || !tb.contains(e.target)) continue;
            if (isButton(e.target, el)) continue;
            e.stopPropagation(); e.preventDefault(); bringToFront(el);
            const isCh = isChild(el), movingSet = new Set([el]);
            for (const c of getDescendants(el)) movingSet.add(c);
            const sp = new Map(); for (const g of movingSet) sp.set(g, { x: parseInt(g.style.left) || 0, y: parseInt(g.style.top) || 0 });
            drag = { panel: el, movingSet, startPositions: sp, startMouse: { x: e.clientX, y: e.clientY }, moved: false, wasChild: isCh };
            return;
        }
    }, true);

    document.addEventListener('mousemove', (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.startMouse.x, dy = e.clientY - drag.startMouse.y;
        if (!drag.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
        if (!drag.moved && drag.wasChild) detach(drag.panel);
        drag.moved = true;
        for (const [el, start] of drag.startPositions) {
            el.style.left = (start.x + dx) + 'px'; el.style.top = (start.y + dy) + 'px';
            const m = (el.style.transform || '').match(/scale\([^)]+\)/);
            el.style.transform = m ? m[0] : 'none'; el.dataset.dragged = '1';
        }
        const mr = [...drag.movingSet].map(vRect);
        const or = getVisiblePanels().filter(p => !drag.movingSet.has(p.el)).map(p => vRect(p.el));
        const snap = calcSnap(mr, or);
        if (snap.dx || snap.dy) for (const [el, start] of drag.startPositions) {
            el.style.left = (start.x + dx + snap.dx) + 'px'; el.style.top = (start.y + dy + snap.dy) + 'px';
        }
        updateShadowClips();
    });

    document.addEventListener('mouseup', () => {
        if (!drag) return;
        if (drag.moved) {
            for (const el of drag.movingSet) { const e = findEntry(el); if (e) savePanel(e.key, el); }
            const panel = drag.panel;
            if (!isChild(panel)) {
                const pr = vRect(panel);
                for (const { el: other } of getVisiblePanels()) {
                    if (other === panel || drag.movingSet.has(other)) continue;
                    if (edgesTouching(pr, vRect(other))) { attach(panel, other); break; }
                }
            }
            for (const { el: other } of getVisiblePanels()) {
                if (drag.movingSet.has(other) || isChild(other)) continue;
                for (const el of drag.movingSet) { if (edgesTouching(vRect(other), vRect(el))) { attach(other, el); break; } }
            }
        }
        drag = null; updateShadowClips();
    });

    // Click to front
    document.addEventListener('mousedown', (e) => {
        for (const { el } of getVisiblePanels()) { if (el.contains(e.target)) { bringToFront(el); return; } }
    }, false);

    // ═══════════════════════════════════════════════════════════
    //  VISIBILITY: RESTORE + Z-INDEX ON OPEN
    // ═══════════════════════════════════════════════════════════
    const wasVisible = new Map();
    function checkVisibility() {
        for (const [key, p] of panels) {
            const el = p.el || document.querySelector(p.sel); if (!el) continue; p.el = el;
            const vis = isPanelVisible(el), prev = wasVisible.get(key) || false;
            if (vis && !prev) {
                bringToFront(el);
                if (loadPositions()[key]) {
                    el.style.visibility = 'hidden';
                    requestAnimationFrame(() => requestAnimationFrame(() => {
                        restorePanel(key, el); el.style.visibility = ''; integratePanel(el); updateShadowClips();
                    }));
                } else requestAnimationFrame(() => { integratePanel(el); updateShadowClips(); });
            } else if (!vis && prev) { savePanel(key, el); promoteAndRemove(el); updateShadowClips(); }
            wasVisible.set(key, vis);
        }
    }
    // Integrate a single newly-opened panel into the existing anchor tree
    // without touching any other relationships.
    function integratePanel(el) {
        const visible = getVisiblePanels();
        // If the new panel is touching any existing panel, attach it
        if (!isChild(el)) {
            for (const { el: other } of visible) {
                if (other === el) continue;
                if (edgesTouching(vRect(el), vRect(other))) {
                    attach(el, other);
                    break;
                }
            }
        }
        // Check if any unattached panels are now touching the new panel
        for (const { el: other } of visible) {
            if (other === el || isChild(other)) continue;
            if (edgesTouching(vRect(other), vRect(el))) {
                attach(other, el);
            }
        }
    }
    function rebuildAnchors() {
        anchorChildren.clear(); childOf.clear(); snapEdge.clear();
        const visible = getVisiblePanels(); let changed = true;
        while (changed) { changed = false;
            for (let i = 0; i < visible.length; i++) { const a = visible[i]; if (isChild(a.el)) continue;
                for (let j = 0; j < visible.length; j++) { if (i === j) continue; const b = visible[j];
                    if (a.el !== b.el && edgesTouching(vRect(a.el), vRect(b.el)) && !isChild(a.el) && !wouldCycle(a.el, b.el)) { attach(a.el, b.el); changed = true; break; }
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
                p.el = el; visObserver.observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
                resizeObserver.observe(el); el.dataset.dnWmObserved = '1'; wasVisible.set(key, isPanelVisible(el));
            }
        }
    }
    setInterval(observePanels, 2000);
    new MutationObserver(observePanels).observe(document.body, { childList: true });

    // ═══════════════════════════════════════════════════════════
    //  TERMINAL FOCUS
    // ═══════════════════════════════════════════════════════════
    function isTerminalActive() {
        const dos = window._DOS;
        if (dos && dos.active) {
            if (dos.terminalMinimized || dos.foregroundApp) return false;
            const tw = document.getElementById('deepos-win-terminal');
            if (!tw || !tw.classList.contains('visible')) return false;
            return true;
        }
        const prompt = document.querySelector('#prompt');
        return prompt && prompt.textContent.includes('@');
    }
    function isAnyOverlayOpen() {
        for (const el of document.querySelectorAll('[id*="overlay"]')) {
            if (el.id === 'deepos-win-terminal' || el.style.display === 'none') continue;
            if (!el.offsetWidth && !el.offsetHeight) continue;
            const pos = getComputedStyle(el).position;
            if (pos === 'fixed' || pos === 'absolute') return true;
        }
        if (document.querySelector('.dn-select-popup')) return true;
        if (typeof SelectPopup !== 'undefined' && SelectPopup.isOpen?.()) return true;
        if (typeof MinigameEngine !== 'undefined' && MinigameEngine.isRunning?.()) return true;
        if (typeof activeCancelableCommand !== 'undefined' && activeCancelableCommand) return true;
        return false;
    }
    function isScriptPanel(target) {
        if (!target?.closest) return false;
        for (const p of panels.values()) if (target.closest(p.sel)) return true;
        return target.closest('.dn-select-popup, .dntw-slot-menu');
    }
    function shouldRefocus() {
        if (!isTerminalActive() || isAnyOverlayOpen()) return false;
        if (typeof commandBusy !== 'undefined' && commandBusy) return false;
        if (typeof inputCapture !== 'undefined' && inputCapture) return false;
        if (isScriptPanel(document.activeElement)) return false;
        const sel = window.getSelection(); if (sel && sel.toString().length > 0) return false;
        return true;
    }
    document.addEventListener('click', (e) => {
        if (e.target.closest('button, a, select, input, textarea, [contenteditable]')) return;
        if (isScriptPanel(e.target)) return;
        if (!e.target.closest('#terminal, #output, #deepos-desktop, #deepos-win-terminal')) return;
        setTimeout(() => { if (shouldRefocus()) { const inp = document.getElementById('cmd-input'); if (inp) inp.focus({ preventScroll: true }); } }, 50);
    });

    // ═══════════════════════════════════════════════════════════
    //  TAB KEY SUPPRESSION
    //  Prevent browser focus cycling — TAB is used by the game
    //  for command autocomplete in the terminal.
    // ═══════════════════════════════════════════════════════════
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') e.preventDefault();
    }, true);

    // ═══════════════════════════════════════════════════════════
    //  INIT
    // ═══════════════════════════════════════════════════════════
    injectSharedStyles();
    // Fire ready when logged in
    const readyCheck = setInterval(() => { if (isLoggedIn()) { clearInterval(readyCheck); _fireReady(); } }, 500);

    console.log('[WM] v5.0.3 — Framework + anchor snap + position persistence + terminal focus');
})();
