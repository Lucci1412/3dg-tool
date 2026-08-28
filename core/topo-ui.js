// ============================================================
// 3DG Topology Checker — Minimalist CAD-Style UI Module
// - Floating Magnifying Glass Icon Button (Draggable)
// - Minimalist Light Gray Panel with ⚙️ Settings, — Minimize, ✕ Close
// - "Check Topo" scan action button
// - "Xóa Theo Vùng" interactive polygon area deletion button
// ============================================================

(function () {
    'use strict';

    function log() { }

    let isPanelOpen = false;
    let isMinimized = false;
    let isSettingsOpen = false;
    let currentErrors = [];
    let activeErrorId = null;

    // ===== 2D / 3D MODE STATE & DETECTOR (MODULE SCOPE) =====
    let currentAppMode = '2d'; // '2d' or '3d'

    function detectCurrentAppMode() {
        // 1. Kiểm tra DOM Canvas thực tế trên trang (Độ chính xác cao nhất)
        const hasCesium = Boolean(
            document.querySelector('canvas.cesium-widget') ||
            document.querySelector('.cesium-viewer') ||
            document.querySelector('.cesium-widget') ||
            document.querySelector('canvas[data-engine="three.js"]') ||
            window.viewer?.scene ||
            window.__topo3dViewer
        );
        const hasOl = Boolean(
            document.querySelector('.ol-viewport') ||
            document.querySelector('.ol-unselectable')
        );

        if (hasCesium && !hasOl) {
            return '3d';
        }
        if (hasOl && !hasCesium) {
            return '2d';
        }

        // 2. Kiểm tra URL Hash, Pathname và Query Params
        const hash = (window.location.hash || '').toLowerCase();
        const href = (window.location.href || '').toLowerCase();
        const path = (window.location.pathname || '').toLowerCase();

        if (hash.includes('3d') || href.includes('3d') || hash.includes('mesh') || href.includes('mesh') || path.includes('3d')) {
            return '3d';
        }
        if (hash.includes('tiles') || href.includes('tiles') || path.includes('tiles')) {
            return '2d';
        }

        // 3. Kiểm tra Active Tab Link trên Header/Sidebar
        const link3d = document.querySelector('a[href*="3d"], a[href*="mesh"], [data-mode="3d"]');
        if (link3d && (link3d.classList.contains('bg-blue-500') || link3d.className.includes('active') || link3d.classList.contains('text-white'))) {
            return '3d';
        }

        // 4. Nếu tồn tại bất kỳ dấu hiệu Cesium nào
        if (hasCesium) return '3d';

        return '2d';
    }

    // ===== CREATE MINIMALIST UI =====
    function createUI() {
        if (document.getElementById('topo-fab-btn')) return;

        // 1. Minimalist Magnifying Glass Button (Icon kính lúp, bo góc ít, kéo thả tự do)
        const fab = document.createElement('button');
        fab.id = 'topo-fab-btn';
        fab.className = 'topo-fab';
        fab.title = 'Kiểm tra lỗi Topology (Giữ chuột để kéo di chuyển)';
        fab.innerHTML = `
            <span class="topo-fab-icon">🔍</span>
            <span class="topo-fab-badge" id="topo-fab-badge" style="display:none">0</span>
        `;

        // 2. Minimalist Error Panel (Kéo thả tự do bằng Header)
        const panel = document.createElement('div');
        panel.id = 'topo-checker-panel';
        panel.className = 'topo-panel topo-panel-hidden';

        panel.innerHTML = `
            <div class="topo-header" id="topo-header" title="Giữ chuột để kéo di chuyển bảng">
                <div class="topo-title">
                   
                    <span>Check Topology</span>
                    <span id="topo-badge-mode">
                        <span class="topo-badge-2d">2D PREMIUM</span>
                    </span>
                </div>
                <div class="topo-header-actions">
                    <button class="topo-btn-icon" id="topo-btn-settings" title="Cài đặt phím tắt nhanh (⚙️)">⚙️</button>
                    <button class="topo-btn-icon" id="topo-btn-minimize" title="Thu nhỏ / Mở rộng (—)">—</button>
                    <button class="topo-btn-icon" id="topo-btn-close" title="Đóng (✕)">✕</button>
                </div>
            </div>

            <!-- Quick Settings Modal for Shortcuts -->
            <div class="topo-settings-modal topo-modal-hidden" id="topo-settings-modal">
                <div class="topo-settings-header">
                    <div class="topo-settings-title">
                        <span>⚙️ Cài Đặt Phím Tắt Nhanh</span>
                    </div>
                    <button class="topo-btn-icon" id="topo-settings-close" title="Đóng">✕</button>
                </div>
                <div class="topo-settings-body">
                    <div class="topo-settings-row">
                        <div class="topo-settings-label">
                            <span>Phím bật <b>Chọn / Sửa</b>:</span>
                            <small class="topo-settings-sub">Nhấn phím tắt để lập tức chuyển về chế độ Chọn/Sửa của 3DG</small>
                        </div>
                        <div class="topo-key-recorder-wrap">
                            <button type="button" class="topo-key-recorder-btn" id="topo-key-recorder-btn" title="Click để đổi phím tắt">
                                <span class="topo-key-badge" id="topo-key-badge">Space</span>
                            </button>
                        </div>
                    </div>
                    <div class="topo-quick-shortcuts">
                        <span class="topo-quick-title">Gợi ý:</span>
                        <div class="topo-quick-chips">
                            <button type="button" class="topo-chip-btn" data-key="Space">Space</button>
                            <button type="button" class="topo-chip-btn" data-key="S">S</button>
                            <button type="button" class="topo-chip-btn" data-key="V">V</button>
                            <button type="button" class="topo-chip-btn" data-key="Escape">Esc</button>
                        </div>
                    </div>
                    <div class="topo-settings-hint" id="topo-settings-hint">
                        💡 <b>Mẹo:</b> Nhấn phím <kbd id="topo-settings-kbd">Space</kbd> bất kỳ lúc nào để thoát vẽ hoặc bật chế độ Chọn/Sửa.
                    </div>
                </div>
            </div>

            <div class="topo-body" id="topo-body">
                <!-- Primary Action Buttons -->
                <div class="topo-controls">
                    <div class="topo-btn-group">
                        <button class="topo-btn-primary" id="topo-btn-scan">
                            <span>Check Topo</span>
                        </button>
                        <button class="topo-btn-secondary" id="topo-btn-dedup-line" title="Xóa toàn bộ các nét vẽ trùng lặp, chỉ giữ lại 1 nét duy nhất (Dedup Lines)">
                            <span>Xóa Trùng</span>
                        </button>
                        <button class="topo-btn-secondary" id="topo-btn-smart-draw" title="Tự động vẽ đường chính & đường song song (Smart Drawer)">
                            <span>Vẽ Đường</span>
                        </button>
                        <button class="topo-btn-secondary" id="topo-btn-cut-line" title="Cắt nét vẽ thành các đoạn khi đi qua đường cắt (Cut Stroke)">
                            <span>Cắt Nét</span>
                        </button>
                        <button class="topo-btn-secondary" id="topo-btn-area-color">
                            <span>Đổi Màu Vùng</span>
                        </button>
                        <button class="topo-btn-secondary" id="topo-btn-area-delete">
                            <span>Xóa Vùng</span>
                        </button>
                    </div>
                </div>

                <!-- Area Selection & Line Drawing Active Bar -->
                <div class="topo-area-bar topo-drawer-hidden" id="topo-area-bar" style="flex-direction:column; gap:6px; padding:8px 10px;">
                    <div id="topo-draw-line-types" style="display:flex; align-items:center; gap:8px; width:100%;">
                        <label class="topo-main-radio" style="display:inline-flex; align-items:center; justify-content:space-between; gap:5px; font-size:12px; font-weight:600; padding:4px 8px; background:#fff3e0; border:1px solid #ffb74d; border-radius:5px; cursor:pointer; flex:1;">
                            <div style="display:flex; align-items:center; gap:5px;">
                                <input type="radio" name="topo-active-draw-type" value="DGT" checked style="margin:0;">
                                <span>Vẽ Đường</span>
                            </div>
                            <button type="button" class="topo-color-trigger-btn" id="topo-badge-dgt" title="Nhấp để mở bảng chọn loại đất & màu nét vẽ đường" style="width:20px; height:18px; border:1px solid #ea580c; border-radius:3px; padding:0; cursor:pointer; background:${localStorage.getItem('topo_color_dgt') || '#ffaa32'}; border-radius:4px; display:inline-block;"></button>
                        </label>
                        <label class="topo-main-radio" style="display:inline-flex; align-items:center; justify-content:space-between; gap:5px; font-size:12px; font-weight:600; padding:4px 8px; background:#e0f7fa; border:1px solid #4dd0e1; border-radius:5px; cursor:pointer; flex:1;">
                            <div style="display:flex; align-items:center; gap:5px;">
                                <input type="radio" name="topo-active-draw-type" value="DTL" style="margin:0;">
                                <span>Vẽ Sông</span>
                            </div>
                            <button type="button" class="topo-color-trigger-btn" id="topo-badge-dtl" title="Nhấp để mở bảng chọn loại đất & màu nét vẽ sông" style="width:20px; height:18px; border:1px solid #0284c7; border-radius:3px; padding:0; cursor:pointer; background:${localStorage.getItem('topo_color_dtl') || '#aaffff'}; border-radius:4px; display:inline-block;"></button>
                        </label>
                    </div>

                    <!-- Distance Spacing Stepper Bar (Giãn khoảng cách 2 nét) -->
                    <div id="topo-draw-dist-bar" style="display:flex; align-items:center; justify-content:space-between; width:100%; padding:4px 8px; background:#f8fafc; border:1px solid #cbd5e1; border-radius:6px; font-size:12px; margin-top:2px;">
                        <span style="font-weight:600; color:#475569; font-size:11px;">Giãn khoảng cách:</span>
                        <div style="display:flex; align-items:center; gap:4px;">
                            <button type="button" id="topo-dist-minus-btn" title="Giảm khoảng cách" style="width:24px; height:24px; font-weight:bold; font-size:14px; line-height:1; border:1px solid #cbd5e1; background:#ffffff; border-radius:4px; cursor:pointer; color:#334155; display:flex; align-items:center; justify-content:center;">−</button>
                            <input type="number" id="topo-dist-input-val" value="${localStorage.getItem('topo_smart_dist') || '5.00'}" step="0.1" min="0.01" style="width:54px; height:24px; text-align:center; font-weight:700; font-size:12px; border:1px solid #cbd5e1; border-radius:4px; padding:0 2px; color:#0f172a;">
                            <select id="topo-dist-unit-select" style="height:24px; font-weight:600; font-size:11px; border:1px solid #cbd5e1; border-radius:4px; background:#ffffff; cursor:pointer; padding:0 2px; color:#334155;">
                                <option value="m" ${localStorage.getItem('topo_smart_unit') === 'm' || !localStorage.getItem('topo_smart_unit') ? 'selected' : ''}>m</option>
                                <option value="dm" ${localStorage.getItem('topo_smart_unit') === 'dm' ? 'selected' : ''}>dm</option>
                                <option value="cm" ${localStorage.getItem('topo_smart_unit') === 'cm' ? 'selected' : ''}>cm</option>
                            </select>
                            <button type="button" id="topo-dist-plus-btn" title="Tăng khoảng cách" style="width:24px; height:24px; font-weight:bold; font-size:14px; line-height:1; border:1px solid #cbd5e1; background:#ffffff; border-radius:4px; cursor:pointer; color:#334155; display:flex; align-items:center; justify-content:center;">+</button>
                        </div>
                    </div>

                    <!-- Parallel Side Radio Options (Hướng song song: Phải / Trái / Cả 2 bên) -->
                    <div id="topo-draw-side-bar" style="display:flex; align-items:center; justify-content:space-between; width:100%; padding:4px 8px; background:#f8fafc; border:1px solid #cbd5e1; border-radius:6px; font-size:11px; margin-top:2px;">
                        <span style="font-weight:600; color:#475569; font-size:11px;">Hàng song song:</span>
                        <div style="display:flex; align-items:center; gap:8px;">
                            <label style="display:inline-flex; align-items:center; gap:3px; cursor:pointer; font-weight:600; color:#334155;">
                                <input type="radio" name="topo-active-draw-side" value="right" ${localStorage.getItem('topo_smart_side') === 'right' || !localStorage.getItem('topo_smart_side') ? 'checked' : ''} style="margin:0;">
                                <span>Phải</span>
                            </label>
                            <label style="display:inline-flex; align-items:center; gap:3px; cursor:pointer; font-weight:600; color:#334155;">
                                <input type="radio" name="topo-active-draw-side" value="left" ${localStorage.getItem('topo_smart_side') === 'left' ? 'checked' : ''} style="margin:0;">
                                <span>Trái</span>
                            </label>
                            <label style="display:inline-flex; align-items:center; gap:3px; cursor:pointer; font-weight:600; color:#334155;">
                                <input type="radio" name="topo-active-draw-side" value="both" ${localStorage.getItem('topo_smart_side') === 'both' ? 'checked' : ''} style="margin:0;">
                                <span>Cả 2 bên</span>
                            </label>
                        </div>
                    </div>
                    <div style="display:flex; align-items:center; justify-content:space-between; width:100%;">
                        <div class="topo-area-status" id="topo-area-status" style="font-size:11px; color:#475569;">Click chọn điểm, nhấp đúp để xong</div>
                        <div class="topo-area-actions">
                            <button class="topo-btn-sm topo-btn-primary" id="topo-btn-area-finish" style="display:none">✓ Hoàn Thành</button>
                            <button class="topo-btn-sm topo-btn-danger" id="topo-btn-area-confirm" style="display:none">🗑️ Xóa</button>
                            <button class="topo-btn-sm topo-btn-cancel" id="topo-btn-area-cancel">✕ Hủy</button>
                        </div>
                    </div>
                </div>

                <div class="topo-stats" id="topo-stats" style="display:none">
                    <span id="topo-stats-text"></span>
                </div>

                <div class="topo-error-list" id="topo-error-list">
                    <div class="topo-empty-state">
                        Chưa có danh sách lỗi.
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(fab);
        document.body.appendChild(panel);

        bindEvents();
        makeDraggable(fab, fab, true);
        makeDraggable(panel, document.getElementById('topo-header'), false);
    }

    // ===== TOGGLE PANEL STATE =====
    function togglePanel() {
        const fab = document.getElementById('topo-fab-btn');
        const panel = document.getElementById('topo-checker-panel');
        if (!fab || !panel) return;

        isPanelOpen = !isPanelOpen;
        if (isPanelOpen) {
            panel.classList.remove('topo-panel-hidden');
            fab.classList.add('topo-fab-active');

            if (!panel.dataset.dragged) {
                const fabRect = fab.getBoundingClientRect();
                const panelRect = panel.getBoundingClientRect();

                let pTop = fabRect.top - panelRect.height - 10;
                if (pTop < 10) pTop = fabRect.bottom + 10;
                let pLeft = fabRect.left - panelRect.width + fabRect.width;
                if (pLeft < 10) pLeft = 10;

                panel.style.top = Math.max(10, pTop) + 'px';
                panel.style.left = Math.max(10, pLeft) + 'px';
                panel.style.bottom = 'auto';
                panel.style.right = 'auto';
            }
        } else {
            panel.classList.add('topo-panel-hidden');
            fab.classList.remove('topo-fab-active');
        }
    }

    // ===== BIND UI EVENTS =====
    function bindEvents() {
        const fab = document.getElementById('topo-fab-btn');
        const panel = document.getElementById('topo-checker-panel');
        const closeBtn = document.getElementById('topo-btn-close');
        const minimizeBtn = document.getElementById('topo-btn-minimize');
        const body = document.getElementById('topo-body');
        const scanBtn = document.getElementById('topo-btn-scan');
        const dedupLineBtn = document.getElementById('topo-btn-dedup-line');
        const smartDrawBtn = document.getElementById('topo-btn-smart-draw');
        const cutLineBtn = document.getElementById('topo-btn-cut-line');

        // 0. Floating Action Button (Kính lúp) click to toggle panel
        if (fab) {
            fab.addEventListener('click', (e) => {
                e.stopPropagation();
                if (fab.dataset.dragging === 'true') {
                    delete fab.dataset.dragging;
                    return;
                }
                togglePanel();
            });
        }

        // 0.5 Settings modal & Shortcut manager
        const settingsBtn = document.getElementById('topo-btn-settings');
        const settingsModal = document.getElementById('topo-settings-modal');
        const settingsCloseBtn = document.getElementById('topo-settings-close');
        const keyRecorderBtn = document.getElementById('topo-key-recorder-btn');
        const keyBadge = document.getElementById('topo-key-badge');
        const settingsKbd = document.getElementById('topo-settings-kbd');
        const quickChips = document.querySelectorAll('.topo-chip-btn');

        let isRecordingKey = false;
        let selectEditShortcut = localStorage.getItem('topo_shortcut_select_edit') || 'Space';

        function updateKeyDisplay(keyName) {
            selectEditShortcut = keyName;
            localStorage.setItem('topo_shortcut_select_edit', keyName);
            const displayTxt = (keyName === ' ' || keyName === 'Space') ? 'Space' : keyName;
            if (keyBadge) keyBadge.textContent = displayTxt;
            if (settingsKbd) settingsKbd.textContent = displayTxt;
        }
        updateKeyDisplay(selectEditShortcut);

        if (settingsBtn && settingsModal) {
            settingsBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const isHidden = settingsModal.classList.contains('topo-modal-hidden');
                if (isHidden) {
                    settingsModal.classList.remove('topo-modal-hidden');
                    settingsBtn.classList.add('--active');
                } else {
                    settingsModal.classList.add('topo-modal-hidden');
                    settingsBtn.classList.remove('--active');
                    if (isRecordingKey) stopRecordingKey();
                }
            });
        }

        if (settingsCloseBtn && settingsModal) {
            settingsCloseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                settingsModal.classList.add('topo-modal-hidden');
                settingsBtn?.classList.remove('--active');
                if (isRecordingKey) stopRecordingKey();
            });
        }

        function startRecordingKey() {
            isRecordingKey = true;
            if (keyRecorderBtn) keyRecorderBtn.classList.add('is-recording');
            if (keyBadge) keyBadge.textContent = '... Nhấn phím ...';
        }

        function stopRecordingKey() {
            isRecordingKey = false;
            if (keyRecorderBtn) keyRecorderBtn.classList.remove('is-recording');
            updateKeyDisplay(selectEditShortcut);
        }

        if (keyRecorderBtn) {
            keyRecorderBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (isRecordingKey) {
                    stopRecordingKey();
                } else {
                    startRecordingKey();
                }
            });
        }

        quickChips.forEach(chip => {
            chip.addEventListener('click', (e) => {
                e.stopPropagation();
                const chosenKey = chip.dataset.key || 'Space';
                if (isRecordingKey) isRecordingKey = false;
                if (keyRecorderBtn) keyRecorderBtn.classList.remove('is-recording');
                updateKeyDisplay(chosenKey);
            });
        });

        function isTextEditingElement(el) {
            if (!el) return false;
            if (el.isContentEditable) return true;
            const tag = (el.tagName || '').toLowerCase();
            if (tag === 'textarea') return true;
            if (tag === 'input') {
                const type = (el.type || '').toLowerCase();
                // Ignore text-typing fields only (never block radio/checkbox or general buttons)
                if (['text', 'password', 'search', 'email', 'number', 'tel', 'url'].includes(type)) {
                    return true;
                }
            }
            return false;
        }

        // Global Keydown Handler for recording & triggering shortcut
        window.addEventListener('keydown', (e) => {
            // If recording key inside settings modal
            if (isRecordingKey) {
                e.preventDefault();
                e.stopPropagation();
                let pressedKey = e.code === 'Space' ? 'Space' : (e.key === ' ' ? 'Space' : (e.key.length === 1 ? e.key.toUpperCase() : e.key));
                if (pressedKey === 'Escape') pressedKey = 'Escape';
                updateKeyDisplay(pressedKey);
                isRecordingKey = false;
                if (keyRecorderBtn) keyRecorderBtn.classList.remove('is-recording');
                return;
            }

            // Do not block when typing in text fields
            if (isTextEditingElement(e.target) || isTextEditingElement(document.activeElement)) return;

            const targetKey = selectEditShortcut || 'Space';
            const isMatch = (targetKey === 'Space' && (e.code === 'Space' || e.key === ' '))
                || (e.key && e.key.toUpperCase() === targetKey.toUpperCase())
                || (e.code && e.code.toUpperCase() === targetKey.toUpperCase());

            if (isMatch) {
                e.preventDefault(); // Prevent page scrolling on Space
                e.stopPropagation();
                cancelAllInteractiveModes();
                setActiveModeButton('topo-btn-scan');
                ensureNative3dgSelectEditModeActive();
            }
        }, true);

        // 1. Minimize button (—)
        if (minimizeBtn && body) {
            minimizeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                isMinimized = !isMinimized;
                if (isMinimized) {
                    body.classList.add('topo-body-collapsed');
                    minimizeBtn.textContent = '+';
                    minimizeBtn.title = 'Mở rộng (+)';
                } else {
                    body.classList.remove('topo-body-collapsed');
                    minimizeBtn.textContent = '—';
                    minimizeBtn.title = 'Thu nhỏ (—)';
                }
            });
        }

        // 2. Close button (✕)
        if (closeBtn) {
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                isPanelOpen = false;
                panel.classList.add('topo-panel-hidden');
                fab.classList.remove('topo-fab-active');
            });
        }

        // Area Delete & Color elements
        const areaColorBtn = document.getElementById('topo-btn-area-color');
        const areaDeleteBtn = document.getElementById('topo-btn-area-delete');
        const areaBar = document.getElementById('topo-area-bar');
        const areaStatus = document.getElementById('topo-area-status');
        const areaFinishBtn = document.getElementById('topo-btn-area-finish');
        const areaConfirmBtn = document.getElementById('topo-btn-area-confirm');
        const areaCancelBtn = document.getElementById('topo-btn-area-cancel');

        // ===== 2D / 3D MODE DETECTION & UI ROUTER =====
        function updateAppModeUI() {
            if (!document.getElementById('topo-fab-btn')) {
                createUI();
            }
            const newMode = detectCurrentAppMode();
            const badgeEl = document.getElementById('topo-badge-mode');
            const dedupLineEl = document.getElementById('topo-btn-dedup-line');
            const smartDrawEl = document.getElementById('topo-btn-smart-draw');
            const cutLineEl = document.getElementById('topo-btn-cut-line');
            const areaDeleteEl = document.getElementById('topo-btn-area-delete');

            if (newMode !== currentAppMode) {
                currentAppMode = newMode;
                cancelAllInteractiveModes();
            }

            const is3d = currentAppMode === '3d';
            if (badgeEl) {
                if (is3d) {
                    badgeEl.innerHTML = `<span class="topo-badge-3d">3D ULTRA</span>`;
                } else {
                    badgeEl.innerHTML = `<span class="topo-badge-2d">2D PREMIUM</span>`;
                }
            }

            if (dedupLineEl) dedupLineEl.style.display = is3d ? 'none' : '';
            if (smartDrawEl) smartDrawEl.style.display = is3d ? 'none' : '';
            if (cutLineEl) cutLineEl.style.display = is3d ? 'none' : '';
            if (areaDeleteEl) areaDeleteEl.style.display = is3d ? 'none' : '';
        }

        function initModeRouter() {
            updateAppModeUI();
            window.addEventListener('hashchange', updateAppModeUI);
            window.addEventListener('popstate', updateAppModeUI);

            const origPushState = history.pushState;
            if (origPushState && !history.__topoPushStatePatched) {
                history.__topoPushStatePatched = true;
                history.pushState = function () {
                    origPushState.apply(this, arguments);
                    setTimeout(updateAppModeUI, 50);
                };
            }
            const origReplaceState = history.replaceState;
            if (origReplaceState && !history.__topoReplaceStatePatched) {
                history.__topoReplaceStatePatched = true;
                history.replaceState = function () {
                    origReplaceState.apply(this, arguments);
                    setTimeout(updateAppModeUI, 50);
                };
            }

            setInterval(updateAppModeUI, 600);

            document.addEventListener('click', (e) => {
                const link = e.target.closest('a');
                if (link && (link.href?.includes('3d-mesh') || link.href?.includes('tiles'))) {
                    setTimeout(updateAppModeUI, 100);
                }
            }, true);
        }

        let currentAreaMode = 'delete'; // 'delete', 'color', 'smart-draw', or 'cut-line'

        function setActiveModeButton(activeId) {
            if (!scanBtn || !smartDrawBtn || !cutLineBtn || !areaColorBtn || !areaDeleteBtn) return;
            const allBtns = [scanBtn, dedupLineBtn, smartDrawBtn, cutLineBtn, areaColorBtn, areaDeleteBtn].filter(Boolean);
            allBtns.forEach(btn => {
                if (btn.id === activeId) {
                    btn.classList.remove('topo-btn-secondary');
                    btn.classList.add('topo-btn-primary');
                } else {
                    btn.classList.remove('topo-btn-primary');
                    btn.classList.add('topo-btn-secondary');
                }
            });

            if (cutLineBtn) {
                const span = cutLineBtn.querySelector('span') || cutLineBtn;
                if (activeId === 'topo-btn-cut-line') {
                    span.textContent = 'Hủy Cắt Nét';
                    cutLineBtn.title = 'Nhấp để hủy chế độ cắt nét vẽ';
                } else {
                    span.textContent = 'Cắt Nét';
                    cutLineBtn.title = 'Cắt nét vẽ thành các đoạn khi đi qua đường cắt (Cut Stroke)';
                }
            }
        }

        function animatePanelHeightToContent() {
            const panel = document.getElementById('topo-checker-panel');
            if (!panel || panel.classList.contains('topo-panel-hidden')) return;

            const startHeight = panel.offsetHeight;
            panel.style.height = 'auto';
            const targetHeight = panel.offsetHeight;

            if (Math.abs(startHeight - targetHeight) < 4) return;

            panel.style.height = startHeight + 'px';
            panel.offsetHeight; // Force reflow
            panel.style.transition = 'height 0.35s cubic-bezier(0.4, 0, 0.2, 1)';
            panel.style.height = targetHeight + 'px';

            setTimeout(() => {
                try {
                    if (panel.style.height !== 'auto') panel.style.height = 'auto';
                } catch (e) { }
            }, 360);
        }

        const errorListContainer = document.getElementById('topo-error-list');
        const statsContainer = document.getElementById('topo-stats');

        function setUIVisibilityMode(mode) {
            if (mode === 'scan') {
                if (errorListContainer) errorListContainer.style.display = 'block';
                if (statsContainer) statsContainer.style.display = 'block';
            } else {
                if (errorListContainer) errorListContainer.style.display = 'none';
                if (statsContainer) statsContainer.style.display = 'none';
            }
            animatePanelHeightToContent();
        }

        const drawDistBar = document.getElementById('topo-draw-dist-bar');
        const drawSideBar = document.getElementById('topo-draw-side-bar');

        function setSmartDrawControlsVisible(visible) {
            const displayVal = visible ? 'flex' : 'none';
            const lineTypeBox = document.getElementById('topo-draw-line-types');
            if (lineTypeBox) lineTypeBox.style.display = displayVal;
            if (drawDistBar) drawDistBar.style.display = displayVal;
            if (drawSideBar) drawSideBar.style.display = displayVal;
        }

        function cancelAllInteractiveModes() {
            if (window.__smartDrawerStop) window.__smartDrawerStop();
            if (window.__cutLineStop) window.__cutLineStop();
            if (window.__areaDeleterCancel) window.__areaDeleterCancel();
            if (window.__areaColorizer3DCancel) window.__areaColorizer3DCancel();
            if (window.__areaColorizerHidePopover) window.__areaColorizerHidePopover();
            if (areaBar) areaBar.classList.add('topo-drawer-hidden');
            if (cutLineBtn) {
                const span = cutLineBtn.querySelector('span') || cutLineBtn;
                span.textContent = 'Cắt Nét';
                cutLineBtn.title = 'Cắt nét vẽ thành các đoạn khi đi qua đường cắt (Cut Stroke)';
            }
            setSmartDrawControlsVisible(false);
            currentAreaMode = null;
            setUIVisibilityMode('scan');

            // Đảm bảo toàn bộ các canvas vẽ tương tác đều được reset về pointer-events: none và cursor: default
            ['topo-area-draw-canvas', 'topo-cut-line-canvas', 'topo-smart-draw-canvas', 'topo-3d-area-draw-canvas'].forEach(id => {
                const cv = document.getElementById(id);
                if (cv) {
                    cv.style.pointerEvents = 'none';
                    cv.style.cursor = 'default';
                }
            });
        }

        function ensureNative3dgSelectEditModeActive() {
            try {
                // 1. Dispatch ESC to cancel drawing on OpenLayers / window
                try {
                    const esc = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true });
                    window.dispatchEvent(esc);
                    document.dispatchEvent(esc);
                } catch (e) { }

                // 2. Ensure 3DG Edit Drawer is open
                const isPanelOpen = Array.from(document.querySelectorAll('div, span, h1, h2, h3, header'))
                    .some(el => (el.textContent || '').trim().includes('Biên tập dữ liệu'));

                if (!isPanelOpen) {
                    const btns = Array.from(document.querySelectorAll('button'));
                    const editBtn = btns.find(b => {
                        const svg = b.querySelector('svg');
                        if (!svg) return false;
                        const html = svg.outerHTML || '';
                        return html.includes('16.24 11.51') || html.includes('16.24') || html.includes('20.71 7.04') || (b.title && b.title.includes('Biên tập'));
                    });

                    if (editBtn) {
                        editBtn.click();
                    }
                }

                // 3. Dispatch null to drawingMode state hook in Dc (hookIdx 48 or any hook holding drawingMode string)
                const root = document.getElementById('root') || document.body;
                const candidates = [root, ...Array.from(document.querySelectorAll('div, section, aside, main, nav, ul, li'))];

                for (const el of candidates) {
                    const key = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactContainer'));
                    if (!key) continue;

                    let fiber = el[key];
                    for (let depth = 0; depth < 120 && fiber; depth++) {
                        if (fiber.memoizedProps?.onFinishDrawing || fiber.memoizedProps?.mapInstance || fiber.elementType?.name === 'Dc') {
                            let s = fiber.memoizedState;
                            let idx = 0;
                            while (s) {
                                if (s.queue && typeof s.queue.dispatch === 'function') {
                                    if (idx === 48 || s.memoizedState === 'LineString' || s.memoizedState === 'Point' || s.memoizedState === 'Polygon') {
                                        try { s.queue.dispatch(null); } catch (e) { }
                                    }
                                }
                                idx++;
                                s = s.next;
                            }
                        }
                        fiber = fiber.return;
                    }
                }

                // 4. Click the DOM element directly
                const trySelectEditDOM = () => {
                    const labels = Array.from(document.querySelectorAll('.ant-segmented-item, label'));
                    const selectEditLabel = labels.find(el => {
                        const text = (el.textContent || '').trim();
                        const svg = el.querySelector('svg');
                        const svgHtml = svg?.outerHTML || '';
                        return text.includes('Chọn/Sửa') || text === 'Chọn' || text === 'Sửa' || svgHtml.includes('M4.037 4.688') || svgHtml.includes('4.037');
                    });

                    if (selectEditLabel) {
                        const input = selectEditLabel.querySelector('input') || selectEditLabel.closest('label')?.querySelector('input');
                        if (input) {
                            input.checked = true;
                            input.dispatchEvent(new Event('input', { bubbles: true }));
                            input.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                        selectEditLabel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                        selectEditLabel.click();
                    }
                };

                trySelectEditDOM();
                setTimeout(trySelectEditDOM, 80);
                setTimeout(trySelectEditDOM, 250);
            } catch (e) {
                console.warn('[CheckTopo] Failed to auto-trigger native "Chọn/Sửa" mode:', e);
            }
        }

        // 5. Scan button
        if (scanBtn) {
            scanBtn.addEventListener('click', () => {
                cancelAllInteractiveModes();
                setActiveModeButton('topo-btn-scan');
                setUIVisibilityMode('scan');
                ensureNative3dgSelectEditModeActive();
                executeScan();
            });
        }

        // 5. Settings color pickers (⚙️) & Active Draw Type radios
        const dgtColorPicker = document.getElementById('topo-color-dgt');
        const dtlColorPicker = document.getElementById('topo-color-dtl');
        const badgeDgt = document.getElementById('topo-badge-dgt');
        const badgeDtl = document.getElementById('topo-badge-dtl');
        const drawTypeRadios = document.querySelectorAll('input[name="topo-active-draw-type"]');
        const lineTypeBox = document.getElementById('topo-draw-line-types');

        let activeDgtColor = localStorage.getItem('topo_color_dgt') || '#ffaa32';
        let activeDtlColor = localStorage.getItem('topo_color_dtl') || '#aaffff';

        function getDistanceInMeters() {
            const inputEl = document.getElementById('topo-dist-input-val');
            const unitEl = document.getElementById('topo-dist-unit-select');
            const val = inputEl ? parseFloat(inputEl.value) || 5.0 : 5.0;
            const unit = unitEl ? unitEl.value : 'm';

            if (unit === 'cm') return val * 0.01;
            if (unit === 'dm') return val * 0.1;
            return val;
        }

        function updateSmartDrawDistance() {
            const meters = getDistanceInMeters();
            const inputEl = document.getElementById('topo-dist-input-val');
            const unitEl = document.getElementById('topo-dist-unit-select');
            if (inputEl) localStorage.setItem('topo_smart_dist', inputEl.value);
            if (unitEl) localStorage.setItem('topo_smart_unit', unitEl.value);

            if (window.__smartDrawerSetDistance) {
                window.__smartDrawerSetDistance(meters);
            }
        }

        function getActiveDrawSettings() {
            const selectedRadio = document.querySelector('input[name="topo-active-draw-type"]:checked');
            const type = selectedRadio ? selectedRadio.value : 'DGT';
            const color = type === 'DGT' ? activeDgtColor : activeDtlColor;
            return { type, color };
        }

        function updateColorBadgesAndDrawer() {
            if (badgeDgt) badgeDgt.style.backgroundColor = activeDgtColor;
            if (badgeDtl) badgeDtl.style.backgroundColor = activeDtlColor;

            const { type, color } = getActiveDrawSettings();

            if (window.__smartDrawerSetLandType) {
                window.__smartDrawerSetLandType(type, color);
            }

            if (currentAreaMode === 'smart-draw') {
                const distInMeters = getDistanceInMeters();
                if (window.__smartDrawerStart) {
                    window.__smartDrawerStart({ distance: distInMeters, side: 'right', landType: type, color });
                }
            }
        }

        const distMinusBtn = document.getElementById('topo-dist-minus-btn');
        const distPlusBtn = document.getElementById('topo-dist-plus-btn');
        const distInputVal = document.getElementById('topo-dist-input-val');
        const distUnitSelect = document.getElementById('topo-dist-unit-select');

        function adjustDistanceStep(delta) {
            if (!distInputVal) return;
            let val = parseFloat(distInputVal.value) || 0;
            const unit = distUnitSelect ? distUnitSelect.value : 'm';
            const step = unit === 'cm' ? 10 : (unit === 'dm' ? 1 : 0.5);

            let newVal = Math.max(0.01, val + delta * step);
            distInputVal.value = (unit === 'm' ? newVal.toFixed(2) : (unit === 'dm' ? newVal.toFixed(1) : Math.round(newVal))).replace(/\.00$/, '');
            updateSmartDrawDistance();
        }

        if (distMinusBtn) {
            distMinusBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                adjustDistanceStep(-1);
            });
        }

        if (distPlusBtn) {
            distPlusBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                adjustDistanceStep(1);
            });
        }

        if (distInputVal) {
            distInputVal.addEventListener('input', () => updateSmartDrawDistance());
            distInputVal.addEventListener('change', () => updateSmartDrawDistance());
        }

        if (distUnitSelect) {
            distUnitSelect.addEventListener('change', () => updateSmartDrawDistance());
        }

        const drawSideRadios = document.querySelectorAll('input[name="topo-active-draw-side"]');
        drawSideRadios.forEach(radio => {
            radio.addEventListener('change', () => {
                const selectedSide = document.querySelector('input[name="topo-active-draw-side"]:checked')?.value || 'right';
                localStorage.setItem('topo_smart_side', selectedSide);
                if (window.__smartDrawerSetSide) {
                    window.__smartDrawerSetSide(selectedSide);
                }
            });
        });

        if (badgeDgt) {
            badgeDgt.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                if (window.__areaColorizerShowPopover) {
                    window.__areaColorizerShowPopover(badgeDgt, (color, landCode) => {
                        activeDgtColor = color;
                        localStorage.setItem('topo_color_dgt', color);
                        if (landCode) localStorage.setItem('topo_code_dgt', landCode);
                        updateColorBadgesAndDrawer();
                    });
                }
            });
        }

        if (badgeDtl) {
            badgeDtl.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                if (window.__areaColorizerShowPopover) {
                    window.__areaColorizerShowPopover(badgeDtl, (color, landCode) => {
                        activeDtlColor = color;
                        localStorage.setItem('topo_color_dtl', color);
                        if (landCode) localStorage.setItem('topo_code_dtl', landCode);
                        updateColorBadgesAndDrawer();
                    });
                }
            });
        }

        drawTypeRadios.forEach(radio => {
            radio.addEventListener('change', () => {
                updateColorBadgesAndDrawer();
            });
        });

        // 5.5 Dedup Lines button (Xóa Nét Trùng)
        if (dedupLineBtn) {
            dedupLineBtn.addEventListener('click', async () => {
                if (dedupLineBtn.disabled) return;
                cancelAllInteractiveModes();
                setUIVisibilityMode('scan');

                const statsEl = document.getElementById('topo-stats');
                const statsText = document.getElementById('topo-stats-text');
                const listEl = document.getElementById('topo-error-list');
                if (statsEl) statsEl.style.display = 'block';

                const updateProgress = (pct, text) => {
                    if (statsText) {
                        statsText.innerHTML = `
                            <div class="topo-progress-wrapper">
                                <div class="topo-progress-bar-bg">
                                    <div class="topo-progress-bar-fill" style="width: ${pct}%;"></div>
                                </div>
                                <div class="topo-progress-text">${text} (${pct}%)</div>
                            </div>
                        `;
                    }
                };

                dedupLineBtn.disabled = true;
                dedupLineBtn.innerHTML = `<span>Đang Quét...</span>`;

                try {
                    if (!window.__topoFindDuplicateLines || !window.__topoExecuteDedupLines) {
                        alert('Chưa nạp được module Xóa Trùng Nét!');
                        return;
                    }

                    const scanResult = await window.__topoFindDuplicateLines({
                        tolerance: 0.05,
                        onProgress: async (pct, msg) => updateProgress(pct, msg)
                    });

                    const { duplicateGroups, totalDuplicatesToRemove, totalLines } = scanResult;

                    if (!duplicateGroups || duplicateGroups.length === 0 || totalDuplicatesToRemove === 0) {
                        statsText.innerHTML = `<span class="topo-text-success">✅ Không phát hiện nét vẽ nào bị trùng lặp (Tổng số: ${totalLines} đường).</span>`;
                        if (listEl) {
                            listEl.innerHTML = `
                                <div class="topo-empty-state topo-success">
                                    Toàn bộ ${totalLines} đường vẽ đều là duy nhất, không phát hiện trùng lặp.
                                </div>
                            `;
                        }
                        return;
                    }

                    const confirmed = confirm(`🔍 Phát hiện ${duplicateGroups.length} nhóm đường trùng nhau (Tổng cộng ${totalDuplicatesToRemove} đường dư thừa trên ${totalLines} đường).\n\nBạn có muốn XÓA ${totalDuplicatesToRemove} đường trùng và chỉ GIỮ LẠI 1 đường duy nhất cho mỗi nét không?`);

                    if (!confirmed) {
                        statsText.innerHTML = `<span class="topo-text-muted">Đã hủy thao tác xóa nét trùng (${duplicateGroups.length} nhóm trùng được giữ nguyên).</span>`;
                        return;
                    }

                    updateProgress(90, `Đang xóa ${totalDuplicatesToRemove} nét trùng...`);

                    const execResult = await window.__topoExecuteDedupLines({
                        tolerance: 0.05,
                        onProgress: async (pct, msg) => updateProgress(pct, msg)
                    });

                    statsText.innerHTML = `<span class="topo-text-success">✅ Đã xóa thành công <b>${execResult.deletedCount}</b> nét trùng! Giữ lại ${execResult.keptCount} đường duy nhất.</span>`;

                    if (listEl) {
                        listEl.innerHTML = `
                            <div class="topo-empty-state topo-success">
                                🎉 Đã dọn sạch <b>${execResult.deletedCount}</b> đường vẽ trùng lặp.<br>
                                Tổng số đường hiện tại: <b>${totalLines - execResult.deletedCount}</b> đường.
                            </div>
                        `;
                    }

                    // Reset badge topo
                    const fabBadge = document.getElementById('topo-fab-badge');
                    if (fabBadge) fabBadge.style.display = 'none';

                } catch (err) {
                    console.error('[DedupLines] Error:', err);
                    if (statsText) statsText.innerHTML = `<span class="topo-text-danger">❌ Lỗi: ${err.message || err}</span>`;
                } finally {
                    dedupLineBtn.disabled = false;
                    dedupLineBtn.innerHTML = `<span>Xóa Trùng</span>`;
                }
            });
        }

        // 6. Smart Draw button (Hỗ trợ click Bật/Tắt chủ động)
        if (smartDrawBtn) {
            smartDrawBtn.addEventListener('click', () => {
                if (smartDrawBtn.disabled) return;

                // Nếu tính năng Vẽ Đường đang BẬT -> Click lần nữa sẽ TẮT VẼ chủ động!
                if (currentAreaMode === 'smart-draw') {
                    cancelAllInteractiveModes();
                    setActiveModeButton('topo-btn-scan');
                    setUIVisibilityMode('scan');
                    log('Smart Draw toggled OFF by user click.');
                    return;
                }

                // Nếu tính năng chưa bật -> BẬT VẼ
                cancelAllInteractiveModes();
                setUIVisibilityMode('interactive');
                setActiveModeButton('topo-btn-smart-draw');
                currentAreaMode = 'smart-draw';

                const dist = getDistanceInMeters();
                const side = document.querySelector('input[name="topo-active-draw-side"]:checked')?.value || 'right';

                const { type: landType, color } = getActiveDrawSettings();
                if (lineTypeBox) lineTypeBox.style.display = 'flex';

                if (window.__smartDrawerStart) {
                    const ok = window.__smartDrawerStart({ distance: dist, side: side, landType, color });
                    if (ok && areaBar) {
                        areaBar.classList.remove('topo-drawer-hidden');
                        setSmartDrawControlsVisible(true);
                        if (areaStatus) areaStatus.textContent = '';
                        if (areaFinishBtn) {
                            areaFinishBtn.style.display = 'inline-flex';
                            areaFinishBtn.textContent = '✓ Kết Thúc Nét Vẽ';
                            areaFinishBtn.disabled = false;
                        }
                        if (areaConfirmBtn) areaConfirmBtn.style.display = 'none';
                    }
                }
            });
        }

        // 7. Cut Line button (Cắt Nét Vẽ)
        if (cutLineBtn) {
            cutLineBtn.addEventListener('click', () => {
                if (cutLineBtn.disabled) return;

                // Nếu tính năng Cắt Nét đang BẬT -> Click lần nữa sẽ TẮT
                if (currentAreaMode === 'cut-line') {
                    cancelAllInteractiveModes();
                    setActiveModeButton('topo-btn-scan');
                    setUIVisibilityMode('scan');
                    return;
                }

                // Nếu tính năng chưa bật -> BẬT CẮT NÉT
                cancelAllInteractiveModes();
                setUIVisibilityMode('interactive');
                setActiveModeButton('topo-btn-cut-line');
                currentAreaMode = 'cut-line';
                setSmartDrawControlsVisible(false);

                ensureNative3dgSelectEditModeActive();

                if (window.__cutLineStart) {
                    const ok = window.__cutLineStart();
                    if (ok && areaBar) {
                        areaBar.classList.remove('topo-drawer-hidden');
                        if (areaStatus) areaStatus.textContent = '✂️ Chọn 2 điểm trên map (hoặc nhấp đúp) để cắt nét vẽ...';
                        if (areaFinishBtn) {
                            areaFinishBtn.style.display = 'inline-flex';
                            areaFinishBtn.textContent = '✓ Hoàn Thành Cắt';
                            areaFinishBtn.disabled = true;
                        }
                        if (areaConfirmBtn) areaConfirmBtn.style.display = 'none';
                    }
                }
            });
        }

        // ===== AREA SELECTION (COLOR vs DELETE) =====
        if (areaColorBtn) {
            areaColorBtn.addEventListener('click', () => {
                cancelAllInteractiveModes();
                updateAppModeUI();
                setUIVisibilityMode('interactive');
                setActiveModeButton('topo-btn-area-color');
                currentAreaMode = 'color';
                setSmartDrawControlsVisible(false);

                if (currentAppMode === '3d') {
                    if (window.__areaColorizer3DStart) {
                        const ok = window.__areaColorizer3DStart();
                        if (ok && areaBar) {
                            areaBar.classList.remove('topo-drawer-hidden');
                            if (areaStatus) areaStatus.textContent = '🎨 Đang vẽ vùng 3D (Chọn ít nhất 3 điểm)...';
                            if (areaFinishBtn) {
                                areaFinishBtn.style.display = 'inline-flex';
                                areaFinishBtn.textContent = '✓ Hoàn Thành Vùng';
                                areaFinishBtn.disabled = true;
                            }
                            if (areaConfirmBtn) areaConfirmBtn.style.display = 'none';
                        }
                    }
                    return;
                }

                if (window.__areaDeleterStart) {
                    const ok = window.__areaDeleterStart();
                    if (ok && areaBar) {
                        areaBar.classList.remove('topo-drawer-hidden');
                        if (areaStatus) areaStatus.textContent = '🎨 Đang vẽ vùng (Chọn ít nhất 3 điểm)...';
                        if (areaFinishBtn) {
                            areaFinishBtn.style.display = 'inline-flex';
                            areaFinishBtn.textContent = '✓ Hoàn Thành Vùng';
                            areaFinishBtn.disabled = true;
                        }
                        if (areaConfirmBtn) areaConfirmBtn.style.display = 'none';
                    }
                }
            });
        }

        if (areaDeleteBtn) {
            areaDeleteBtn.addEventListener('click', () => {
                cancelAllInteractiveModes();
                updateAppModeUI();
                setUIVisibilityMode('interactive');
                setActiveModeButton('topo-btn-area-delete');
                currentAreaMode = 'delete';
                setSmartDrawControlsVisible(false);
                if (window.__areaDeleterStart) {
                    const ok = window.__areaDeleterStart();
                    if (ok && areaBar) {
                        areaBar.classList.remove('topo-drawer-hidden');
                        if (areaStatus) areaStatus.textContent = '📍 Đang vẽ vùng (Chọn ít nhất 3 điểm)...';
                        if (areaFinishBtn) {
                            areaFinishBtn.style.display = 'inline-flex';
                            areaFinishBtn.textContent = '✓ Hoàn Thành Vùng';
                            areaFinishBtn.disabled = true;
                        }
                        if (areaConfirmBtn) areaConfirmBtn.style.display = 'none';
                    }
                }
            });
        }

        // Point added event
        document.addEventListener('topo:area-point-added', (e) => {
            const count = e.detail?.count || 0;
            if (areaStatus) {
                if (currentAreaMode === 'smart-draw') {
                    areaStatus.textContent = '';
                    if (areaFinishBtn) areaFinishBtn.disabled = (count < 2);
                    return;
                }
                if (count < 3) {
                    areaStatus.textContent = `📍 Đã chọn ${count} điểm (Cần thêm ${3 - count} điểm)`;
                } else {
                    areaStatus.textContent = `📍 Đã chọn ${count} điểm (Đủ điều kiện hoàn thành)`;
                }
            }
            if (areaFinishBtn) {
                areaFinishBtn.disabled = (count < 3);
            }
        });

        // Finish Selection or Smart Drawing
        if (areaFinishBtn) {
            areaFinishBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                if (currentAreaMode === 'cut-line') {
                    if (window.__cutLineFinish) window.__cutLineFinish();
                    return;
                }
                if (currentAreaMode === 'smart-draw') {
                    if (window.__smartDrawerFinish) window.__smartDrawerFinish();
                    cancelAllInteractiveModes();
                    setActiveModeButton('topo-btn-scan');
                    return;
                }

                if (currentAppMode === '3d') {
                    if (window.__areaColorizer3DFinish) {
                        const selected = window.__areaColorizer3DFinish();
                        if (selected && selected.length > 0) {
                            areaStatus.innerHTML = `🎨 <b style="color:#0284c7">Đã quét thấy ${selected.length} nét vẽ 3D</b>. Chọn màu bên dưới:`;
                            areaFinishBtn.style.display = 'none';
                            areaConfirmBtn.style.display = 'inline-flex';
                            areaConfirmBtn.textContent = `🎨 Chọn Màu (${selected.length} nét)`;

                            if (window.__areaColorizerShowPopover) {
                                window.__areaColorizerShowPopover(areaConfirmBtn, (colorHex, landCode) => {
                                    if (window.__areaColorizer3DApply) window.__areaColorizer3DApply(colorHex, landCode);
                                    cancelAllInteractiveModes();
                                    setActiveModeButton('topo-btn-scan');
                                });
                            }
                        } else {
                            areaStatus.textContent = '❌ Không tìm thấy nét vẽ 3D nào trong vùng đã chọn!';
                        }
                    }
                    return;
                }

                if (window.__areaDeleterFinish) {
                    const selected = window.__areaDeleterFinish();
                    if (selected && selected.length > 0) {
                        if (currentAreaMode === 'color') {
                            areaStatus.innerHTML = `🎨 <b style="color:#0284c7">Đã quét thấy ${selected.length} đường</b>. Chọn màu bên dưới:`;
                            areaFinishBtn.style.display = 'none';
                            areaConfirmBtn.style.display = 'inline-flex';
                            areaConfirmBtn.textContent = `🎨 Chọn Màu (${selected.length} đường)`;

                            if (window.__areaColorizerShowPopover) {
                                window.__areaColorizerShowPopover(areaConfirmBtn);
                            }
                        } else {
                            areaStatus.innerHTML = `⚠️ <b style="color:#dc2626">Đã quét thấy ${selected.length} đường</b> trong vùng.`;
                            areaFinishBtn.style.display = 'none';
                            areaConfirmBtn.style.display = 'inline-flex';
                            areaConfirmBtn.textContent = `🗑️ Xóa ${selected.length} đường`;
                        }
                    } else {
                        areaStatus.textContent = '❌ Không tìm thấy đường nào trong vùng đã chọn!';
                    }
                }
            });
        }

        // Confirm Action (Delete or Show Color Popover)
        function handleConfirmAction() {
            if (currentAreaMode === 'color') {
                if (currentAppMode === '3d') {
                    if (window.__areaColorizerShowPopover) {
                        window.__areaColorizerShowPopover(areaConfirmBtn, (colorHex, landCode) => {
                            if (window.__areaColorizer3DApply) window.__areaColorizer3DApply(colorHex, landCode);
                            cancelAllInteractiveModes();
                            setActiveModeButton('topo-btn-scan');
                        });
                    }
                    return;
                }
                if (window.__areaColorizerShowPopover) {
                    window.__areaColorizerShowPopover(areaConfirmBtn);
                }
            } else {
                handleConfirmDelete();
            }
        }

        function handleConfirmDelete() {
            const count = window.__areaDeleterGetSelectedCount ? window.__areaDeleterGetSelectedCount() : 0;
            if (count === 0) return;

            if (window.__areaDeleterDelete) {
                const deleted = window.__areaDeleterDelete();
                log(`✅ Successfully deleted ${deleted} lines from map.`);
                cancelAllInteractiveModes();
                setActiveModeButton('topo-btn-scan');
            }
        }

        if (areaConfirmBtn) {
            areaConfirmBtn.addEventListener('click', handleConfirmAction);
        }

        // Cancel Area Selection / Drawing Mode
        if (areaCancelBtn) {
            areaCancelBtn.addEventListener('click', () => {
                cancelAllInteractiveModes();
                setActiveModeButton('topo-btn-scan');
            });
        }

        // Keyboard "Delete" or "Backspace" shortcut for deletion confirmation
        document.addEventListener('keydown', (e) => {
            if ((e.key === 'Delete' || e.key === 'Backspace') && !e.target.matches('input, textarea')) {
                const count = window.__areaDeleterGetSelectedCount ? window.__areaDeleterGetSelectedCount() : 0;
                if (count > 0) {
                    e.preventDefault();
                    handleConfirmDelete();
                }
            }
        });

        // Initialize Mode Router after all handlers are defined
        initModeRouter();
    }

    // ===== DRAGGABLE HELPER =====
    function makeDraggable(element, handle, isFab = false) {
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        let startX = 0, startY = 0;
        let hasMoved = false;

        handle.style.cursor = 'grab';
        handle.addEventListener('mousedown', dragMouseDown);

        function dragMouseDown(e) {
            if (e.target.closest('.topo-header-actions')) return;

            hasMoved = false;
            startX = e.clientX;
            startY = e.clientY;
            pos3 = e.clientX;
            pos4 = e.clientY;

            handle.style.cursor = 'grabbing';

            document.addEventListener('mouseup', closeDragElement);
            document.addEventListener('mousemove', elementDrag);
        }

        function elementDrag(e) {
            const dx = Math.abs(e.clientX - startX);
            const dy = Math.abs(e.clientY - startY);
            if (dx > 4 || dy > 4) {
                hasMoved = true;
                if (isFab) {
                    element.dataset.dragging = "true";
                } else {
                    element.dataset.dragged = "true";
                }
            }

            if (!hasMoved) return;

            pos1 = pos3 - e.clientX;
            pos2 = pos4 - e.clientY;
            pos3 = e.clientX;
            pos4 = e.clientY;

            const rect = element.getBoundingClientRect();
            let newTop = rect.top - pos2;
            let newLeft = rect.left - pos1;

            newTop = Math.max(5, Math.min(window.innerHeight - rect.height - 5, newTop));
            newLeft = Math.max(5, Math.min(window.innerWidth - rect.width - 5, newLeft));

            element.style.top = newTop + 'px';
            element.style.left = newLeft + 'px';
            element.style.bottom = 'auto';
            element.style.right = 'auto';
        }

        function closeDragElement(e) {
            handle.style.cursor = 'grab';
            document.removeEventListener('mouseup', closeDragElement);
            document.removeEventListener('mousemove', elementDrag);

            if (isFab && hasMoved) {
                setTimeout(() => {
                    delete element.dataset.dragging;
                }, 100);
            }
        }
    }

    // ===== EXECUTE TOPOLOGY SCAN =====
    async function executeScan() {
        const scanBtn = document.getElementById('topo-btn-scan');
        const statsText = document.getElementById('topo-stats-text');
        const statsEl = document.getElementById('topo-stats');
        const fabBadge = document.getElementById('topo-fab-badge');

        const tolerance = window.__topoConfig?.defaultTolerance || 0.5;

        scanBtn.disabled = true;
        scanBtn.innerHTML = `<span>⏳ Đang quét...</span>`;

        if (statsEl) statsEl.style.display = 'block';

        const updateProgress = (pct, msg) => {
            const clamped = Math.min(100, Math.max(0, Math.round(pct)));
            if (statsText) {
                statsText.innerHTML = `
                    <div class="topo-progress-container">
                        <div class="topo-progress-info">
                            <span class="topo-progress-label">${msg || 'Đang quét dữ liệu bản đồ...'}</span>
                            <span class="topo-progress-percent">${clamped}%</span>
                        </div>
                        <div class="topo-progress-track">
                            <div class="topo-progress-fill" style="width: ${clamped}%"></div>
                        </div>
                    </div>
                `;
            }
        };

        updateProgress(0, 'Đang chuẩn bị quét dữ liệu...');

        try {
            if (currentAppMode === '3d') {
                if (window.__topoRunCheck3D) {
                    currentErrors = await window.__topoRunCheck3D({
                        tolerance,
                        onProgress: async (percent, statusText) => {
                            updateProgress(percent, statusText);
                        }
                    });
                    renderErrorList(currentErrors);

                    if (currentErrors.length > 0) {
                        fabBadge.textContent = currentErrors.length;
                        fabBadge.style.display = 'flex';
                    } else {
                        fabBadge.style.display = 'none';
                    }
                } else {
                    if (statsText) statsText.textContent = `Chưa có module quét 3D.`;
                }
                return;
            }

            if (window.__topoRunCheck) {
                currentErrors = await window.__topoRunCheck({
                    tolerance,
                    onProgress: async (percent, statusText) => {
                        updateProgress(percent, statusText);
                    }
                });
                renderErrorList(currentErrors);

                if (currentErrors.length > 0) {
                    fabBadge.textContent = currentErrors.length;
                    fabBadge.style.display = 'flex';
                } else {
                    fabBadge.style.display = 'none';
                }
            } else {
                if (statsText) statsText.textContent = `❌ Lỗi: Chưa nạp được Engine kiểm tra!`;
            }
        } catch (err) {
            console.error('[CheckTopo] Error during scan:', err);
            if (statsText) statsText.innerHTML = `<span class="topo-text-danger">❌ Lỗi khi quét: ${err.message || err}</span>`;
        } finally {
            scanBtn.disabled = false;
            scanBtn.innerHTML = `<span>Check Topo</span>`;
        }
    }

    function clearTopologyCheckResults() {
        currentErrors = [];
        activeErrorId = null;

        if (window.__topoClear3DOverlays) {
            window.__topoClear3DOverlays();
        }
        if (window.__topoClearHighlight) {
            window.__topoClearHighlight();
        }

        const fabBadge = document.getElementById('topo-fab-badge');
        if (fabBadge) fabBadge.style.display = 'none';

        const statsText = document.getElementById('topo-stats-text');
        const listEl = document.getElementById('topo-error-list');

        if (statsText) {
            statsText.innerHTML = `<span class="topo-text-muted"> Đã xóa toàn bộ kết quả quét topology.</span>`;
        }

        if (listEl) {
            listEl.innerHTML = `
                <div class="topo-empty-state">
                    Bấm <b>Check Topo</b> để quét lại vị trí lỗi trên bản đồ.
                </div>
            `;
        }
    }

    // ===== RENDER ERROR LIST =====
    function renderErrorList(errors) {
        const listEl = document.getElementById('topo-error-list');
        const statsText = document.getElementById('topo-stats-text');
        const statsEl = document.getElementById('topo-stats');

        if (statsEl) statsEl.style.display = 'block';

        if (!errors || errors.length === 0) {
            statsText.innerHTML = `<span class="topo-text-success">✅ Không có lỗi topology (Khép kín, không trùng nét).</span>`;
            listEl.innerHTML = `
                <div class="topo-empty-state topo-success">
                    Không phát hiện vị trí hở ranh giới hoặc trùng nét vẽ.
                </div>
            `;
            if (window.__topoClearHighlight) window.__topoClearHighlight();
            return;
        }

        if (currentAppMode === '3d') {
            if (window.__topoRender3DOverlays) {
                window.__topoRender3DOverlays(errors);
            }
        } else {
            if (window.__topoRenderAllOverlays) {
                window.__topoRenderAllOverlays(errors);
            }
        }

        const dangleCount = errors.filter(e => e.type === 'dangle').length;
        const dupCount = errors.filter(e => e.type === 'duplicate').length;

        let summaryParts = [];
        if (dangleCount > 0) summaryParts.push(`<b>${dangleCount}</b> hở ranh giới`);
        if (dupCount > 0) summaryParts.push(`<b>${dupCount}</b> trùng nét`);

        statsText.innerHTML = `
            <div class="topo-stats-header-row">
                <span class="topo-text-danger">⚠️ Phát hiện <b>${errors.length}</b> lỗi (${summaryParts.join(', ')})</span>
                <button type="button" class="topo-clear-errors-btn" id="topo-btn-clear-errors" title="Xóa toàn bộ kết quả quét Topo">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                    <span>Xóa</span>
                </button>
            </div>
        `;

        const clearBtn = document.getElementById('topo-btn-clear-errors');
        if (clearBtn) {
            clearBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                clearTopologyCheckResults();
            });
        }

        listEl.innerHTML = '';

        let renderedIndex = 0;
        const BATCH_SIZE = 50;

        function renderNextBatch() {
            if (renderedIndex >= errors.length) return;
            const fragment = document.createDocumentFragment();
            const endIdx = Math.min(renderedIndex + BATCH_SIZE, errors.length);

            for (let idx = renderedIndex; idx < endIdx; idx++) {
                const err = errors[idx];
                const item = document.createElement('div');
                item.className = 'topo-error-item';
                if (err.type === 'duplicate') item.classList.add('--duplicate');
                if (err.id === activeErrorId) item.classList.add('--active');

                const isGeo = Math.abs(err.coord[0]) <= 180 && Math.abs(err.coord[1]) <= 90;
                const x = isGeo ? err.coord[0].toFixed(6) : err.coord[0].toFixed(2);
                const y = isGeo ? err.coord[1].toFixed(6) : err.coord[1].toFixed(2);

                if (err.type === 'duplicate') {
                    item.innerHTML = `
                        <div class="topo-item-title topo-title-dup">🟧 Lỗi ${idx + 1}: Trùng nét</div>
                        <div class="topo-item-coord">Tọa độ: [${x}, ${y}]</div>
                    `;
                } else {
                    item.innerHTML = `
                        <div class="topo-item-title">🔴 Lỗi ${idx + 1}: Chưa khép thửa</div>
                        <div class="topo-item-coord">Tọa độ: [${x}, ${y}]</div>
                    `;
                }

                item.addEventListener('click', () => {
                    selectAndZoomError(err, item);
                });

                item.addEventListener('dblclick', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                });

                fragment.appendChild(item);
            }

            listEl.appendChild(fragment);
            renderedIndex = endIdx;
        }

        // Render đợt đầu tiên 50 lỗi (tải tức thì < 2ms)
        renderNextBatch();

        // Tự động tải thêm khi cuộn gần tới đáy danh sách
        listEl.onscroll = () => {
            if (listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 150) {
                renderNextBatch();
            }
        };

        // Automatically scroll smoothly and stretch panel height
        setTimeout(() => {
            try {
                if (statsEl) statsEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            } catch (e) { }
            try {
                if (listEl) listEl.scrollTo({ top: 0, behavior: 'smooth' });
            } catch (e) { }
            if (typeof animatePanelHeightToContent === 'function') animatePanelHeightToContent();
        }, 60);
    }

    // ===== SELECT AND ZOOM TO ERROR (WITH TOGGLE OFF / TẮT SÁNG FEATURE) =====
    function selectAndZoomError(err, itemElement) {
        if (activeErrorId === err.id) {
            // Re-clicking active item TOGGLES OFF (Tắt sáng) highlight for this specific line!
            activeErrorId = null;
            if (itemElement) itemElement.classList.remove('--active');
            if (currentAppMode === '3d') {
                if (window.__topoToggle3DHighlight) {
                    window.__topoToggle3DHighlight(err.id, false);
                }
            } else {
                if (window.__topoToggleHighlight) {
                    window.__topoToggleHighlight(err.id, false);
                }
            }
            return;
        }

        activeErrorId = err.id;

        document.querySelectorAll('.topo-error-item').forEach(el => el.classList.remove('--active'));
        if (itemElement) itemElement.classList.add('--active');

        if (currentAppMode === '3d') {
            if (window.__topoToggle3DHighlight) {
                window.__topoToggle3DHighlight(err.id, true);
            }
            if (window.__topoZoomToError3D) {
                window.__topoZoomToError3D(err);
            }
            return;
        }

        if (window.__topoToggleHighlight) {
            window.__topoToggleHighlight(err.id, true);
        }

        const defaultZoom = window.__topoConfig?.defaultZoom || 24;

        if (window.__topoZoomToError) {
            window.__topoZoomToError(err.coord, defaultZoom, err);
        }
    }

    // ===== INIT UI =====
    function initUI() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', createUI);
        } else {
            createUI();
        }
    }

    initUI();
    setTimeout(createUI, 500);
    setTimeout(createUI, 1500);

})();
