// ==UserScript==
// @name         DeepNet Dossier
// @namespace    https://macinsight.github.io/deepwiki/modding/
// @version      2.0.0
// @description  Player dossier viewer for DeepNet — paginated panel (WM-managed)
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
    function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function heatColor(l) { l = String(l).toLowerCase(); return l === 'cold' || l === 'cool' ? '#3ddc84' : l === 'warm' ? '#c8a84b' : '#c85a5a'; }
    function tierColor(t) { return t >= 3 ? '#a335ee' : t >= 2 ? '#0070dd' : t >= 1 ? '#3ddc84' : 'var(--dos-text-dim)'; }
    function expColor(e) { e = String(e).toUpperCase(); return e === 'LOW' || e === 'MINIMAL' ? '#3ddc84' : e === 'ELEVATED' || e === 'MODERATE' ? '#c8a84b' : '#c85a5a'; }
    function kv(k, v) { return `<div class="dn-row"><span class="dn-k">${esc(k)}</span><span class="dn-v">${v}</span></div>`; }

    // ═══════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════
    let panel = null, tabsWrap = null;
    let dossier = null, loading = false, currentTab = 'profile';
    const TABS = [
        { key: 'profile', label: 'Profile' },
        { key: 'shadow',  label: 'Shadow' },
        { key: 'social',  label: 'Social' },
        { key: 'world',   label: 'World' },
    ];

    // ═══════════════════════════════════════════════════════════
    //  CONTENT-SPECIFIC STYLES
    // ═══════════════════════════════════════════════════════════
    function injectStyles() {
        const s = document.createElement('style');
        s.textContent = `
            .dndos-attr{display:flex;align-items:center;gap:6px;padding:2px 0;font-size:11px}
            .dndos-attr-lbl{color:var(--dos-text-dim);width:70px;text-transform:capitalize;flex-shrink:0}
            .dndos-attr-bar{flex:1;height:4px;background:var(--dos-border-lo)}.dndos-attr-fill{height:100%;background:var(--dos-accent-hi,#888)}
            .dndos-attr-val{color:var(--dos-text);width:30px;text-align:right;font-size:11px}
            .dndos-cat{display:flex;gap:8px;padding:3px 6px;font-size:11px;border:1px solid var(--dos-border-lo);background:var(--dos-bg-panel);margin-bottom:2px;align-items:center}
            .dndos-cat-name{flex:1;color:var(--dos-text);text-transform:capitalize}
            .dndos-cat-hacks{color:var(--dos-text-dim);font-size:10px}.dndos-cat-tier{font-size:10px;font-weight:bold}.dndos-cat-warn{color:#c8a84b;font-size:9px}
            .dndos-npc{display:flex;justify-content:space-between;padding:2px 6px;font-size:11px;border-bottom:1px solid var(--dos-border-lo)}
            .dndos-npc:last-child{border-bottom:none}.dndos-npc-name{color:var(--dos-text);text-transform:capitalize}.dndos-npc-lbl{color:var(--dos-text-dim);font-size:10px}
            .dndos-act{padding:4px 6px;margin-bottom:2px;border:1px solid var(--dos-border-lo);background:var(--dos-bg-panel);font-size:11px}
            .dndos-act-cmd{color:#3ddc84;font-weight:bold;font-size:10px}.dndos-act-why{color:var(--dos-text-dim);margin-top:1px}
        `;
        document.head.appendChild(s);
    }

    // ═══════════════════════════════════════════════════════════
    //  RENDER: TABS
    // ═══════════════════════════════════════════════════════════
    function renderTabs() {
        if (!tabsWrap) return;
        tabsWrap.innerHTML = `<div class="dn-tabs">${TABS.map((t, i) =>
            `<button class="dn-tab${t.key === currentTab ? ' active' : ''}" data-tab="${t.key}">${i + 1}. ${t.label}</button>`
        ).join('')}</div>`;
        tabsWrap.querySelectorAll('.dn-tab').forEach(btn => {
            btn.addEventListener('click', () => { currentTab = btn.dataset.tab; renderTabs(); renderMain(panel.body); });
        });
    }

    // ═══════════════════════════════════════════════════════════
    //  RENDER: MAIN VIEW (dispatches to sub-pages)
    // ═══════════════════════════════════════════════════════════
    function renderMain(body) {
        if (!body || panel?.getView() !== 'main') return;
        if (tabsWrap) tabsWrap.style.display = '';
        renderTabs();

        if (loading) { body.innerHTML = '<div class="dn-loading">Fetching dossier...</div>'; return; }
        if (!dossier) {
            body.innerHTML = '<div class="dn-loading">No data</div><button class="dn-btn" id="dndos-refresh" style="width:100%;margin-top:8px">Refresh</button>';
            document.getElementById('dndos-refresh')?.addEventListener('click', fetchAndRender);
            return;
        }
        const renderers = { profile: renderProfile, shadow: renderShadow, social: renderSocial, world: renderWorld };
        const fn = renderers[currentTab]; if (fn) fn(body);
    }

    function renderProfile(body) {
        const p = dossier.profile || {}, rec = dossier.recognition || {}, sp = dossier.specialization || {};
        const attrs = p.attributes || {};
        let html = `<div class="dn-sec">Operator</div>`;
        html += kv('Level', `<span style="color:var(--dos-text-hi)">${p.level} \u2014 ${esc(p.level_title)}</span>`);
        html += kv('Hacks Completed', p.hacks_completed);
        html += kv('Defense', `${esc(p.pvp_mastery_title)} [${p.pvp_mastery_level}]`);
        html += kv('Recognition', `${esc(rec.label)} (${rec.score})`);
        html += kv('Identity', esc(dossier.identity || ''));
        html += `<div class="dn-sec">Attributes</div>`;
        for (const [key, val] of Object.entries(attrs)) {
            const v = Number(val), pct = Math.min(100, (v / 5) * 100);
            html += `<div class="dndos-attr"><span class="dndos-attr-lbl">${esc(key)}</span><div class="dndos-attr-bar"><div class="dndos-attr-fill" style="width:${pct}%"></div></div><span class="dndos-attr-val">${v.toFixed(1)}</span></div>`;
        }
        html += `<div class="dn-sec">Specialization</div>`;
        html += kv('Status', esc(sp.status || ''));
        html += kv('Top Category', `${esc((sp.top_category || '').toUpperCase())} (${sp.top_ratio ? Math.round(sp.top_ratio * 100) : 0}%)`);
        html += kv('Total Hacks', sp.total_hacks || 0);
        const pw = dossier.pathways || {};
        html += `<div class="dn-sec">Neural Pathways</div>`;
        html += kv('Active Nodes', pw.active_nodes?.join(', ') || 'None');
        html += kv('Training', `${pw.training_placed || 0}/${pw.training_total || 0} placed`);
        html += '<button class="dn-btn" id="dndos-refresh" style="width:100%;margin-top:8px">Refresh</button>';
        body.innerHTML = html;
        document.getElementById('dndos-refresh')?.addEventListener('click', fetchAndRender);
    }

    function renderShadow(body) {
        const h = dossier.heat || {}, s = dossier.shadow || {};
        let html = `<div class="dn-sec">Heat Status</div>`;
        html += kv('Heat', `<span style="color:${heatColor(h.level)}">${esc(String(h.level || '').toUpperCase())}</span> (${h.score || 0}/200)`);
        html += kv('Loot Mult', `${h.loot_mult || 1}x`);
        if (h.fw_bonus) html += kv('FW Bonus', h.fw_bonus);
        if (h.deal_penalty) html += kv('Deal Penalty', `<span style="color:#c85a5a">${h.deal_penalty}</span>`);
        html += kv('Private Access', h.private_access ? 'Yes' : 'No');
        html += `<div class="dn-sec">Shadow Profile</div>`;
        html += kv('Exposure', `<span style="color:${expColor(s.exposure)}">${esc(s.exposure || '')}</span>`);
        html += kv('Overall Tier', s.overall_tier || 0);
        html += kv('Burns', s.burns > 0 ? `<span style="color:#c85a5a">${s.burns}</span>` : '0');
        html += kv('Codename', s.codename || '(none)');
        if (s.categories?.length) {
            html += `<div class="dn-sec">Categories</div>`;
            for (const cat of s.categories) {
                const tc = tierColor(cat.tier);
                html += `<div class="dndos-cat"><span class="dndos-cat-name">${esc(cat.name)}</span><span class="dndos-cat-hacks">${cat.hack_count} hacks</span><span class="dndos-cat-tier" style="color:${tc}">mk${cat.tier}</span>${cat.field_status ? `<span class="dndos-cat-warn">\u26A0 ${esc(cat.field_status)}</span>` : ''}</div>`;
            }
        }
        html += '<button class="dn-btn" id="dndos-refresh" style="width:100%;margin-top:8px">Refresh</button>';
        body.innerHTML = html;
        document.getElementById('dndos-refresh')?.addEventListener('click', fetchAndRender);
    }

    function renderSocial(body) {
        const cr = dossier.crew || {}, f = dossier.faction || {}, g = dossier.group || {}, tr = dossier.trust || {};
        let html = `<div class="dn-sec">Crew</div>`;
        if (cr.name) { html += kv('Name', `${esc(cr.name)} [${esc(cr.tag)}]`); html += kv('Role', esc(cr.role || '')); html += kv('Members', cr.member_count || 0); html += kv('Pool', cr.pool || 0); }
        else html += kv('Status', 'No crew');
        html += `<div class="dn-sec">Group / Faction</div>`;
        html += kv('Group', esc(g.name || 'None'));
        if (g.focus) html += kv('Focus', esc(g.focus));
        html += kv('Faction', esc(f.name ? f.name.toUpperCase() : 'None'));
        if (f.fw_info) html += kv('FW Bonus', esc(f.fw_info));
        html += `<div class="dn-sec">Trust</div>`;
        html += kv('Net Rep', `${esc(tr.net_label || '')} (${tr.net_rep || 0})`);
        if (tr.npcs?.length) {
            for (const npc of tr.npcs) {
                html += `<div class="dndos-npc"><span class="dndos-npc-name">${esc(npc.npc?.replace(/_/g, ' ') || '')}</span><span class="dndos-npc-lbl">${esc(npc.label || '')} Lv.${npc.level}</span></div>`;
            }
        }
        html += '<button class="dn-btn" id="dndos-refresh" style="width:100%;margin-top:8px">Refresh</button>';
        body.innerHTML = html;
        document.getElementById('dndos-refresh')?.addEventListener('click', fetchAndRender);
    }

    function renderWorld(body) {
        const w = dossier.world || {}, sp = dossier.specialization || {};
        let html = `<div class="dn-sec">World State</div>`;
        html += kv('Geo State', esc(w.geo_state || ''));
        html += kv('Defense Mult', `${Math.round(((w.defense_mult || 1) - 1) * 100)}%`);
        html += kv('Yield Drift', `+${Math.round((w.loot_bias || 0) * 100)}%`);
        html += `<div class="dn-sec">Operator Pattern</div>`;
        html += kv('Status', esc(sp.status || ''));
        html += kv('Total Hacks', sp.total_hacks || 0);
        if (dossier.next_actions?.length) {
            html += `<div class="dn-sec">Suggested Actions</div>`;
            for (const a of dossier.next_actions) {
                html += `<div class="dndos-act"><div class="dndos-act-cmd">${esc(a.command)}</div><div class="dndos-act-why">${esc(a.reason)}</div></div>`;
            }
        }
        html += '<button class="dn-btn" id="dndos-refresh" style="width:100%;margin-top:8px">Refresh</button>';
        body.innerHTML = html;
        document.getElementById('dndos-refresh')?.addEventListener('click', fetchAndRender);
    }

    async function fetchAndRender() {
        loading = true; renderMain(panel.body);
        const data = await DN.wm.api('player_dossier');
        if (data?.success) dossier = data;
        loading = false; renderMain(panel.body);
    }

    // ═══════════════════════════════════════════════════════════
    //  RENDER: SETTINGS VIEW
    // ═══════════════════════════════════════════════════════════
    function renderSettings(body) {
        if (!body) return;
        if (tabsWrap) tabsWrap.style.display = 'none';
        body.innerHTML = '';
        DN.wm.renderScaleControls(body, () => renderSettings(body));
    }

    // ═══════════════════════════════════════════════════════════
    //  BOOTSTRAP
    // ═══════════════════════════════════════════════════════════
    function init() {
        injectStyles();

        panel = DN.wm.createPanel({
            id: 'dndos', title: 'Dossier', width: 480,
            onMain: renderMain,
            onSettings: renderSettings,
            onShow: fetchAndRender,
        });

        // Insert tabs wrapper between titlebar and body
        tabsWrap = document.createElement('div');
        tabsWrap.id = 'dndos-tabs-wrap';
        panel.el.insertBefore(tabsWrap, panel.body);

        // Keyboard nav for tabs
        document.addEventListener('keydown', (e) => {
            if (!panel.el.classList.contains('visible') || panel.getView() !== 'main') return;
            if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
            const idx = TABS.findIndex(t => t.key === currentTab);
            if (e.key === 'ArrowLeft' && idx > 0) { currentTab = TABS[idx - 1].key; renderMain(panel.body); e.preventDefault(); }
            else if (e.key === 'ArrowRight' && idx < TABS.length - 1) { currentTab = TABS[idx + 1].key; renderMain(panel.body); e.preventDefault(); }
            else if (e.key >= '1' && e.key <= String(TABS.length)) { currentTab = TABS[parseInt(e.key) - 1].key; renderMain(panel.body); e.preventDefault(); }
        });

        const ui = DN.wm.placeUI({
            key: 'dndos',
            icon: { glyph: 'DSR', label: 'Dossier' },
            cliBtn: { text: 'DSR', title: 'Dossier', style: { color: '#9cf79c', borderColor: '#4a8f4a', background: 'rgba(12,42,12,.65)' } },
            onOpen: () => panel.show(),
        });

        const bc = setInterval(() => {
            if (!DN.wm.isLoggedIn()) return;
            if (!ui.tryPlace()) return;
            clearInterval(bc); ui.showCliBtn();
            console.log('[DOSSIER] v2.0 mounted via WM');
        }, 500);
    }

    if (window.DN?.wm) setTimeout(init, 100);
    else window.addEventListener('dn-wm-ready', () => setTimeout(init, 100), { once: true });
})();
