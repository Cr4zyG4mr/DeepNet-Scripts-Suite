// ==UserScript==
// @name         DeepNet Dossier
// @namespace    https://macinsight.github.io/deepwiki/modding/
// @version      1.1.0
// @description  Player dossier viewer for DeepNet — paginated panel
// @author       Rain
// @match        https://deepnet.us/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const SETTINGS_KEY = 'dndos-settings';
    function loadSettings() {
        try { const s = JSON.parse(localStorage.getItem(SETTINGS_KEY)); if (s) return s; } catch (_) {}
        return { uiScale: 0 };
    }
    function saveSettings() {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
    }
    let settings = loadSettings();
    function getScale() {
        if (settings.uiScale > 0) return settings.uiScale;
        return Math.max(1.0, Math.min(1.8, 0.55 + window.innerHeight / 1600));
    }

    // ═══════════════════════════════════════════════════════════
    //  CREDENTIAL CAPTURE & API
    // ═══════════════════════════════════════════════════════════
    let machineId = null, token = null;
    const _origFetch = window.fetch;
    function installCredSniffer() {
        window.fetch = function (...args) {
            try {
                const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
                if ((url?.includes('api.php') || url?.includes('/api?')) && args[1]?.body) {
                    const b = JSON.parse(args[1].body);
                    if (b.machine_id) machineId = b.machine_id;
                    if (b.token) token = b.token;
                    if (machineId && token) window.fetch = _origFetch;
                }
            } catch (_) {}
            return _origFetch.apply(this, args);
        };
    }
    installCredSniffer();

    function reqId() {
        const buf = new Uint8Array(16);
        crypto.getRandomValues(buf);
        return [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
    }

    function getApiBase() {
        try {
            if (window.CONFIG && window.CONFIG.API_BASE) return window.CONFIG.API_BASE;
            if (window.APP_CONFIG && window.APP_CONFIG.API_BASE) return window.APP_CONFIG.API_BASE;
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
        } catch (e) { return null; }
    }

    // ═══════════════════════════════════════════════════════════
    //  HELPERS
    // ═══════════════════════════════════════════════════════════
    function isLoggedIn() {
        const p = document.querySelector('#prompt');
        return p && p.textContent.includes('@deepnet') && !p.textContent.includes('guest@deepnet');
    }
    function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function heatColor(l) { l = String(l).toLowerCase(); return l === 'cold' || l === 'cool' ? '#3ddc84' : l === 'warm' ? '#c8a84b' : '#c85a5a'; }
    function tierColor(t) { return t >= 3 ? '#a335ee' : t >= 2 ? '#0070dd' : t >= 1 ? '#3ddc84' : 'var(--dos-text-dim)'; }
    function expColor(e) { e = String(e).toUpperCase(); return e === 'LOW' || e === 'MINIMAL' ? '#3ddc84' : e === 'ELEVATED' || e === 'MODERATE' ? '#c8a84b' : '#c85a5a'; }

    // ═══════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════
    let panelEl = null, dossier = null, loading = false;
    let currentView = 'main', currentTab = 'profile';
    const TABS = [
        { key: 'profile', label: 'Profile' },
        { key: 'shadow',  label: 'Shadow' },
        { key: 'social',  label: 'Social' },
        { key: 'world',   label: 'World' },
    ];

    // ═══════════════════════════════════════════════════════════
    //  STYLES
    // ═══════════════════════════════════════════════════════════
    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            #dndos-panel {
                display: none; position: fixed; z-index: 6000; width: 480px;
                flex-direction: column;
                font-family: var(--dos-font, Consolas, "Courier New", monospace);
                font-size: var(--dos-font-sm, 12px);
                color: var(--dos-text, #b3b3b3);
                background: var(--dos-bg-window, #0a0a0a);
                border: 1px solid var(--dos-border, #222);
                box-shadow: 4px 4px 12px var(--dos-shadow, rgba(0,0,0,0.6));
                cursor: none; transform-origin: top left;
                max-height: 85vh; overflow: hidden;
            }
            #dndos-panel.visible { display: flex; }
            #dndos-panel, #dndos-panel * { cursor: none !important; }

            .dndos-titlebar {
                display: flex; align-items: center; padding: 0 8px; height: 26px;
                background: var(--dos-tab-bg, #1a1a1a);
                border-bottom: 1px solid var(--dos-border, #222);
                flex-shrink: 0; gap: 6px;
            }
            .dndos-title {
                font-size: 11px; font-weight: normal; letter-spacing: 0.06em;
                text-transform: uppercase; color: var(--dos-text-label, #a3a3a3); flex: 1;
            }
            .dndos-hdr-btn {
                width: 14px; height: 14px;
                background: var(--dos-border, #222); border: 1px solid var(--dos-border-hi, #333);
                display: flex; align-items: center; justify-content: center;
                font-size: 10px; color: var(--dos-text-dim, #7a7a7a); line-height: 1;
            }
            .dndos-hdr-btn:hover { background: var(--dos-bg-hover); border-color: var(--dos-border-hi); color: var(--dos-text-hi); }
            .dndos-hdr-btn.close:hover { background: var(--dos-close-bg); border-color: var(--dos-close-border); }

            /* Tabs */
            .dndos-tabs {
                display: flex; border-bottom: 1px solid var(--dos-border-lo, #1a1a1a); flex-shrink: 0;
            }
            .dndos-tab {
                flex: 1; padding: 5px 0; text-align: center;
                font-family: inherit; font-size: 10px; font-weight: normal;
                letter-spacing: 0.06em; text-transform: uppercase;
                border: none; border-right: 1px solid var(--dos-border-lo, #1a1a1a);
                background: var(--dos-bg, #0c0c0c); color: var(--dos-text-xdim, #696969);
                transition: background 0.15s, color 0.15s;
            }
            .dndos-tab:last-child { border-right: none; }
            .dndos-tab:hover { background: var(--dos-bg-hover); color: var(--dos-text); }
            .dndos-tab.active {
                background: var(--dos-bg-panel, #1a1a1a); color: var(--dos-accent-hi, #999);
                border-bottom: 1px solid var(--dos-accent, #666);
            }

            /* Body */
            .dndos-body {
                flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px;
                scrollbar-width: thin; scrollbar-color: var(--dos-border-hi) var(--dos-bg);
            }
            .dndos-body::-webkit-scrollbar { width: 4px; }
            .dndos-body::-webkit-scrollbar-track { background: var(--dos-bg); }
            .dndos-body::-webkit-scrollbar-thumb { background: var(--dos-border-hi); }

            .dndos-loading { padding: 20px; text-align: center; color: var(--dos-text-xdim); font-style: italic; }

            /* Sections */
            .dndos-sec-title {
                font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
                color: var(--dos-text-xdim, #696969); margin: 10px 0 6px 0;
            }
            .dndos-sec-title:first-child { margin-top: 0; }

            /* Key-value rows */
            .dndos-row {
                display: flex; justify-content: space-between; align-items: center;
                padding: 2px 0; font-size: 11px;
            }
            .dndos-k { color: var(--dos-text-dim); }
            .dndos-v { color: var(--dos-text); text-align: right; }

            /* Attribute bars */
            .dndos-attr {
                display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 11px;
            }
            .dndos-attr-lbl { color: var(--dos-text-dim); width: 70px; text-transform: capitalize; flex-shrink: 0; }
            .dndos-attr-bar { flex: 1; height: 4px; background: var(--dos-border-lo); }
            .dndos-attr-fill { height: 100%; background: var(--dos-accent-hi, #888); }
            .dndos-attr-val { color: var(--dos-text); width: 30px; text-align: right; font-size: 11px; }

            /* Category rows */
            .dndos-cat {
                display: flex; gap: 8px; padding: 3px 6px; font-size: 11px;
                border: 1px solid var(--dos-border-lo); background: var(--dos-bg-panel);
                margin-bottom: 2px; align-items: center;
            }
            .dndos-cat-name { flex: 1; color: var(--dos-text); text-transform: capitalize; }
            .dndos-cat-hacks { color: var(--dos-text-dim); font-size: 10px; }
            .dndos-cat-tier { font-size: 10px; font-weight: bold; }
            .dndos-cat-warn { color: #c8a84b; font-size: 9px; }

            /* NPC rows */
            .dndos-npc {
                display: flex; justify-content: space-between; padding: 2px 6px;
                font-size: 11px; border-bottom: 1px solid var(--dos-border-lo);
            }
            .dndos-npc:last-child { border-bottom: none; }
            .dndos-npc-name { color: var(--dos-text); text-transform: capitalize; }
            .dndos-npc-lbl { color: var(--dos-text-dim); font-size: 10px; }

            /* Action rows */
            .dndos-act { padding: 4px 6px; margin-bottom: 2px; border: 1px solid var(--dos-border-lo); background: var(--dos-bg-panel); font-size: 11px; }
            .dndos-act-cmd { color: #3ddc84; font-weight: bold; font-size: 10px; }
            .dndos-act-why { color: var(--dos-text-dim); margin-top: 1px; }

            /* Refresh button */
            .dndos-btn {
                width: 100%; padding: 5px 0; text-align: center;
                font-family: inherit; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase;
                border: 1px solid var(--dos-border, #222); background: var(--dos-bg-panel);
                color: var(--dos-text-label); margin-top: 8px;
            }
            .dndos-btn:hover { background: var(--dos-bg-hover); color: var(--dos-text-hi); border-color: var(--dos-border-hi); }

            /* Settings */
            .dndos-scale-row { display: flex; align-items: center; gap: 4px; }
            .dndos-scale-btn {
                width: 22px; height: 22px;
                background: var(--dos-bg-panel); border: 1px solid var(--dos-border);
                color: var(--dos-text-label); font-size: 13px; font-family: inherit;
                display: flex; align-items: center; justify-content: center;
            }
            .dndos-scale-btn:hover { border-color: var(--dos-border-hi); color: var(--dos-text-hi); background: var(--dos-bg-hover); }
            .dndos-scale-label { font-size: 11px; color: var(--dos-text); min-width: 90px; text-align: center; }

            /* CLI fallback */
            #dndos-cli-btn {
                display: none; min-width: 18px; padding: 1px 5px;
                text-align: center; font-weight: bold; font-size: 13px; font-family: inherit;
                color: #9cf79c; border: 1px solid #4a8f4a; background: rgba(12,42,12,0.65);
                cursor: pointer; letter-spacing: 0.5px; white-space: nowrap;
            }
            #dndos-cli-btn:hover { background: rgba(20,60,20,0.8); border-color: #6abf6a; color: #bfffbf; }
        `;
        document.head.appendChild(style);
    }

    // ═══════════════════════════════════════════════════════════
    //  PANEL
    // ═══════════════════════════════════════════════════════════
    function buildPanel() {
        panelEl = document.createElement('div');
        panelEl.id = 'dndos-panel';
        panelEl.innerHTML = `
            <div class="dndos-titlebar">
                <span class="dndos-title">Dossier</span>
                <div class="dndos-hdr-btn" id="dndos-settings-btn" title="Settings">\u2699</div>
                <div class="dndos-hdr-btn close" id="dndos-close">\u00D7</div>
            </div>
            <div id="dndos-tabs-wrap"></div>
            <div class="dndos-body" id="dndos-body"></div>`;
        document.body.appendChild(panelEl);
        makePanelDraggable(panelEl, panelEl.querySelector('.dndos-titlebar'));
        document.getElementById('dndos-close').addEventListener('click', hidePanel);
        document.getElementById('dndos-settings-btn').addEventListener('click', () => {
            switchView(currentView === 'settings' ? 'main' : 'settings');
        });

        // Keyboard nav
        document.addEventListener('keydown', (e) => {
            if (!panelEl?.classList.contains('visible') || currentView !== 'main') return;
            // Don't capture if typing in an input
            if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
            const idx = TABS.findIndex(t => t.key === currentTab);
            if (e.key === 'ArrowLeft' && idx > 0) { currentTab = TABS[idx - 1].key; renderMain(); e.preventDefault(); }
            else if (e.key === 'ArrowRight' && idx < TABS.length - 1) { currentTab = TABS[idx + 1].key; renderMain(); e.preventDefault(); }
            else if (e.key >= '1' && e.key <= String(TABS.length)) { currentTab = TABS[parseInt(e.key) - 1].key; renderMain(); e.preventDefault(); }
        });
    }

    function switchView(view) {
        currentView = view;
        const wrap = document.getElementById('dndos-tabs-wrap');
        if (view === 'main') {
            renderTabs(); renderMain();
        } else {
            if (wrap) wrap.innerHTML = '';
            renderSettings();
        }
        const btn = document.getElementById('dndos-settings-btn');
        if (btn) btn.style.color = view === 'settings' ? 'var(--dos-accent-hi)' : '';
    }

    function renderTabs() {
        const wrap = document.getElementById('dndos-tabs-wrap');
        if (!wrap) return;
        wrap.innerHTML = `<div class="dndos-tabs">${TABS.map((t, i) =>
            `<button class="dndos-tab${t.key === currentTab ? ' active' : ''}" data-tab="${t.key}">${i + 1}. ${t.label}</button>`
        ).join('')}</div>`;
        wrap.querySelectorAll('.dndos-tab').forEach(btn => {
            btn.addEventListener('click', () => { currentTab = btn.dataset.tab; renderTabs(); renderMain(); });
        });
    }

    function centerPanel() {
        if (!panelEl) return;
        const s = getScale();
        const pw = 480 * s, ph = (panelEl.offsetHeight || 400) * s;
        panelEl.style.left = Math.max(0, (window.innerWidth - pw) / 2) + 'px';
        panelEl.style.top = Math.max(0, (window.innerHeight - ph) / 2) + 'px';
        panelEl.style.transform = `scale(${s})`;
        delete panelEl.dataset.dragged;
    }
    function applyScale() {
        if (!panelEl) return;
        if (panelEl.dataset.dragged) panelEl.style.transform = `scale(${getScale()})`;
        else centerPanel();
    }

    function kv(k, v) {
        return `<div class="dndos-row"><span class="dndos-k">${esc(k)}</span><span class="dndos-v">${v}</span></div>`;
    }

    // ── Page renderers ──
    function renderMain() {
        const body = document.getElementById('dndos-body');
        if (!body || currentView !== 'main') return;

        if (loading) { body.innerHTML = '<div class="dndos-loading">Fetching dossier...</div>'; return; }
        if (!dossier) {
            body.innerHTML = '<div class="dndos-loading">No data</div><button class="dndos-btn" id="dndos-refresh">Refresh</button>';
            document.getElementById('dndos-refresh')?.addEventListener('click', fetchAndRender);
            return;
        }

        const renderers = { profile: renderProfile, shadow: renderShadow, social: renderSocial, world: renderWorld };
        const fn = renderers[currentTab];
        if (fn) fn(body);
    }

    function renderProfile(body) {
        const p = dossier.profile || {}, rec = dossier.recognition || {}, sp = dossier.specialization || {};
        const attrs = p.attributes || {};

        let html = '';
        html += `<div class="dndos-sec-title">Operator</div>`;
        html += kv('Level', `<span style="color:var(--dos-text-hi)">${p.level} \u2014 ${esc(p.level_title)}</span>`);
        html += kv('Hacks Completed', p.hacks_completed);
        html += kv('Defense', `${esc(p.pvp_mastery_title)} [${p.pvp_mastery_level}]`);
        html += kv('Recognition', `${esc(rec.label)} (${rec.score})`);
        html += kv('Identity', esc(dossier.identity || ''));

        html += `<div class="dndos-sec-title">Attributes</div>`;
        for (const [key, val] of Object.entries(attrs)) {
            const v = Number(val), pct = Math.min(100, (v / 5) * 100);
            html += `<div class="dndos-attr">
                <span class="dndos-attr-lbl">${esc(key)}</span>
                <div class="dndos-attr-bar"><div class="dndos-attr-fill" style="width:${pct}%"></div></div>
                <span class="dndos-attr-val">${v.toFixed(1)}</span>
            </div>`;
        }

        html += `<div class="dndos-sec-title">Specialization</div>`;
        html += kv('Status', esc(sp.status || ''));
        html += kv('Top Category', `${esc((sp.top_category || '').toUpperCase())} (${sp.top_ratio ? Math.round(sp.top_ratio * 100) : 0}%)`);
        html += kv('Total Hacks', sp.total_hacks || 0);

        const pw = dossier.pathways || {};
        html += `<div class="dndos-sec-title">Neural Pathways</div>`;
        html += kv('Active Nodes', pw.active_nodes?.join(', ') || 'None');
        html += kv('Training', `${pw.training_placed || 0}/${pw.training_total || 0} placed`);

        html += '<button class="dndos-btn" id="dndos-refresh">Refresh</button>';
        body.innerHTML = html;
        document.getElementById('dndos-refresh')?.addEventListener('click', fetchAndRender);
    }

    function renderShadow(body) {
        const h = dossier.heat || {}, s = dossier.shadow || {};

        let html = '';
        html += `<div class="dndos-sec-title">Heat Status</div>`;
        html += kv('Heat', `<span style="color:${heatColor(h.level)}">${esc(String(h.level || '').toUpperCase())}</span> (${h.score || 0}/200)`);
        html += kv('Loot Mult', `${h.loot_mult || 1}x`);
        if (h.fw_bonus) html += kv('FW Bonus', h.fw_bonus);
        if (h.deal_penalty) html += kv('Deal Penalty', `<span style="color:#c85a5a">${h.deal_penalty}</span>`);
        html += kv('Private Access', h.private_access ? 'Yes' : 'No');

        html += `<div class="dndos-sec-title">Shadow Profile</div>`;
        html += kv('Exposure', `<span style="color:${expColor(s.exposure)}">${esc(s.exposure || '')}</span>`);
        html += kv('Overall Tier', s.overall_tier || 0);
        html += kv('Burns', s.burns > 0 ? `<span style="color:#c85a5a">${s.burns}</span>` : '0');
        html += kv('Codename', s.codename || '(none)');

        if (s.categories?.length) {
            html += `<div class="dndos-sec-title">Categories</div>`;
            for (const cat of s.categories) {
                const tc = tierColor(cat.tier);
                html += `<div class="dndos-cat">
                    <span class="dndos-cat-name">${esc(cat.name)}</span>
                    <span class="dndos-cat-hacks">${cat.hack_count} hacks</span>
                    <span class="dndos-cat-tier" style="color:${tc}">mk${cat.tier}</span>
                    ${cat.field_status ? `<span class="dndos-cat-warn">\u26A0 ${esc(cat.field_status)}</span>` : ''}
                </div>`;
            }
        }

        html += '<button class="dndos-btn" id="dndos-refresh">Refresh</button>';
        body.innerHTML = html;
        document.getElementById('dndos-refresh')?.addEventListener('click', fetchAndRender);
    }

    function renderSocial(body) {
        const cr = dossier.crew || {}, f = dossier.faction || {}, g = dossier.group || {}, tr = dossier.trust || {};

        let html = '';
        html += `<div class="dndos-sec-title">Crew</div>`;
        if (cr.name) {
            html += kv('Name', `${esc(cr.name)} [${esc(cr.tag)}]`);
            html += kv('Role', esc(cr.role || ''));
            html += kv('Members', cr.member_count || 0);
            html += kv('Pool', cr.pool || 0);
        } else {
            html += kv('Status', 'No crew');
        }

        html += `<div class="dndos-sec-title">Group / Faction</div>`;
        html += kv('Group', esc(g.name || 'None'));
        if (g.focus) html += kv('Focus', esc(g.focus));
        html += kv('Faction', esc(f.name ? f.name.toUpperCase() : 'None'));
        if (f.fw_info) html += kv('FW Bonus', esc(f.fw_info));

        html += `<div class="dndos-sec-title">Trust</div>`;
        html += kv('Net Rep', `${esc(tr.net_label || '')} (${tr.net_rep || 0})`);
        if (tr.npcs?.length) {
            for (const npc of tr.npcs) {
                html += `<div class="dndos-npc">
                    <span class="dndos-npc-name">${esc(npc.npc?.replace(/_/g, ' ') || '')}</span>
                    <span class="dndos-npc-lbl">${esc(npc.label || '')} Lv.${npc.level}</span>
                </div>`;
            }
        }

        html += '<button class="dndos-btn" id="dndos-refresh">Refresh</button>';
        body.innerHTML = html;
        document.getElementById('dndos-refresh')?.addEventListener('click', fetchAndRender);
    }

    function renderWorld(body) {
        const w = dossier.world || {}, sp = dossier.specialization || {};

        let html = '';
        html += `<div class="dndos-sec-title">World State</div>`;
        html += kv('Geo State', esc(w.geo_state || ''));
        html += kv('Defense Mult', `${Math.round(((w.defense_mult || 1) - 1) * 100)}%`);
        html += kv('Yield Drift', `+${Math.round((w.loot_bias || 0) * 100)}%`);

        html += `<div class="dndos-sec-title">Operator Pattern</div>`;
        html += kv('Status', esc(sp.status || ''));
        html += kv('Total Hacks', sp.total_hacks || 0);

        if (dossier.next_actions?.length) {
            html += `<div class="dndos-sec-title">Suggested Actions</div>`;
            for (const a of dossier.next_actions) {
                html += `<div class="dndos-act">
                    <div class="dndos-act-cmd">${esc(a.command)}</div>
                    <div class="dndos-act-why">${esc(a.reason)}</div>
                </div>`;
            }
        }

        html += '<button class="dndos-btn" id="dndos-refresh">Refresh</button>';
        body.innerHTML = html;
        document.getElementById('dndos-refresh')?.addEventListener('click', fetchAndRender);
    }

    async function fetchAndRender() {
        loading = true; renderMain();
        const data = await api('player_dossier');
        if (data?.success) dossier = data;
        loading = false;
        renderMain();
    }

    // ── Settings view ──
    function renderSettings() {
        const body = document.getElementById('dndos-body');
        if (!body) return;
        const scaleLabel = settings.uiScale === 0
            ? `Auto (${Math.round(getScale() * 100)}%)`
            : `${Math.round(settings.uiScale * 100)}%`;
        body.innerHTML = `
            <div class="dndos-sec-title">UI Scale</div>
            <div class="dndos-scale-row">
                <div class="dndos-scale-btn" id="dndos-sc-down">\u2212</div>
                <span class="dndos-scale-label">${scaleLabel}</span>
                <div class="dndos-scale-btn" id="dndos-sc-up">+</div>
                <div class="dndos-scale-btn" id="dndos-sc-auto" style="width:auto;padding:0 6px;${settings.uiScale===0?'color:var(--dos-accent-hi);border-color:var(--dos-accent)':''}">Auto</div>
            </div>`;
        document.getElementById('dndos-sc-down').addEventListener('click', () => {
            settings.uiScale = Math.max(0.8, Math.round(((settings.uiScale || getScale()) - 0.1) * 10) / 10);
            saveSettings(); applyScale(); renderSettings();
        });
        document.getElementById('dndos-sc-up').addEventListener('click', () => {
            settings.uiScale = Math.min(2.0, Math.round(((settings.uiScale || getScale()) + 0.1) * 10) / 10);
            saveSettings(); applyScale(); renderSettings();
        });
        document.getElementById('dndos-sc-auto').addEventListener('click', () => {
            settings.uiScale = 0; saveSettings(); applyScale(); renderSettings();
        });
    }

    function showPanel() {
        if (!panelEl) buildPanel();
        panelEl.classList.add('visible');
        currentView = 'main';
        renderTabs(); renderMain();
        requestAnimationFrame(() => centerPanel());
        fetchAndRender();
    }
    function hidePanel() { if (panelEl) panelEl.classList.remove('visible'); }

    function makePanelDraggable(el, handle) {
        let ox, oy, dx, dy;
        handle.addEventListener('mousedown', (e) => {
            if (e.target.closest('.dndos-hdr-btn')) return;
            const rect = el.getBoundingClientRect();
            el.style.transform = `scale(${getScale()})`;
            el.style.left = rect.left + 'px'; el.style.top = rect.top + 'px';
            el.dataset.dragged = '1';
            ox = e.clientX; oy = e.clientY; dx = rect.left; dy = rect.top;
            const mv = (e2) => { el.style.left = (dx + e2.clientX - ox) + 'px'; el.style.top = (dy + e2.clientY - oy) + 'px'; };
            const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
            document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
            e.preventDefault();
        });
    }

    // ═══════════════════════════════════════════════════════════
    //  DESKTOP ICON + CLI FALLBACK
    // ═══════════════════════════════════════════════════════════
    let sawDeepOSPending = false, isDesktopIcon = false, cliBtnEl = null;
    const ICON_POS_KEY = 'deepos_icon_positions';
    function isDeepOSPending() {
        const p = window._deeposBootPending || document.body.classList.contains('deepos-active') || (window._DOS && window._DOS.active);
        if (p) sawDeepOSPending = true; return p || sawDeepOSPending;
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
        document.addEventListener('mousemove', e => {
            if (!d) return;
            if (!m && Math.abs(e.clientX - (ox + parseInt(icon.style.left || 0))) < 3 && Math.abs(e.clientY - (oy + parseInt(icon.style.top || 0))) < 3) return;
            m = true; const p = icon.parentElement.getBoundingClientRect();
            icon.style.left = Math.max(0, Math.min(e.clientX - ox, p.width - icon.offsetWidth)) + 'px';
            icon.style.top = Math.max(0, Math.min(e.clientY - oy, p.height - icon.offsetHeight)) + 'px';
        });
        document.addEventListener('mouseup', () => { if (!d) return; if (m) { saveIconPositions(); w = true; setTimeout(() => { w = false; }, 400); } d = false; m = false; });
        return () => w;
    }

    function placeUI() {
        if (isDesktopIcon || (cliBtnEl && cliBtnEl.parentElement)) return true;
        const icons = document.querySelector('#deepos-icons');
        if (icons) {
            const icon = document.createElement('div'); icon.className = 'deepos-icon'; icon.dataset.app = 'dndos';
            icon.innerHTML = '<div class="deepos-icon-gfx" style="background:var(--dos-icon-bg);color:var(--dos-icon-color);font-size:clamp(0.5rem,0.85vw,1rem);font-weight:bold;letter-spacing:0.03em;">DSR</div><span>Dossier</span>';
            applyIconPos(icon, 'dndos'); const chk = makeIconDraggable(icon);
            icon.addEventListener('dblclick', () => { if (!chk()) showPanel(); });
            icons.appendChild(icon); isDesktopIcon = true; return true;
        }
        if (isDeepOSPending()) return false;
        cliBtnEl = document.createElement('span'); cliBtnEl.id = 'dndos-cli-btn';
        cliBtnEl.textContent = 'DSR'; cliBtnEl.title = 'Dossier';
        cliBtnEl.addEventListener('click', showPanel);
        const sr = document.querySelector('#status-right'), sb = document.querySelector('#statusbar');
        if (sr && sb) sb.insertBefore(cliBtnEl, sr); else if (sb) sb.appendChild(cliBtnEl); else return false;
        return true;
    }

    // ═══════════════════════════════════════════════════════════
    //  BOOTSTRAP
    // ═══════════════════════════════════════════════════════════
    function init() {
        injectStyles();
        const bc = setInterval(() => {
            if (!isLoggedIn()) return; if (!placeUI()) return;
            clearInterval(bc);
            if (cliBtnEl) cliBtnEl.style.display = 'inline-block';
            console.log('[DOSSIER] v1.1 placed as', isDesktopIcon ? 'icon' : 'cli');
        }, 500);
    }
    setTimeout(init, 2000);
})();
