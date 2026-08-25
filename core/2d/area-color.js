// ============================================================
// 3DG Map Tools — Feature Module 3: Area Colorizer (Đổi Màu Vùng)
// - Loads land-colors.json configuration with code, name, color & priority
// - Supports Star ⭐ favorite pinning (saves to localStorage and sorts to top)
// - Replicates 100% Ant Design Tooltip UI from design screenshots
// - Tab 1: "Theo loại đất" (List with search box, starred favorites, color swatches)
// - Tab 2: "Màu tự chọn" (5x8 Color palette grid, rainbow eyedropper, hex input)
// ============================================================

(function () {
    'use strict';

    function log() {}

    let landColorsData = [];
    let favoriteCodes = new Set();
    let colorPopoverEl = null;
    let currentColorHex = '#c026d3';

    // ===== LOAD JSON CONFIG & LOCALSTORAGE FAVORITES =====
    function loadFavoriteCodes() {
        try {
            const saved = localStorage.getItem('topo_favorite_land_codes');
            if (saved) {
                const arr = JSON.parse(saved);
                favoriteCodes = new Set(arr);
            }
        } catch (e) {}
    }

    function saveFavoriteCodes() {
        try {
            localStorage.setItem('topo_favorite_land_codes', JSON.stringify(Array.from(favoriteCodes)));
        } catch (e) {}
    }

    async function fetchLandColorsData() {
        if (landColorsData.length > 0) return landColorsData;

        loadFavoriteCodes();

        try {
            let baseUrl = document.documentElement.getAttribute('data-topo-extension-base-url') || window.__topoExtensionBaseUrl || '';
            if (!baseUrl && typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
                baseUrl = chrome.runtime.getURL('');
            }
            const url = baseUrl ? (baseUrl + 'color.json') : 'color.json';
            const res = await fetch(url);
            landColorsData = await res.json();
        } catch (e) {
            log('Fallback to hardcoded land colors:', e);
            landColorsData = [
                { code: 'CLN', name: 'Đất trồng cây lâu năm', color: '#ffd2a0', priority: 1 },
                { code: 'LUA', name: 'Đất trồng lúa', color: '#fffc82', priority: 1 },
                { code: 'ODT', name: 'Đất ở tại đô thị', color: '#ffa0ff', priority: 1 },
                { code: 'ONT', name: 'Đất ở tại nông thôn', color: '#ffd0ff', priority: 1 },
                { code: 'DGT', name: 'Đất công trình giao thông', color: '#ffaa32', priority: 1 },
                { code: 'DSK', name: 'Đất xây dựng công trình sự nghiệp khác', color: '#ffaaa0', priority: 0 },
                { code: 'DSN', name: 'Đất xây dựng công trình sự nghiệp', color: '#ffa0aa', priority: 0 },
                { code: 'DTL', name: 'Đất công trình thủy lợi', color: '#aaffff', priority: 0 },
                { code: 'DTT', name: 'Đất xây dựng cơ sở thể dục, thể thao', color: '#ffaaa0', priority: 0 },
                { code: 'DVH', name: 'Đất xây dựng cơ sở văn hóa', color: '#ffaaa0', priority: 0 },
                { code: 'DXH', name: 'Đất xây dựng cơ sở xã hội', color: '#ffaaa0', priority: 0 },
                { code: 'DYT', name: 'Đất xây dựng cơ sở y tế', color: '#ffaaa0', priority: 0 },
                { code: 'HNK', name: 'Đất trồng cây hằng năm khác', color: '#fff0b4', priority: 0 },
                { code: 'LMU', name: 'Đất làm muối', color: '#ffffff', priority: 0 }
            ];
        }

        return landColorsData;
    }

    const PALETTE_GRID = [
        '#ffcdd2', '#ffe0b2', '#fff9c4', '#c8e6c9', '#b2edd4', '#bbdefb', '#e1bee7', '#f8bbd0',
        '#ff5252', '#ff7043', '#ffca28', '#66bb6a', '#26c6da', '#42a5f5', '#7e57c2', '#ec407a',
        '#f44336', '#ff5722', '#ff9800', '#4caf50', '#00bcd4', '#2196f3', '#673ab7', '#e91e63',
        '#b71c1c', '#d84315', '#e65100', '#1b5e20', '#006064', '#0d47a1', '#4a148c', '#880e4f',
        '#ffffff', '#e0e0e0', '#9e9e9e', '#616161', '#424242', '#212121', '#000000', 'rainbow'
    ];

    // ===== RENDER COLOR POPOVER TOOLTIP UI =====
    function getOrCreateColorPopover() {
        if (colorPopoverEl && document.body.contains(colorPopoverEl)) return colorPopoverEl;

        const el = document.createElement('div');
        el.id = 'topo-color-popover';
        el.className = 'topo-color-popover topo-popover-hidden';
        el.setAttribute('role', 'tooltip');

        el.innerHTML = `
            <div class="topo-popover-header">
                <span class="topo-popover-title">Màu nét vẽ <span class="topo-color-code" id="topo-color-code-display">— #c026d3</span></span>
                <button class="topo-btn-icon" id="topo-popover-close">✕</button>
            </div>
            <div class="topo-popover-content">
                <div class="topo-segmented-control">
                    <button class="topo-segmented-item active" id="topo-tab-landtype">Theo loại đất</button>
                    <button class="topo-segmented-item" id="topo-tab-custom">Màu tự chọn</button>
                </div>

                <div class="topo-tab-content" id="topo-view-landtype">
                    <div class="topo-search-box">
                        <svg class="topo-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="11" cy="11" r="8"></circle>
                            <path d="m21 21-4.3-4.3"></path>
                        </svg>
                        <input type="text" id="topo-land-search-input" placeholder="Tìm theo mã hoặc tên loại đất..." />
                    </div>
                    <div class="topo-land-list miniScroll" id="topo-land-list">
                    </div>
                </div>

                <div class="topo-tab-content topo-view-hidden" id="topo-view-custom">
                    <div class="topo-palette-grid" id="topo-palette-grid">
                    </div>
                    <div class="topo-custom-input-row">
                        <div class="topo-color-preview-box" id="topo-custom-preview-box" style="background:#c026d3"></div>
                        <input type="text" class="topo-hex-input" id="topo-custom-hex-input" value="#c026d3" spellcheck="false" />
                        <input type="color" id="topo-hidden-color-picker" style="display:none" value="#c026d3" />
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(el);
        colorPopoverEl = el;

        bindPopoverEvents();
        renderCustomPaletteGrid();

        return colorPopoverEl;
    }

    function isItemStarred(item) {
        return item.priority === 1 || favoriteCodes.has(item.code);
    }

    function renderLandTypeList(filterText = '') {
        const listEl = document.getElementById('topo-land-list');
        if (!listEl) return;

        const query = filterText.toLowerCase().trim();
        let items = [...landColorsData];

        if (query) {
            items = items.filter(item =>
                item.code.toLowerCase().includes(query) ||
                item.name.toLowerCase().includes(query)
            );
        }

        items.sort((a, b) => {
            const starA = isItemStarred(a) ? 1 : 0;
            const starB = isItemStarred(b) ? 1 : 0;
            if (starA !== starB) return starB - starA;
            return a.code.localeCompare(b.code);
        });

        if (items.length === 0) {
            listEl.innerHTML = `<div class="topo-empty-state">Không tìm thấy loại đất phù hợp.</div>`;
            return;
        }

        listEl.innerHTML = '';
        items.forEach(item => {
            const isStarred = isItemStarred(item);
            const row = document.createElement('div');
            row.className = 'topo-land-item';

            row.innerHTML = `
                <button class="topo-star-btn ${isStarred ? 'starred' : ''}" title="${isStarred ? 'Bỏ ưu tiên' : 'Ưu tiên đẩy lên đầu'}" data-code="${item.code}">
                    ${isStarred ? '★' : '☆'}
                </button>
                <span class="topo-color-swatch" style="background:${item.color}"></span>
                <span class="topo-land-code">${item.code}</span>
                <span class="topo-land-name" title="${item.name}">${item.name}</span>
            `;

            row.addEventListener('click', (e) => {
                if (e.target.closest('.topo-star-btn')) return;
                e.stopPropagation();
                handleColorSelected(item.color, item.code);
            });

            const starBtn = row.querySelector('.topo-star-btn');
            if (starBtn) {
                starBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (favoriteCodes.has(item.code)) {
                        favoriteCodes.delete(item.code);
                        item.priority = 0;
                    } else {
                        favoriteCodes.add(item.code);
                        item.priority = 1;
                    }
                    saveFavoriteCodes();
                    renderLandTypeList(document.getElementById('topo-land-search-input')?.value || '');
                });
            }

            listEl.appendChild(row);
        });
    }

    function renderCustomPaletteGrid() {
        const gridEl = document.getElementById('topo-palette-grid');
        if (!gridEl) return;

        gridEl.innerHTML = '';
        PALETTE_GRID.forEach(hex => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'topo-palette-btn';

            if (hex === 'rainbow') {
                btn.className += ' topo-palette-rainbow';
                btn.title = 'Chọn màu tùy chỉnh...';
                btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="m15 5 4 4"/><path d="M13 7 4.7 15.3a2 2 0 0 0 0 2.8l1.4 1.4a2 2 0 0 0 2.8 0L17 11"/><path d="m14 6 3 3"/></svg>`;
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const picker = document.getElementById('topo-hidden-color-picker');
                    if (picker) picker.click();
                });
            } else {
                btn.style.background = hex;
                btn.dataset.color = hex;
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    updateCustomColorSelection(hex);
                    handleColorSelected(hex, 'Màu tự chọn');
                });
            }

            gridEl.appendChild(btn);
        });
    }

    function updateCustomColorSelection(hex) {
        currentColorHex = hex;
        const preview = document.getElementById('topo-custom-preview-box');
        const input = document.getElementById('topo-custom-hex-input');
        const display = document.getElementById('topo-color-code-display');

        if (preview) preview.style.background = hex;
        if (input) input.value = hex;
        if (display) display.textContent = `— ${hex}`;
    }

    function bindPopoverEvents() {
        const closeBtn = document.getElementById('topo-popover-close');
        const tabLandType = document.getElementById('topo-tab-landtype');
        const tabCustom = document.getElementById('topo-tab-custom');
        const viewLandType = document.getElementById('topo-view-landtype');
        const viewCustom = document.getElementById('topo-view-custom');
        const searchInput = document.getElementById('topo-land-search-input');
        const hexInput = document.getElementById('topo-custom-hex-input');
        const colorPicker = document.getElementById('topo-hidden-color-picker');

        if (closeBtn) {
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                hideColorPopover();
            });
        }

        if (tabLandType && tabCustom) {
            tabLandType.addEventListener('click', () => {
                tabLandType.classList.add('active');
                tabCustom.classList.remove('active');
                viewLandType.classList.remove('topo-view-hidden');
                viewCustom.classList.add('topo-view-hidden');
            });

            tabCustom.addEventListener('click', () => {
                tabCustom.classList.add('active');
                tabLandType.classList.remove('active');
                viewCustom.classList.remove('topo-view-hidden');
                viewLandType.classList.add('topo-view-hidden');
            });
        }

        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                renderLandTypeList(e.target.value);
            });
        }

        if (hexInput) {
            hexInput.addEventListener('change', (e) => {
                let val = e.target.value.trim();
                if (val && !val.startsWith('#')) val = '#' + val;
                if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
                    updateCustomColorSelection(val);
                    handleColorSelected(val, 'Màu tự chọn');
                }
            });
        }

        if (colorPicker) {
            colorPicker.addEventListener('input', (e) => {
                updateCustomColorSelection(e.target.value);
                handleColorSelected(e.target.value, 'Màu tự chọn');
            });
        }
    }

    let activeCustomColorCallback = null;

    function handleColorSelected(colorValue, label) {
        if (typeof activeCustomColorCallback === 'function') {
            const cb = activeCustomColorCallback;
            activeCustomColorCallback = null;
            cb(colorValue, label);
            hideColorPopover();
            return;
        }
        applyColorToSelectedFeatures(colorValue, label);
    }

    async function showColorPopoverNearElement(targetEl, onSelectCallback = null) {
        activeCustomColorCallback = onSelectCallback;
        await fetchLandColorsData();
        const pop = getOrCreateColorPopover();

        renderLandTypeList(document.getElementById('topo-land-search-input')?.value || '');
        pop.classList.remove('topo-popover-hidden');

        if (targetEl && typeof targetEl.getBoundingClientRect === 'function') {
            const rect = targetEl.getBoundingClientRect();
            const popWidth = pop.offsetWidth || 320;
            const popHeight = pop.offsetHeight || 380;

            let top = rect.top - popHeight - 8;
            if (top < 10) top = rect.bottom + 8;
            if (top + popHeight > window.innerHeight - 10) top = Math.max(10, window.innerHeight - popHeight - 10);

            let left = rect.left - 40;
            if (left + popWidth > window.innerWidth - 10) left = Math.max(10, window.innerWidth - popWidth - 10);
            if (left < 10) left = 10;

            pop.style.top = Math.max(10, top) + 'px';
            pop.style.left = Math.max(10, left) + 'px';
        }
    }

    function hideColorPopover() {
        if (colorPopoverEl) {
            colorPopoverEl.classList.add('topo-popover-hidden');
        }
    }

    function applyColorToSelectedFeatures(colorValue, label) {
        const count = window.__areaDeleterGetSelectedCount ? window.__areaDeleterGetSelectedCount() : 0;
        if (count === 0) return;

        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());

        let strokeColor = colorValue;
        let fillColor = colorValue;

        if (fillColor.startsWith('rgb(')) {
            fillColor = fillColor.replace('rgb(', 'rgba(').replace(')', ', 0.4)');
        } else if (fillColor.startsWith('#')) {
            const r = parseInt(fillColor.slice(1, 3), 16) || 255;
            const g = parseInt(fillColor.slice(3, 5), 16) || 0;
            const b = parseInt(fillColor.slice(5, 7), 16) || 0;
            fillColor = `rgba(${r}, ${g}, ${b}, 0.4)`;
        }

        let newStyle = null;
        if (window.ol && window.ol.style) {
            newStyle = new window.ol.style.Style({
                stroke: new window.ol.style.Stroke({
                    color: strokeColor,
                    width: 4
                }),
                fill: new window.ol.style.Fill({
                    color: fillColor
                })
            });
        }

        const features = window.__areaDeleterGetSelectedFeatures ? window.__areaDeleterGetSelectedFeatures() : [];
        features.forEach(item => {
            try {
                item.isColorApplied = true;

                item.feature.set('color', strokeColor);
                item.feature.set('strokeColor', strokeColor);
                item.feature.set('stroke', strokeColor);
                item.feature.set('fill', strokeColor);
                item.feature.set('OGR_STYLE', `PEN(c:${strokeColor.toUpperCase()},w:2px)`);
                if (label) item.feature.set('landType', label);

                if (newStyle) {
                    item.feature.setStyle(newStyle);
                    item.originalStyle = newStyle;
                }

                if (typeof item.feature.changed === 'function') item.feature.changed();
                if (item.source && typeof item.source.changed === 'function') item.source.changed();

                if (map && window.__topoSyncFeatureToReactState) {
                    window.__topoSyncFeatureToReactState(map, item.feature);
                }
            } catch (e) {}
        });

        if (map && typeof map.render === 'function') {
            map.render();
        }

        hideColorPopover();
        if (window.__areaDeleterCancel) window.__areaDeleterCancel();
    }

    // Global APIs
    window.__areaColorizerShowPopover = showColorPopoverNearElement;
    window.__areaColorizerHidePopover = hideColorPopover;

})();
