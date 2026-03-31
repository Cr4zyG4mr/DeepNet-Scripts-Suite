// ==UserScript==
// @name         DeepNet Data Dealer
// @namespace    https://macinsight.github.io/deepwiki/modding/
// @version      2.0.0
// @description  File management and bulk selling for DeepNet (WM-managed)
// @author       Rain
// @match        https://deepnet.us/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════════════
    //  HELPERS
    // ═══════════════════════════════════════════════════════════
    function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function qualityLabel(q) {
        const n = Number(q || 0);
        if (n >= 5) return { label: 'legendary', color: '#a335ee' };
        if (n >= 4) return { label: 'rare', color: '#0070dd' };
        if (n >= 3) return { label: 'magic', color: '#3ddc84' };
        return { label: 'normal', color: 'var(--dos-text-dim)' };
    }
    function timeLeft(expiresAt) {
        if (!expiresAt) return '';
        const ms = new Date(expiresAt + 'Z').getTime() - Date.now();
        if (ms <= 0) return 'expired';
        const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
        return `${h}h ${m}m`;
    }

    // ═══════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════
    let files = [], selected = new Set(), selling = false, totalEarned = 0;
    let panel = null, logLines = [];

    function logEvent(msg) {
        const ts = new Date().toLocaleTimeString('en-GB', { hour12: false }).slice(0, 5);
        logLines.push({ ts, msg }); if (logLines.length > 50) logLines.shift();
        renderLog();
    }
    function setStatus(state, text) {
        const el = document.getElementById('dnfs-status');
        if (el) { el.textContent = text || ''; el.className = `dn-status dn-s-${state}`; }
    }

    // ═══════════════════════════════════════════════════════════
    //  CORE ACTIONS
    // ═══════════════════════════════════════════════════════════
    async function refreshFiles() {
        const data = await DN.wm.api('get_files');
        if (!data?.success) { logEvent('Failed to fetch files'); return; }
        files = (data.files || []).filter(f => f.sellable && !f.sold && !f.expired);
        files.sort((a, b) => Number(b.value) - Number(a.value));
        const ids = new Set(files.map(f => f.id));
        for (const id of selected) { if (!ids.has(id)) selected.delete(id); }
        if (panel?.getView() === 'main') renderMain(panel.body);
    }

    async function sellSelected() {
        if (selling || selected.size === 0) return;
        selling = true; let earned = 0;
        const queue = files.filter(f => selected.has(f.id));
        renderMain(panel.body);
        for (let i = 0; i < queue.length; i++) {
            setStatus('working', `Selling ${i + 1}/${queue.length}...`);
            const r = await DN.wm.api('sell_file', { fileId: queue[i].id });
            if (r?.success) { const amt = Number(r.earned || 0); earned += amt; totalEarned += amt; logEvent(r.message || `Sold ${queue[i].filename} for ${amt} RCH`); }
            else logEvent(`Failed: ${queue[i].filename} \u2014 ${r?.error || 'unknown'}`);
        }
        selected.clear();
        setStatus('ready', `+${earned} RCH`);
        logEvent(`Batch complete: +${earned} RCH (session total: ${totalEarned})`);
        await refreshFiles(); selling = false; renderMain(panel.body);
    }

    // ═══════════════════════════════════════════════════════════
    //  CONTENT-SPECIFIC STYLES
    // ═══════════════════════════════════════════════════════════
    function injectStyles() {
        const s = document.createElement('style');
        s.textContent = `
            .dnfs-info-left{display:flex;gap:12px;align-items:center}
            .dnfs-info-count{font-size:11px;color:var(--dos-text)}.dnfs-info-value{font-size:11px;color:#3ddc84}
            .dnfs-file-hdr{display:flex;gap:6px;padding:3px 8px;font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:var(--dos-text-xdim);border-bottom:1px solid var(--dos-border-lo);margin-left:22px}
            .dnfs-file-hdr span:nth-child(1){flex:1}.dnfs-file-hdr span:nth-child(2){width:70px}.dnfs-file-hdr span:nth-child(3){width:50px;text-align:right}.dnfs-file-hdr span:nth-child(4){width:50px;text-align:right}
            .dnfs-file{display:flex;align-items:center;gap:6px;padding:3px 8px;font-size:11px;border-bottom:1px solid var(--dos-border-lo,#1a1a1a)}
            .dnfs-file:last-child{border-bottom:none}.dnfs-file:hover{background:var(--dos-bg-hover)}.dnfs-file.selected{background:var(--dos-bg-selected)}
            .dnfs-file-chk{width:14px;height:14px;flex-shrink:0;border:1px solid var(--dos-border-hi,#333);background:var(--dos-bg,#0c0c0c);display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--dos-accent-hi)}
            .dnfs-file.selected .dnfs-file-chk{border-color:var(--dos-accent)}
            .dnfs-file-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dos-text)}
            .dnfs-file-cat{width:70px;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
            .dnfs-file-val{width:50px;text-align:right;color:var(--dos-text-hi)}.dnfs-file-exp{width:50px;text-align:right;font-size:10px;color:var(--dos-text-xdim)}
        `;
        document.head.appendChild(s);
    }

    // ═══════════════════════════════════════════════════════════
    //  RENDER: MAIN VIEW
    // ═══════════════════════════════════════════════════════════
    function renderMain(body) {
        if (!body || panel?.getView() !== 'main') return;
        const sellableCount = files.length;
        const selectedValue = files.filter(f => selected.has(f.id)).reduce((s, f) => s + Number(f.value || 0), 0);

        body.innerHTML = `
            <div class="dn-info">
                <div class="dnfs-info-left">
                    <span class="dnfs-info-count">${selected.size} / ${sellableCount} files</span>
                    <span class="dnfs-info-value">${selectedValue > 0 ? selectedValue + ' RCH' : ''}</span>
                </div>
                <span class="dn-status dn-s-idle" id="dnfs-status">idle</span>
            </div>
            <div class="dnfs-file-hdr"><span>Filename</span><span>Category</span><span>Value</span><span>Expires</span></div>
            <div class="dn-list" id="dnfs-list" style="max-height:260px"></div>
            <div style="display:flex;gap:4px">
                <button class="dn-btn" id="dnfs-selall">Select All</button>
                <button class="dn-btn" id="dnfs-selnone">Select None</button>
                <button class="dn-btn" id="dnfs-refresh">Refresh</button>
                <button class="dn-btn sell" id="dnfs-sell" ${selling || selected.size === 0 ? 'disabled' : ''}>Sell (${selected.size})</button>
            </div>
            <div class="dn-log" id="dnfs-log"></div>`;

        const listEl = document.getElementById('dnfs-list');
        if (files.length === 0) {
            listEl.innerHTML = '<div class="dn-list-empty">No sellable files</div>';
        } else {
            for (const f of files) {
                const sel = selected.has(f.id), q = qualityLabel(f.quality);
                const row = document.createElement('div');
                row.className = `dnfs-file${sel ? ' selected' : ''}`;
                row.innerHTML =
                    `<div class="dnfs-file-chk">${sel ? '\u2713' : ''}</div>` +
                    `<span class="dnfs-file-name" style="color:${q.color}" title="${esc(f.filename)}">${esc(f.filename)}</span>` +
                    `<span class="dnfs-file-cat" style="color:var(--dos-text-xdim)">${esc(f.category || '')}</span>` +
                    `<span class="dnfs-file-val">${esc(f.value)}</span>` +
                    `<span class="dnfs-file-exp">${esc(timeLeft(f.expires_at))}</span>`;
                row.addEventListener('click', () => { if (selling) return; if (selected.has(f.id)) selected.delete(f.id); else selected.add(f.id); renderMain(body); });
                listEl.appendChild(row);
            }
        }

        document.getElementById('dnfs-selall').addEventListener('click', () => { files.forEach(f => selected.add(f.id)); renderMain(body); });
        document.getElementById('dnfs-selnone').addEventListener('click', () => { selected.clear(); renderMain(body); });
        document.getElementById('dnfs-refresh').addEventListener('click', () => { if (!selling) refreshFiles(); });
        document.getElementById('dnfs-sell').addEventListener('click', () => { if (!selling && selected.size > 0) sellSelected(); });
        renderLog();
    }

    // ═══════════════════════════════════════════════════════════
    //  RENDER: SETTINGS VIEW
    // ═══════════════════════════════════════════════════════════
    function renderSettings(body) {
        if (!body) return;
        body.innerHTML = '';
        DN.wm.renderScaleControls(body, () => renderSettings(body));
    }

    function renderLog() {
        const el = document.getElementById('dnfs-log'); if (!el) return;
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
            id: 'dnfs', title: 'Data Dealer', width: 480,
            onMain: renderMain,
            onSettings: renderSettings,
            onShow: () => { if (!selling) refreshFiles(); },
        });

        const ui = DN.wm.placeUI({
            key: 'dnfs',
            icon: { glyph: 'RCH', label: 'Dealer' },
            cliBtn: { text: 'SELL', title: 'Data Dealer', style: { color: '#9cf79c', borderColor: '#4a8f4a', background: 'rgba(12,42,12,.65)' } },
            onOpen: () => panel.show(),
        });

        const bc = setInterval(() => {
            if (!DN.wm.isLoggedIn()) return;
            if (!ui.tryPlace()) return;
            clearInterval(bc); ui.showCliBtn();
            console.log('[SELL] v2.0 mounted via WM');
        }, 500);
    }

    if (window.DN?.wm) setTimeout(init, 100);
    else window.addEventListener('dn-wm-ready', () => setTimeout(init, 100), { once: true });
})();
