// ==UserScript==
// @name         DeepOS Icon Grid Snap
// @namespace    https://macinsight.github.io/deepwiki/modding/
// @version      1.0.0
// @description  Makes DeepOS desktop icons snap to a grid with swap-on-overlap
// @author       Rain
// @match        https://deepnet.us/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const ICON_POS_KEY = 'deepos_icon_positions';

    function getGrid() {
        const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        const vw = window.innerWidth / 100;
        const iconBoxW = Math.min(6.0 * rem, Math.max(3.8 * rem, 5.2 * vw));
        const iconGfxH = Math.min(3.7 * rem, Math.max(2.1 * rem, 3.3 * vw));
        return {
            cellW: iconBoxW,
            cellH: iconGfxH + 2.4 * rem,
            padX: 0.3 * rem,
            padY: 0.3 * rem
        };
    }

    function snapToGrid(x, y) {
        const g = getGrid();
        const col = Math.max(0, Math.round((x - g.padX) / g.cellW));
        const row = Math.max(0, Math.round((y - g.padY) / g.cellH));
        return { x: g.padX + col * g.cellW, y: g.padY + row * g.cellH };
    }

    function saveIconPositions() {
        const positions = {};
        document.querySelectorAll('#deepos-icons .deepos-icon').forEach(icon => {
            const id = icon.dataset.app || icon.dataset.intApp || icon.dataset.sysApp;
            if (id && icon.style.left) {
                positions[id] = { x: parseInt(icon.style.left) || 0, y: parseInt(icon.style.top) || 0 };
            }
        });
        try { localStorage.setItem(ICON_POS_KEY, JSON.stringify(positions)); } catch (_) {}
    }

    // Track which icon is being dragged and where it started
    let draggedIcon = null;
    let dragOrigin = null;

    // Capture mousedown on icons to track drag origin
    document.addEventListener('mousedown', (e) => {
        const icon = e.target.closest('#deepos-icons .deepos-icon');
        if (!icon || e.button !== 0) return;
        draggedIcon = icon;
        // Snapshot the snapped origin position before drag starts
        const x = parseInt(icon.style.left) || 0;
        const y = parseInt(icon.style.top) || 0;
        dragOrigin = snapToGrid(x, y);
    }, true);

    // On mouseup: snap the dragged icon, swap if it lands on another
    document.addEventListener('mouseup', () => {
        if (!draggedIcon) return;
        const movedIcon = draggedIcon;
        const origin = dragOrigin;
        draggedIcon = null;
        dragOrigin = null;

        requestAnimationFrame(() => {
            const icons = document.querySelectorAll('#deepos-icons .deepos-icon');
            if (!icons.length) return;

            // Where did the dragged icon land?
            const dropX = parseInt(movedIcon.style.left) || 0;
            const dropY = parseInt(movedIcon.style.top) || 0;
            const target = snapToGrid(dropX, dropY);

            // Did it actually move to a different cell?
            if (origin && target.x === origin.x && target.y === origin.y) {
                // Didn't move cells — just re-snap in place
                movedIcon.style.left = target.x + 'px';
                movedIcon.style.top = target.y + 'px';
                saveIconPositions();
                return;
            }

            // Check if another icon occupies the target cell
            let occupant = null;
            icons.forEach(icon => {
                if (icon === movedIcon) return;
                const snap = snapToGrid(parseInt(icon.style.left) || 0, parseInt(icon.style.top) || 0);
                if (snap.x === target.x && snap.y === target.y) {
                    occupant = icon;
                }
            });

            if (occupant && origin) {
                // Swap: move the occupant to the dragged icon's original cell
                occupant.style.left = origin.x + 'px';
                occupant.style.top = origin.y + 'px';
            }

            // Snap the dragged icon to the target cell
            movedIcon.style.left = target.x + 'px';
            movedIcon.style.top = target.y + 'px';

            saveIconPositions();
        });
    }, false);

    // Snap all icons on initial load
    function snapAllOnLoad() {
        const iconsDiv = document.querySelector('#deepos-icons');
        if (!iconsDiv || iconsDiv.children.length === 0 ||
            !document.body.classList.contains('deepos-active')) {
            setTimeout(snapAllOnLoad, 1000);
            return;
        }

        setTimeout(() => {
            const icons = document.querySelectorAll('#deepos-icons .deepos-icon');
            const occupied = new Map();

            icons.forEach(icon => {
                const x = parseInt(icon.style.left) || 0;
                const y = parseInt(icon.style.top) || 0;
                const snap = snapToGrid(x, y);
                const key = `${snap.x},${snap.y}`;

                if (occupied.has(key)) {
                    // Find nearest free cell
                    const g = getGrid();
                    const maxRows = Math.max(1, Math.floor((window.innerHeight - 40) / g.cellH));
                    const maxCols = Math.max(1, Math.floor(window.innerWidth / g.cellW));
                    let bestDist = Infinity;
                    for (let c = 0; c < maxCols; c++) {
                        for (let r = 0; r < maxRows; r++) {
                            const cx = g.padX + c * g.cellW;
                            const cy = g.padY + r * g.cellH;
                            if (!occupied.has(`${cx},${cy}`)) {
                                const dist = Math.abs(cx - snap.x) + Math.abs(cy - snap.y);
                                if (dist < bestDist) { bestDist = dist; snap.x = cx; snap.y = cy; }
                            }
                        }
                    }
                }

                occupied.set(`${snap.x},${snap.y}`, true);
                icon.style.left = snap.x + 'px';
                icon.style.top = snap.y + 'px';
            });

            saveIconPositions();
        }, 500);
    }

    setTimeout(snapAllOnLoad, 3000);
})();
