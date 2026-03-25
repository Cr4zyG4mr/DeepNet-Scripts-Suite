// ==UserScript==
// @name         DeepNet Tripwire Manager
// @namespace    https://macinsight.github.io/deepwiki/modding/
// @version      3.4.0
// @description  Tripwire deployment UI for DeepNet — one-click deploy/clear, IP change alerts (API-driven, 5 slots)
// @author       Rain
// @match        https://deepnet.us/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const TRIGGERS = ['file_access', 'login_fail', 'port_scan'];
    const ACTIONS  = ['alert', 'counter_exposure', 'ddos_pulse'];
    const MAX_SLOTS = 5;
    const SETTINGS_KEY = 'dntw-settings';

    function defaultSlots() {
        return [
            { enabled: true,  trigger: 'file_access', action: 'alert',            honeypot: false },
            { enabled: true,  trigger: 'file_access', action: 'counter_exposure',  honeypot: false },
            { enabled: true,  trigger: 'file_access', action: 'ddos_pulse',        honeypot: false },
            { enabled: false, trigger: 'file_access', action: 'alert',            honeypot: false },
            { enabled: false, trigger: 'file_access', action: 'alert',            honeypot: false },
        ];
    }

    function loadSettings() {
        try {
            const s = JSON.parse(localStorage.getItem(SETTINGS_KEY));
            if (s?.slots?.length === MAX_SLOTS) {
                s.slots.forEach(sl => {
                    if (typeof sl.honeypot !== 'boolean') sl.honeypot = false;
                });
                if (typeof s.uiScale !== 'number') s.uiScale = 0; // 0 = auto
                if (typeof s.sound !== 'boolean') s.sound = true;
                return { slots: s.slots, uiScale: s.uiScale, sound: s.sound };
            }
        } catch (_) {}
        return { slots: defaultSlots(), uiScale: 0, sound: true };
    }
    function saveSettings() {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
    }
    let settings = loadSettings();

    function getEnabledSlots() { return settings.slots.filter(s => s.enabled); }

    function getScale() {
        if (settings.uiScale > 0) return settings.uiScale;
        // Auto: scale up for high-res screens. Base = 1.0 at 900px vh, 1.4 at 1440px
        const vh = window.innerHeight;
        return Math.max(1.0, Math.min(1.8, 0.55 + vh / 1600));
    }

    function applyScale() {
        if (!panelEl) return;
        const s = getScale();
        if (panelEl.dataset.dragged) {
            panelEl.style.transform = `scale(${s})`;
        } else {
            // Re-center with new scale
            centerPanel();
        }
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
                    if (machineId && token) {
                        window.fetch = _origFetch;
                    }
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
        } catch (e) { console.error(`[TW] API ${action}:`, e); return null; }
    }

    // ═══════════════════════════════════════════════════════════
    //  HELPERS
    // ═══════════════════════════════════════════════════════════
    function getCurrentIP() {
        for (const sel of ['#dos-ip', '#status-ip']) {
            const el = document.querySelector(sel);
            if (el) { const m = el.textContent.match(/(\d+\.\d+\.\d+\.\d+)/); if (m) return m[1]; }
        }
        return null;
    }
    function isLoggedIn() {
        const p = document.querySelector('#prompt');
        return p && p.textContent.includes('@deepnet') && !p.textContent.includes('guest@deepnet');
    }
    function notifyIPChange() {
        if (!settings.sound) return;
        if (typeof beep === 'function') { beep(660, 100, 0.14); setTimeout(() => beep(880, 140, 0.14), 120); }
    }

    // ═══════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════
    let running = false, lastKnownIP = null, watcherActive = false;
    let currentTripwires = [];

    // ═══════════════════════════════════════════════════════════
    //  CORE ACTIONS
    // ═══════════════════════════════════════════════════════════
    async function refreshList() {
        const data = await api('tripwire_list');
        if (!data?.success) { logEvent('Failed to fetch list'); return []; }
        currentTripwires = Array.isArray(data.tripwires) ? data.tripwires : [];
        if (currentView === 'main') renderMain();
        return currentTripwires;
    }

    // Build a unique key for a slot to match against deployed tripwires
    function slotKey(s) { return `${s.trigger}|${s.action}`; }
    function twKey(tw) { return `${tw.trigger_event || tw.trigger || 'file_access'}|${tw.action_type || tw.type}`; }

    async function deployTripwires() {
        if (running) return;
        running = true; renderMain();
        const ip = getCurrentIP();
        if (!ip) { running = false; setStatus('error', 'No IP'); renderMain(); return; }

        setStatus('working', 'Listing...');
        await refreshList();

        // Remove stale (not on current IP)
        const stale = currentTripwires.filter(t => t.node_ip !== ip);
        if (stale.length > 0) {
            setStatus('working', `Removing ${stale.length}...`);
            for (const t of stale) {
                const r = await api('tripwire_remove', { tripwire_id: t.id });
                logEvent(r?.success ? `Removed #${t.id}` : `Failed rm #${t.id}`);
            }
            await refreshList();
        }

        // Deploy enabled slots that aren't already on current IP
        const onCurrent = currentTripwires.filter(t => t.node_ip === ip).map(twKey);
        const slots = getEnabledSlots();
        const needed = slots.filter(s => !onCurrent.includes(slotKey(s)));

        if (needed.length === 0) {
            setStatus('ready', 'All deployed');
            running = false; renderMain(); return;
        }

        setStatus('working', `Deploying ${needed.length}...`);
        for (const s of needed) {
            const payload = { node_ip: ip, trigger_event: s.trigger, action_type: s.action, trigger_type: s.action };
            payload.honeypot_armed = s.honeypot ? 1 : 0;
            const r = await api('tripwire_set', payload);
            if (r?.success) {
                logEvent(`Set ${s.action} [${s.trigger}]${s.honeypot ? ' +hp' : ''}`);
            } else {
                const err = r?.error || 'unknown';
                logEvent(`Failed: ${s.action} \u2014 ${err}`);
                if (/maximum|limit/i.test(err)) {
                    setStatus('error', 'Limit reached');
                    await refreshList(); running = false; renderMain(); return;
                }
            }
        }
        await refreshList();
        setStatus('ready', 'Deployed');
        running = false; renderMain();
    }

    async function clearAllTripwires() {
        if (running) return;
        running = true; renderMain();
        setStatus('working', 'Listing...');
        await refreshList();
        if (currentTripwires.length === 0) {
            setStatus('idle', 'None to clear'); running = false; renderMain(); return;
        }
        setStatus('working', `Clearing ${currentTripwires.length}...`);
        for (const t of currentTripwires) {
            const r = await api('tripwire_remove', { tripwire_id: t.id });
            logEvent(r?.success ? `Removed #${t.id}` : `Failed rm #${t.id}`);
        }
        await refreshList();
        setStatus('idle', 'Cleared');
        running = false; renderMain();
    }

    // ═══════════════════════════════════════════════════════════
    //  IP CHANGE WATCHER
    // ═══════════════════════════════════════════════════════════
    function startWatcher() {
        if (watcherActive) return;
        watcherActive = true;
        setInterval(() => {
            if (!isLoggedIn() || running || !machineId || !token) return;
            const ip = getCurrentIP();
            if (!ip) return;
            if (lastKnownIP === null) { lastKnownIP = ip; }
            else if (ip !== lastKnownIP) {
                notifyIPChange();
                logEvent(`IP changed: ${lastKnownIP} \u2192 ${ip}`);
                lastKnownIP = ip;
            }
        }, 2000);
    }

    // ═══════════════════════════════════════════════════════════
    //  UI
    // ═══════════════════════════════════════════════════════════
    let panelEl = null, logLines = [], currentView = 'main';

    function logEvent(msg) {
        const ts = new Date().toLocaleTimeString('en-GB', { hour12: false }).slice(0, 5);
        logLines.push({ ts, msg });
        if (logLines.length > 30) logLines.shift();
        renderLog();
    }

    function setStatus(state, text) {
        const el = document.getElementById('dntw-status');
        if (el) { el.textContent = text || ''; el.className = `dntw-status dntw-s-${state}`; }
        const gfx = document.querySelector('.deepos-icon[data-app="dntw"] .deepos-icon-gfx');
        if (gfx) {
            gfx.style.color = state === 'working' ? 'var(--dos-flag-active)' :
                              state === 'ready' ? '#4a8f4a' :
                              state === 'error' ? '#8f4a4a' : 'var(--dos-icon-color)';
        }
    }

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            #dntw-panel {
                display: none; position: fixed; z-index: 6000; width: 420px;
                flex-direction: column;
                font-family: var(--dos-font, Consolas, "Courier New", monospace);
                font-size: var(--dos-font-sm, 12px);
                color: var(--dos-text, #b3b3b3);
                background: var(--dos-bg-window, #0a0a0a);
                border: 1px solid var(--dos-border, #222);
                box-shadow: 4px 4px 12px var(--dos-shadow, rgba(0,0,0,0.6));
                cursor: none;
                transform-origin: top left;
            }
            #dntw-panel.visible { display: flex; }
            .dntw-titlebar {
                display: flex; align-items: center; padding: 0 8px; height: 26px;
                background: var(--dos-tab-bg, #1a1a1a);
                border-bottom: 1px solid var(--dos-border, #222);
                cursor: none; flex-shrink: 0; gap: 6px;
            }
            .dntw-title {
                font-size: 11px; font-weight: normal; letter-spacing: 0.06em;
                text-transform: uppercase; color: var(--dos-text-label, #a3a3a3);
                flex: 1;
            }
            .dntw-hdr-btn {
                width: 14px; height: 14px;
                background: var(--dos-border, #222); border: 1px solid var(--dos-border-hi, #333);
                cursor: none; display: flex; align-items: center; justify-content: center;
                font-size: 10px; color: var(--dos-text-dim, #7a7a7a); line-height: 1;
            }
            .dntw-hdr-btn:hover { background: var(--dos-bg-hover); border-color: var(--dos-border-hi); color: var(--dos-text-hi); }
            .dntw-hdr-btn.close:hover { background: var(--dos-close-bg); border-color: var(--dos-close-border); }
            .dntw-body { padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }
            .dntw-info {
                display: flex; align-items: center; justify-content: space-between;
                padding: 6px 8px;
                background: var(--dos-bg-panel, #1a1a1a); border: 1px solid var(--dos-border-lo, #1a1a1a);
            }
            .dntw-ip { font-size: 12px; color: var(--dos-text-hi, #e0e0e0); letter-spacing: 0.04em; }
            .dntw-status { font-size: 11px; letter-spacing: 0.04em; }
            .dntw-s-idle { color: var(--dos-text-dim); }
            .dntw-s-working { color: var(--dos-flag-active, #884444); }
            .dntw-s-ready { color: #5a8f5a; }
            .dntw-s-error { color: #8f4a4a; }
            .dntw-list {
                border: 1px solid var(--dos-border-lo, #1a1a1a);
                background: var(--dos-bg-panel, #1a1a1a);
                max-height: 140px; overflow-y: auto;
            }
            .dntw-list-empty {
                padding: 8px; text-align: center;
                color: var(--dos-text-xdim, #696969); font-style: italic; font-size: 11px;
            }
            .dntw-tw-row {
                display: flex; align-items: center; padding: 3px 8px; font-size: 11px;
                border-bottom: 1px solid var(--dos-border-lo, #1a1a1a); gap: 8px;
            }
            .dntw-tw-row:last-child { border-bottom: none; }
            .dntw-tw-id { color: var(--dos-text-xdim); width: 28px; }
            .dntw-tw-ip { color: var(--dos-text); flex: 1; }
            .dntw-tw-type { color: var(--dos-accent, #666); font-size: 10px; }
            .dntw-tw-match { color: #5a8f5a; }
            .dntw-tw-stale { color: #8f5a5a; }
            .dntw-btns { display: flex; gap: 4px; }
            .dntw-btn {
                flex: 1; padding: 5px 0; text-align: center;
                font-family: inherit; font-size: 11px; font-weight: normal;
                letter-spacing: 0.06em; text-transform: uppercase;
                border: 1px solid var(--dos-border, #222);
                background: var(--dos-bg-panel, #1a1a1a);
                color: var(--dos-text-label, #a3a3a3);
                cursor: none; transition: background 0.15s, color 0.15s;
            }
            .dntw-btn:hover { background: var(--dos-bg-hover); color: var(--dos-text-hi); border-color: var(--dos-border-hi); }
            .dntw-btn:disabled { opacity: 0.4; pointer-events: none; }
            .dntw-btn.danger:hover { background: var(--dos-close-bg); border-color: var(--dos-close-border); }
            .dntw-btn.active { background: var(--dos-bg-selected); color: var(--dos-accent-hi, #999); border-color: var(--dos-accent, #666); }
            .dntw-log {
                border: 1px solid var(--dos-border-lo);
                background: var(--dos-bg, #0c0c0c);
                max-height: 80px; overflow-y: auto; font-size: 10px; padding: 4px 6px;
            }
            .dntw-log-line { color: var(--dos-text-dim); line-height: 1.5; }
            .dntw-log-ts { color: var(--dos-text-xdim); margin-right: 6px; }

            /* ── Settings: slot rows ── */
            .dntw-slots { display: flex; flex-direction: column; gap: 4px; }
            .dntw-slot-hdr {
                display: flex; gap: 4px; padding: 0 0 2px 0;
                margin-left: 22px;
                font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase;
                color: var(--dos-text-xdim);
            }
            .dntw-slot-hdr span { flex: 1; }
            .dntw-slot-hdr span:last-child { flex: 0 0 42px; text-align: center; }
            .dntw-slot-row {
                display: flex; align-items: center; gap: 4px;
            }
            .dntw-slot-row.disabled { opacity: 0.35; }
            .dntw-slot-en {
                width: 18px; height: 18px; flex-shrink: 0;
                border: 1px solid var(--dos-border-hi, #333);
                background: var(--dos-bg, #0c0c0c);
                display: flex; align-items: center; justify-content: center;
                font-size: 11px; color: var(--dos-accent-hi); cursor: none;
            }
            .dntw-slot-en:hover { border-color: var(--dos-accent); }
            .dntw-slot-en, .dntw-slot-hp, .dntw-hdr-btn, .dntw-btn { cursor: none; }
            .dntw-slot-sel {
                flex: 1; position: relative;
                font-family: inherit; font-size: 11px;
                background: var(--dos-bg-input, #1e1e1e);
                color: var(--dos-text);
                border: 1px solid var(--dos-border, #222);
                padding: 3px 4px;
                cursor: none;
                user-select: none;
            }
            .dntw-slot-sel:hover { border-color: var(--dos-border-hi); }
            .dntw-slot-sel.open { border-color: var(--dos-accent); }
            .dntw-slot-sel::after {
                content: '\u25BE'; position: absolute; right: 4px; top: 50%;
                transform: translateY(-50%); font-size: 10px; color: var(--dos-text-xdim);
                pointer-events: none;
            }
            .dntw-slot-menu {
                position: absolute; left: -1px; top: 100%;
                width: calc(100% + 2px);
                background: var(--dos-bg-input, #1e1e1e);
                border: 1px solid var(--dos-accent, #666);
                border-top: none;
                z-index: 9000;
                display: none;
                cursor: none;
            }
            .dntw-slot-sel.open .dntw-slot-menu { display: block; }
            .dntw-slot-opt {
                padding: 3px 4px;
                font-family: inherit; font-size: 11px;
                color: var(--dos-text);
                cursor: none;
            }
            .dntw-slot-opt:hover { background: var(--dos-bg-selected); color: var(--dos-text-hi); }
            .dntw-slot-opt.current { color: var(--dos-accent-hi); }
            .dntw-slot-hp {
                flex: 0 0 42px; text-align: center;
                font-family: inherit; font-size: 10px;
                padding: 3px 2px;
                border: 1px solid #663333;
                background: rgba(40,16,16,0.5);
                color: #c85a5a;
                cursor: none; user-select: none;
            }
            .dntw-slot-hp:hover { border-color: #884444; }
            .dntw-slot-hp.on {
                color: #3ddc84;
                border-color: #335533;
                background: rgba(16,40,16,0.5);
            }
            .dntw-slot-hp.on:hover { border-color: #448844; }
            .dntw-set-toggle {
                display: flex; align-items: center; gap: 8px;
                padding: 6px 8px;
                background: var(--dos-bg-panel, #1a1a1a);
                border: 1px solid var(--dos-border-lo, #1a1a1a);
                cursor: none;
            }
            .dntw-set-toggle:hover { border-color: var(--dos-border-hi); }
            .dntw-set-toggle-box {
                width: 14px; height: 14px; flex-shrink: 0;
                border: 1px solid var(--dos-border-hi, #333);
                background: var(--dos-bg, #0c0c0c);
                display: flex; align-items: center; justify-content: center;
                font-size: 11px; color: var(--dos-accent-hi);
            }
            .dntw-set-toggle.on { border-color: var(--dos-accent); }
            .dntw-set-toggle.on .dntw-set-toggle-box { border-color: var(--dos-accent); }
            .dntw-set-toggle-label { font-size: 11px; color: var(--dos-text); flex: 1; }
            .dntw-set-toggle-hint { font-size: 10px; color: var(--dos-text-xdim); }
            .dntw-set-section {
                margin-top: 4px;
                font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
                color: var(--dos-text-xdim); margin-bottom: 4px;
            }
            .dntw-scale-row {
                display: flex; align-items: center; gap: 4px;
            }
            .dntw-scale-btn {
                width: 22px; height: 22px;
                background: var(--dos-bg-panel); border: 1px solid var(--dos-border);
                color: var(--dos-text-label); font-size: 13px; font-family: inherit;
                display: flex; align-items: center; justify-content: center;
                cursor: none;
            }
            .dntw-scale-btn:hover { border-color: var(--dos-border-hi); color: var(--dos-text-hi); background: var(--dos-bg-hover); }
            .dntw-scale-label {
                font-size: 11px; color: var(--dos-text); min-width: 90px;
                text-align: center; letter-spacing: 0.04em;
            }

            #dntw-cli-btn {
                display: none; min-width: 18px; padding: 1px 5px;
                text-align: center; font-weight: bold; font-size: 13px; font-family: inherit;
                color: #9cf7f7; border: 1px solid #4a8f8f; background: rgba(12,42,42,0.65);
                cursor: pointer; letter-spacing: 0.5px; white-space: nowrap;
            }
            #dntw-cli-btn:hover { background: rgba(20,60,60,0.8); border-color: #6abfbf; color: #bfffff; }
        `;
        document.head.appendChild(style);
    }

    function buildPanel() {
        panelEl = document.createElement('div');
        panelEl.id = 'dntw-panel';
        panelEl.innerHTML = `
            <div class="dntw-titlebar">
                <span class="dntw-title">Tripwire</span>
                <div class="dntw-hdr-btn" id="dntw-settings-btn" title="Settings">\u2699</div>
                <div class="dntw-hdr-btn close" id="dntw-close">\u00D7</div>
            </div>
            <div class="dntw-body" id="dntw-body"></div>`;
        document.body.appendChild(panelEl);
        makePanelDraggable(panelEl, panelEl.querySelector('.dntw-titlebar'));
        document.getElementById('dntw-close').addEventListener('click', hidePanel);
        document.getElementById('dntw-settings-btn').addEventListener('click', () => {
            switchView(currentView === 'settings' ? 'main' : 'settings');
        });
    }

    function switchView(view) {
        currentView = view;
        if (view === 'main') renderMain(); else renderSettings();
        const btn = document.getElementById('dntw-settings-btn');
        if (btn) btn.style.color = view === 'settings' ? 'var(--dos-accent-hi)' : '';
    }

    // ── Main view ──
    function renderMain() {
        const body = document.getElementById('dntw-body');
        if (!body || currentView !== 'main') return;
        const ip = getCurrentIP() || '--';
        body.innerHTML = `
            <div class="dntw-info">
                <span class="dntw-ip" id="dntw-ip">${ip}</span>
                <span class="dntw-status dntw-s-idle" id="dntw-status">idle</span>
            </div>
            <div class="dntw-list" id="dntw-list"></div>
            <div class="dntw-btns">
                <button class="dntw-btn" id="dntw-deploy" ${running?'disabled':''}>Deploy</button>
                <button class="dntw-btn danger" id="dntw-clear" ${running?'disabled':''}>Clear All</button>
            </div>
            <div class="dntw-log" id="dntw-log"></div>`;

        const listEl = document.getElementById('dntw-list');
        if (currentTripwires.length === 0) {
            listEl.innerHTML = '<div class="dntw-list-empty">No tripwires</div>';
        } else {
            const curIp = getCurrentIP();
            for (const tw of currentTripwires) {
                const twIp = tw.node_ip || tw.ip;
                const row = document.createElement('div');
                row.className = 'dntw-tw-row';
                row.innerHTML =
                    `<span class="dntw-tw-id">#${tw.id}</span>` +
                    `<span class="dntw-tw-ip ${twIp===curIp?'dntw-tw-match':'dntw-tw-stale'}">${twIp}</span>` +
                    `<span class="dntw-tw-type">${tw.action_type||tw.type||'?'}</span>`;
                listEl.appendChild(row);
            }
        }

        document.getElementById('dntw-deploy').addEventListener('click', () => { if (!running) deployTripwires(); });
        document.getElementById('dntw-clear').addEventListener('click', () => { if (!running) clearAllTripwires(); });
        renderLog();
    }

    // ── Custom dropdown (no native <select>, preserves game cursor) ──
    let openDropdown = null;

    function closeAllDropdowns() {
        if (openDropdown) { openDropdown.classList.remove('open'); openDropdown = null; }
    }

    document.addEventListener('mousedown', (e) => {
        if (openDropdown && !openDropdown.contains(e.target)) closeAllDropdowns();
    });

    function makeDropdown(options, selected, disabled, onChange) {
        const wrap = document.createElement('div');
        wrap.className = 'dntw-slot-sel';
        if (disabled) { wrap.style.opacity = '0.35'; wrap.style.pointerEvents = 'none'; }

        const label = document.createElement('span');
        label.textContent = selected;
        wrap.appendChild(label);

        const menu = document.createElement('div');
        menu.className = 'dntw-slot-menu';
        for (const opt of options) {
            const item = document.createElement('div');
            item.className = 'dntw-slot-opt' + (opt === selected ? ' current' : '');
            item.textContent = opt;
            item.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                label.textContent = opt;
                closeAllDropdowns();
                onChange(opt);
            });
            menu.appendChild(item);
        }
        wrap.appendChild(menu);

        wrap.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            if (wrap.classList.contains('open')) {
                closeAllDropdowns();
            } else {
                closeAllDropdowns();
                wrap.classList.add('open');
                openDropdown = wrap;
            }
        });

        return wrap;
    }

    function renderSettings() {
        const body = document.getElementById('dntw-body');
        if (!body) return;
        closeAllDropdowns();
        const scaleLabel = settings.uiScale === 0 ? `Auto (${Math.round(getScale() * 100)}%)` : `${Math.round(settings.uiScale * 100)}%`;
        body.innerHTML = `
            <div class="dntw-set-section">Tripwire Slots (${getEnabledSlots().length} of ${MAX_SLOTS} active)</div>
            <div class="dntw-slot-hdr">
                <span>Trigger</span>
                <span>Action</span>
                <span>HP</span>
            </div>
            <div class="dntw-slots" id="dntw-slots"></div>
            <div class="dntw-set-section" style="margin-top:6px">Notifications</div>
            <div class="dntw-slot-row" id="dntw-snd-row">
                <div class="dntw-slot-en" id="dntw-snd-chk">${settings.sound ? '\u2713' : ''}</div>
                <span style="font-size:11px;color:var(--dos-text)">IP change sound alert</span>
            </div>
            <div class="dntw-set-section" style="margin-top:6px">UI Scale</div>
            <div class="dntw-scale-row" id="dntw-scale-row">
                <div class="dntw-scale-btn" id="dntw-sc-down">\u2212</div>
                <span class="dntw-scale-label" id="dntw-sc-label">${scaleLabel}</span>
                <div class="dntw-scale-btn" id="dntw-sc-up">+</div>
                <div class="dntw-scale-btn" id="dntw-sc-auto" style="margin-left:4px;width:auto;padding:0 6px;${settings.uiScale===0?'color:var(--dos-accent-hi);border-color:var(--dos-accent)':''}">Auto</div>
            </div>`;

        const container = document.getElementById('dntw-slots');
        settings.slots.forEach((slot, i) => {
            const row = document.createElement('div');
            row.className = `dntw-slot-row${slot.enabled ? '' : ' disabled'}`;

            // Enable checkbox
            const en = document.createElement('div');
            en.className = 'dntw-slot-en';
            en.textContent = slot.enabled ? '\u2713' : '';
            en.addEventListener('click', () => {
                slot.enabled = !slot.enabled;
                saveSettings();
                renderSettings();
            });

            // Trigger dropdown
            const trigDrop = makeDropdown(TRIGGERS, slot.trigger, !slot.enabled, (val) => {
                slot.trigger = val;
                saveSettings();
            });

            // Action dropdown
            const actDrop = makeDropdown(ACTIONS, slot.action, !slot.enabled, (val) => {
                slot.action = val;
                saveSettings();
            });

            // Honeypot toggle
            const hp = document.createElement('div');
            hp.className = `dntw-slot-hp${slot.honeypot ? ' on' : ''}`;
            hp.textContent = slot.honeypot ? 'ON' : 'OFF';
            if (!slot.enabled) hp.style.pointerEvents = 'none';
            hp.addEventListener('click', () => {
                slot.honeypot = !slot.honeypot;
                saveSettings();
                renderSettings();
            });

            row.appendChild(en);
            row.appendChild(trigDrop);
            row.appendChild(actDrop);
            row.appendChild(hp);
            container.appendChild(row);
        });

        // Sound toggle
        document.getElementById('dntw-snd-chk').addEventListener('click', () => {
            settings.sound = !settings.sound;
            saveSettings();
            renderSettings();
        });

        // Scale controls
        document.getElementById('dntw-sc-down').addEventListener('click', () => {
            const cur = settings.uiScale || getScale();
            settings.uiScale = Math.max(0.8, Math.round((cur - 0.1) * 10) / 10);
            saveSettings(); applyScale(); renderSettings();
        });
        document.getElementById('dntw-sc-up').addEventListener('click', () => {
            const cur = settings.uiScale || getScale();
            settings.uiScale = Math.min(2.0, Math.round((cur + 0.1) * 10) / 10);
            saveSettings(); applyScale(); renderSettings();
        });
        document.getElementById('dntw-sc-auto').addEventListener('click', () => {
            settings.uiScale = 0;
            saveSettings(); applyScale(); renderSettings();
        });
    }

    function renderLog() {
        const el = document.getElementById('dntw-log');
        if (!el) return;
        el.innerHTML = '';
        for (const l of logLines) {
            const div = document.createElement('div');
            div.className = 'dntw-log-line';
            div.innerHTML = `<span class="dntw-log-ts">${l.ts}</span>${l.msg}`;
            el.appendChild(div);
        }
        el.scrollTop = el.scrollHeight;
    }

    function centerPanel() {
        if (!panelEl) return;
        const s = getScale();
        const pw = 420 * s;
        const ph = panelEl.offsetHeight * s || 300 * s;
        panelEl.style.left = Math.max(0, (window.innerWidth - pw) / 2) + 'px';
        panelEl.style.top = Math.max(0, (window.innerHeight - ph) / 2) + 'px';
        panelEl.style.transform = `scale(${s})`;
        delete panelEl.dataset.dragged;
    }

    function showPanel() {
        if (!panelEl) buildPanel();
        panelEl.classList.add('visible');
        currentView = 'main'; renderMain();
        requestAnimationFrame(() => centerPanel());
        if (!running && machineId && token) {
            refreshList();
        }
    }

    function hidePanel() { if (panelEl) panelEl.classList.remove('visible'); }

    function makePanelDraggable(el, handle) {
        let ox, oy, dx, dy;
        handle.addEventListener('mousedown', (e) => {
            if (e.target.closest('.dntw-hdr-btn')) return;
            const rect = el.getBoundingClientRect();
            const s = getScale();
            // Convert visual rect back to unscaled position
            dx = rect.left / 1; dy = rect.top / 1;
            // Set explicit position, keep scale
            el.style.left = (rect.left) + 'px';
            el.style.top = (rect.top) + 'px';
            el.style.transform = `scale(${s})`;
            el.dataset.dragged = '1';
            ox = e.clientX; oy = e.clientY;
            const mv = (e2) => {
                el.style.left = (dx + e2.clientX - ox) + 'px';
                el.style.top = (dy + e2.clientY - oy) + 'px';
            };
            const up = () => { document.removeEventListener('mousemove',mv); document.removeEventListener('mouseup',up); };
            document.addEventListener('mousemove',mv); document.addEventListener('mouseup',up);
            e.preventDefault();
        });
    }

    // ═══════════════════════════════════════════════════════════
    //  DESKTOP ICON + CLI FALLBACK
    // ═══════════════════════════════════════════════════════════
    let sawDeepOSPending = false, isDesktopIcon = false, cliBtnEl = null;
    const ICON_POS_KEY = 'deepos_icon_positions';
    function isDeepOSPending() {
        const p = window._deeposBootPending || document.body.classList.contains('deepos-active') || (window._DOS&&window._DOS.active);
        if (p) sawDeepOSPending = true; return p || sawDeepOSPending;
    }
    function loadIconPositions() { try { return JSON.parse(localStorage.getItem(ICON_POS_KEY))||{}; } catch(_){return {};} }
    function saveIconPositions() {
        const p={}; document.querySelectorAll('#deepos-icons .deepos-icon').forEach(i=>{
            const id=i.dataset.app||i.dataset.intApp||i.dataset.sysApp;
            if(id&&i.style.left) p[id]={x:parseInt(i.style.left)||0,y:parseInt(i.style.top)||0};
        }); try{localStorage.setItem(ICON_POS_KEY,JSON.stringify(p));}catch(_){}
    }
    function calcIconSlot(idx) {
        const rem=parseFloat(getComputedStyle(document.documentElement).fontSize)||16, vw=window.innerWidth/100;
        const w=Math.min(6*rem,Math.max(3.8*rem,5.2*vw)), gh=Math.min(3.7*rem,Math.max(2.1*rem,3.3*vw));
        const ch=gh+2.4*rem, mr=Math.max(1,Math.floor((window.innerHeight-40)/ch));
        return {x:0.3*rem+Math.floor(idx/mr)*w, y:0.3*rem+(idx%mr)*ch};
    }
    function applyIconPos(icon,id) {
        const s=loadIconPositions(); icon.style.position='absolute';
        if(s[id]){icon.style.left=s[id].x+'px';icon.style.top=s[id].y+'px';}
        else{const p=calcIconSlot(document.querySelectorAll('#deepos-icons .deepos-icon').length);icon.style.left=p.x+'px';icon.style.top=p.y+'px';}
    }
    function makeIconDraggable(icon) {
        let ox=0,oy=0,d=false,m=false,w=false;
        icon.addEventListener('mousedown',e=>{if(e.button)return;d=true;m=false;ox=e.clientX-(parseInt(icon.style.left)||0);oy=e.clientY-(parseInt(icon.style.top)||0);e.preventDefault();});
        document.addEventListener('mousemove',e=>{if(!d)return;if(!m&&Math.abs(e.clientX-(ox+parseInt(icon.style.left||0)))<3&&Math.abs(e.clientY-(oy+parseInt(icon.style.top||0)))<3)return;m=true;const p=icon.parentElement.getBoundingClientRect();icon.style.left=Math.max(0,Math.min(e.clientX-ox,p.width-icon.offsetWidth))+'px';icon.style.top=Math.max(0,Math.min(e.clientY-oy,p.height-icon.offsetHeight))+'px';});
        document.addEventListener('mouseup',()=>{if(!d)return;if(m){saveIconPositions();w=true;setTimeout(()=>{w=false;},400);}d=false;m=false;});
        return ()=>w;
    }
    function placeUI() {
        if(isDesktopIcon||(cliBtnEl&&cliBtnEl.parentElement))return true;
        const icons=document.querySelector('#deepos-icons');
        if(icons){
            const icon=document.createElement('div');icon.className='deepos-icon';icon.dataset.app='dntw';
            icon.innerHTML='<div class="deepos-icon-gfx" style="background:var(--dos-icon-bg);color:var(--dos-icon-color);font-size:clamp(0.6rem,1vw,1.1rem);font-weight:bold;letter-spacing:0.05em;">TW</div><span>Tripwire</span>';
            applyIconPos(icon,'dntw');const chk=makeIconDraggable(icon);
            icon.addEventListener('dblclick',()=>{if(!chk())showPanel();});
            icons.appendChild(icon);isDesktopIcon=true;return true;
        }
        if(isDeepOSPending())return false;
        cliBtnEl=document.createElement('span');cliBtnEl.id='dntw-cli-btn';cliBtnEl.textContent='TW';cliBtnEl.title='Tripwire Manager';
        cliBtnEl.addEventListener('click',showPanel);
        const sr=document.querySelector('#status-right'),sb=document.querySelector('#statusbar');
        if(sr&&sb)sb.insertBefore(cliBtnEl,sr);else if(sb)sb.appendChild(cliBtnEl);else return false;
        return true;
    }

    // ═══════════════════════════════════════════════════════════
    //  BOOTSTRAP
    // ═══════════════════════════════════════════════════════════
    function init() {
        injectStyles();
        const bc=setInterval(()=>{
            if(!isLoggedIn())return;if(!placeUI())return;
            clearInterval(bc);
            if(cliBtnEl)cliBtnEl.style.display='inline-block';
            console.log('[TW] v3.4 placed as',isDesktopIcon?'icon':'cli');
            startWatcher();
        },500);
    }
    setTimeout(init,2000);
})();
