// ==UserScript==
// @name         DeepNet Tripwire Manager
// @namespace    https://macinsight.github.io/deepwiki/modding/
// @version      4.0.0
// @description  Tripwire deployment UI for DeepNet — one-click deploy/clear, IP change alerts (WM-managed)
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
                s.slots.forEach(sl => { if (typeof sl.honeypot !== 'boolean') sl.honeypot = false; });
                if (typeof s.sound !== 'boolean') s.sound = true;
                return { slots: s.slots, sound: s.sound };
            }
        } catch (_) {}
        return { slots: defaultSlots(), sound: true };
    }
    function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {} }
    let settings = loadSettings();
    function getEnabledSlots() { return settings.slots.filter(s => s.enabled); }

    // ═══════════════════════════════════════════════════════════
    //  HELPERS
    // ═══════════════════════════════════════════════════════════
    function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function getCurrentIP() {
        for (const sel of ['#dos-ip', '#status-ip']) {
            const el = document.querySelector(sel);
            if (el) { const m = el.textContent.match(/(\d+\.\d+\.\d+\.\d+)/); if (m) return m[1]; }
        }
        return null;
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
    let panel = null; // WM handle
    let logLines = [];

    function logEvent(msg) {
        const ts = new Date().toLocaleTimeString('en-GB', { hour12: false }).slice(0, 5);
        logLines.push({ ts, msg }); if (logLines.length > 30) logLines.shift();
        renderLog();
    }
    function setStatus(state, text) {
        const el = document.getElementById('dntw-status');
        if (el) { el.textContent = text || ''; el.className = `dn-status dn-s-${state}`; }
    }

    // ═══════════════════════════════════════════════════════════
    //  CORE ACTIONS
    // ═══════════════════════════════════════════════════════════
    async function refreshList() {
        const data = await DN.wm.api('tripwire_list');
        if (!data?.success) { logEvent('Failed to fetch list'); return []; }
        currentTripwires = Array.isArray(data.tripwires) ? data.tripwires : [];
        if (panel?.getView() === 'main') renderMain(panel.body);
        return currentTripwires;
    }

    function slotKey(s) { return `${s.trigger}|${s.action}`; }
    function twKey(tw) { return `${tw.trigger_event || tw.trigger || 'file_access'}|${tw.action_type || tw.type}`; }

    async function deployTripwires() {
        if (running) return;
        running = true; renderMain(panel.body);
        const ip = getCurrentIP();
        if (!ip) { running = false; setStatus('error', 'No IP'); renderMain(panel.body); return; }

        setStatus('working', 'Listing...');
        await refreshList();

        const stale = currentTripwires.filter(t => t.node_ip !== ip);
        if (stale.length > 0) {
            setStatus('working', `Removing ${stale.length}...`);
            for (const t of stale) {
                const r = await DN.wm.api('tripwire_remove', { tripwire_id: t.id });
                logEvent(r?.success ? `Removed #${t.id}` : `Failed rm #${t.id}`);
            }
            await refreshList();
        }

        const onCurrent = currentTripwires.filter(t => t.node_ip === ip).map(twKey);
        const needed = getEnabledSlots().filter(s => !onCurrent.includes(slotKey(s)));
        if (needed.length === 0) { setStatus('ready', 'All deployed'); running = false; renderMain(panel.body); return; }

        setStatus('working', `Deploying ${needed.length}...`);
        for (const s of needed) {
            const payload = { node_ip: ip, trigger_event: s.trigger, action_type: s.action, trigger_type: s.action, honeypot_armed: s.honeypot ? 1 : 0 };
            const r = await DN.wm.api('tripwire_set', payload);
            if (r?.success) logEvent(`Set ${s.action} [${s.trigger}]${s.honeypot ? ' +hp' : ''}`);
            else {
                const err = r?.error || 'unknown';
                logEvent(`Failed: ${s.action} \u2014 ${err}`);
                if (/maximum|limit/i.test(err)) { setStatus('error', 'Limit reached'); await refreshList(); running = false; renderMain(panel.body); return; }
            }
        }
        await refreshList(); setStatus('ready', 'Deployed'); running = false; renderMain(panel.body);
    }

    async function clearAllTripwires() {
        if (running) return;
        running = true; renderMain(panel.body);
        setStatus('working', 'Listing...'); await refreshList();
        if (currentTripwires.length === 0) { setStatus('idle', 'None to clear'); running = false; renderMain(panel.body); return; }
        setStatus('working', `Clearing ${currentTripwires.length}...`);
        for (const t of currentTripwires) {
            const r = await DN.wm.api('tripwire_remove', { tripwire_id: t.id });
            logEvent(r?.success ? `Removed #${t.id}` : `Failed rm #${t.id}`);
        }
        await refreshList(); setStatus('idle', 'Cleared'); running = false; renderMain(panel.body);
    }

    // ═══════════════════════════════════════════════════════════
    //  IP CHANGE WATCHER
    // ═══════════════════════════════════════════════════════════
    function startWatcher() {
        if (watcherActive) return;
        watcherActive = true;
        setInterval(() => {
            if (!DN.wm.isLoggedIn() || running) return;
            const ip = getCurrentIP(); if (!ip) return;
            if (lastKnownIP === null) { lastKnownIP = ip; }
            else if (ip !== lastKnownIP) {
                notifyIPChange();
                logEvent(`IP changed: ${lastKnownIP} \u2192 ${ip}`);
                lastKnownIP = ip;
            }
        }, 2000);
    }

    // ═══════════════════════════════════════════════════════════
    //  CONTENT-SPECIFIC STYLES
    // ═══════════════════════════════════════════════════════════
    function injectStyles() {
        const s = document.createElement('style');
        s.textContent = `
            .dntw-ip{font-size:12px;color:var(--dos-text-hi,#e0e0e0);letter-spacing:.04em}
            .dntw-tw-row{display:flex;align-items:center;padding:3px 8px;font-size:11px;border-bottom:1px solid var(--dos-border-lo,#1a1a1a);gap:8px}
            .dntw-tw-row:last-child{border-bottom:none}
            .dntw-tw-id{color:var(--dos-text-xdim);width:28px}
            .dntw-tw-ip{color:var(--dos-text);flex:1}
            .dntw-tw-type{color:var(--dos-accent,#666);font-size:10px}
            .dntw-tw-match{color:#5a8f5a}.dntw-tw-stale{color:#8f5a5a}
            .dntw-slots{display:flex;flex-direction:column;gap:4px}
            .dntw-slot-hdr{display:flex;gap:4px;padding:0 0 2px 0;margin-left:22px;font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:var(--dos-text-xdim)}
            .dntw-slot-hdr span{flex:1}.dntw-slot-hdr span:last-child{flex:0 0 42px;text-align:center}
            .dntw-slot-row{display:flex;align-items:center;gap:4px}.dntw-slot-row.disabled{opacity:.35}
            .dntw-slot-en{width:18px;height:18px;flex-shrink:0;border:1px solid var(--dos-border-hi,#333);background:var(--dos-bg,#0c0c0c);display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--dos-accent-hi)}
            .dntw-slot-en:hover{border-color:var(--dos-accent)}
            .dntw-slot-sel{flex:1;position:relative;font-family:inherit;font-size:11px;background:var(--dos-bg-input,#1e1e1e);color:var(--dos-text);border:1px solid var(--dos-border,#222);padding:3px 4px;user-select:none}
            .dntw-slot-sel:hover{border-color:var(--dos-border-hi)}.dntw-slot-sel.open{border-color:var(--dos-accent)}
            .dntw-slot-sel::after{content:'\\25BE';position:absolute;right:4px;top:50%;transform:translateY(-50%);font-size:10px;color:var(--dos-text-xdim);pointer-events:none}
            .dntw-slot-menu{position:absolute;left:-1px;top:100%;width:calc(100% + 2px);background:var(--dos-bg-input,#1e1e1e);border:1px solid var(--dos-accent,#666);border-top:none;z-index:9000;display:none}
            .dntw-slot-sel.open .dntw-slot-menu{display:block}
            .dntw-slot-opt{padding:3px 4px;font-family:inherit;font-size:11px;color:var(--dos-text)}
            .dntw-slot-opt:hover{background:var(--dos-bg-selected);color:var(--dos-text-hi)}.dntw-slot-opt.current{color:var(--dos-accent-hi)}
            .dntw-slot-hp{flex:0 0 42px;text-align:center;font-family:inherit;font-size:10px;padding:3px 2px;border:1px solid #663333;background:rgba(40,16,16,.5);color:#c85a5a;user-select:none}
            .dntw-slot-hp:hover{border-color:#884444}
            .dntw-slot-hp.on{color:#3ddc84;border-color:#335533;background:rgba(16,40,16,.5)}.dntw-slot-hp.on:hover{border-color:#448844}
        `;
        document.head.appendChild(s);
    }

    // ═══════════════════════════════════════════════════════════
    //  RENDER: MAIN VIEW
    // ═══════════════════════════════════════════════════════════
    function renderMain(body) {
        if (!body || panel?.getView() !== 'main') return;
        const ip = getCurrentIP() || '--';
        body.innerHTML = `
            <div class="dn-info">
                <span class="dntw-ip">${ip}</span>
                <span class="dn-status dn-s-idle" id="dntw-status">idle</span>
            </div>
            <div class="dn-list" id="dntw-list"></div>
            <div style="display:flex;gap:4px">
                <button class="dn-btn" id="dntw-deploy" ${running?'disabled':''}>Deploy</button>
                <button class="dn-btn danger" id="dntw-clear" ${running?'disabled':''}>Clear All</button>
            </div>
            <div class="dn-log" id="dntw-log"></div>`;

        const listEl = document.getElementById('dntw-list');
        if (currentTripwires.length === 0) {
            listEl.innerHTML = '<div class="dn-list-empty">No tripwires</div>';
        } else {
            const curIp = getCurrentIP();
            for (const tw of currentTripwires) {
                const twIp = tw.node_ip || tw.ip;
                const row = document.createElement('div');
                row.className = 'dntw-tw-row';
                row.innerHTML = `<span class="dntw-tw-id">#${esc(tw.id)}</span><span class="dntw-tw-ip ${twIp===curIp?'dntw-tw-match':'dntw-tw-stale'}">${esc(twIp)}</span><span class="dntw-tw-type">${esc(tw.action_type||tw.type||'?')}</span>`;
                listEl.appendChild(row);
            }
        }

        document.getElementById('dntw-deploy').addEventListener('click', () => { if (!running) deployTripwires(); });
        document.getElementById('dntw-clear').addEventListener('click', () => { if (!running) clearAllTripwires(); });
        renderLog();
    }

    // ═══════════════════════════════════════════════════════════
    //  RENDER: SETTINGS VIEW
    // ═══════════════════════════════════════════════════════════
    let openDropdown = null;
    function closeAllDropdowns() { if (openDropdown) { openDropdown.classList.remove('open'); openDropdown = null; } }
    document.addEventListener('mousedown', (e) => { if (openDropdown && !openDropdown.contains(e.target)) closeAllDropdowns(); });

    function makeDropdown(options, selected, disabled, onChange) {
        const wrap = document.createElement('div');
        wrap.className = 'dntw-slot-sel';
        if (disabled) { wrap.style.opacity = '0.35'; wrap.style.pointerEvents = 'none'; }
        const label = document.createElement('span'); label.textContent = selected; wrap.appendChild(label);
        const menu = document.createElement('div'); menu.className = 'dntw-slot-menu';
        for (const opt of options) {
            const item = document.createElement('div');
            item.className = 'dntw-slot-opt' + (opt === selected ? ' current' : '');
            item.textContent = opt;
            item.addEventListener('mousedown', (e) => { e.stopPropagation(); label.textContent = opt; closeAllDropdowns(); onChange(opt); });
            menu.appendChild(item);
        }
        wrap.appendChild(menu);
        wrap.addEventListener('mousedown', (e) => { e.stopPropagation(); if (wrap.classList.contains('open')) closeAllDropdowns(); else { closeAllDropdowns(); wrap.classList.add('open'); openDropdown = wrap; } });
        return wrap;
    }

    function renderSettings(body) {
        if (!body) return;
        closeAllDropdowns();
        body.innerHTML = `
            <div class="dn-sec">Tripwire Slots (${getEnabledSlots().length} of ${MAX_SLOTS} active)</div>
            <div class="dntw-slot-hdr"><span>Trigger</span><span>Action</span><span>HP</span></div>
            <div class="dntw-slots" id="dntw-slots"></div>
            <div class="dn-sec" style="margin-top:6px">Notifications</div>
            <div style="display:flex;align-items:center;gap:8px;padding:3px 0">
                <div class="dn-chk" id="dntw-snd-chk">${settings.sound ? '\u2713' : ''}</div>
                <span style="font-size:11px;color:var(--dos-text)">IP change sound alert</span>
            </div>`;

        const container = document.getElementById('dntw-slots');
        settings.slots.forEach((slot) => {
            const row = document.createElement('div');
            row.className = `dntw-slot-row${slot.enabled ? '' : ' disabled'}`;

            const en = document.createElement('div'); en.className = 'dntw-slot-en'; en.textContent = slot.enabled ? '\u2713' : '';
            en.addEventListener('click', () => { slot.enabled = !slot.enabled; saveSettings(); renderSettings(body); });

            const trigDrop = makeDropdown(TRIGGERS, slot.trigger, !slot.enabled, (val) => { slot.trigger = val; saveSettings(); });
            const actDrop = makeDropdown(ACTIONS, slot.action, !slot.enabled, (val) => { slot.action = val; saveSettings(); });

            const hp = document.createElement('div');
            hp.className = `dntw-slot-hp${slot.honeypot ? ' on' : ''}`;
            hp.textContent = slot.honeypot ? 'ON' : 'OFF';
            if (!slot.enabled) hp.style.pointerEvents = 'none';
            hp.addEventListener('click', () => { slot.honeypot = !slot.honeypot; saveSettings(); renderSettings(body); });

            row.appendChild(en); row.appendChild(trigDrop); row.appendChild(actDrop); row.appendChild(hp);
            container.appendChild(row);
        });

        document.getElementById('dntw-snd-chk').addEventListener('click', () => {
            settings.sound = !settings.sound; saveSettings(); renderSettings(body);
        });

        DN.wm.renderScaleControls(body, () => renderSettings(body));
    }

    function renderLog() {
        const el = document.getElementById('dntw-log'); if (!el) return;
        el.innerHTML = '';
        for (const l of logLines) {
            const div = document.createElement('div'); div.className = 'dn-log-line';
            div.innerHTML = `<span class="dn-log-ts">${esc(l.ts)}</span>${esc(l.msg)}`;
            el.appendChild(div);
        }
        el.scrollTop = el.scrollHeight;
    }

    // ═══════════════════════════════════════════════════════════
    //  BOOTSTRAP
    // ═══════════════════════════════════════════════════════════
    function init() {
        injectStyles();

        panel = DN.wm.createPanel({
            id: 'dntw', title: 'Tripwire', width: 420,
            onMain: renderMain,
            onSettings: renderSettings,
            onShow: () => { if (!running) refreshList(); },
        });

        const ui = DN.wm.placeUI({
            key: 'dntw',
            icon: { glyph: 'TW', label: 'Tripwire' },
            cliBtn: { text: 'TW', title: 'Tripwire Manager', style: { color: '#9cf7f7', borderColor: '#4a8f8f', background: 'rgba(12,42,42,.65)' } },
            onOpen: () => panel.show(),
        });

        const bc = setInterval(() => {
            if (!DN.wm.isLoggedIn()) return;
            if (!ui.tryPlace()) return;
            clearInterval(bc);
            ui.showCliBtn();
            startWatcher();
            console.log('[TW] v4.0 mounted via WM');
        }, 500);
    }

    // Wait for WM
    if (window.DN?.wm) setTimeout(init, 100);
    else window.addEventListener('dn-wm-ready', () => setTimeout(init, 100), { once: true });
})();
