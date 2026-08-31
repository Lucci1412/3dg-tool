// ============================================================
// 3DG Topology Checker — Module: Shortcuts & Map Navigation Manager
// Quản lý Phím Tắt Nhanh & Điều Hướng Di Chuyển Màn Hình (WASD / Mũi tên)
// ============================================================

(function () {
    'use strict';

    function log(...args) {
        // console.log('[ShortcutsManager]', ...args);
    }

    // Default Storage Keys
    const STORAGE_KEY_UP = 'topo_shortcut_nav_up';
    const STORAGE_KEY_DOWN = 'topo_shortcut_nav_down';
    const STORAGE_KEY_LEFT = 'topo_shortcut_nav_left';
    const STORAGE_KEY_RIGHT = 'topo_shortcut_nav_right';
    const STORAGE_KEY_SPEED = 'topo_shortcut_nav_speed';
    const STORAGE_KEY_TOOL_TOGGLE = 'topo_shortcut_select_edit';
    const STORAGE_KEY_NAV_ENABLED = 'topo_shortcut_nav_enabled';

    // State
    const settings = {
        navEnabled: localStorage.getItem(STORAGE_KEY_NAV_ENABLED) !== 'false',
        keyUp: localStorage.getItem(STORAGE_KEY_UP) || 'W',
        keyDown: localStorage.getItem(STORAGE_KEY_DOWN) || 'S',
        keyLeft: localStorage.getItem(STORAGE_KEY_LEFT) || 'A',
        keyRight: localStorage.getItem(STORAGE_KEY_RIGHT) || 'D',
        speed: parseFloat(localStorage.getItem(STORAGE_KEY_SPEED) || '24'), // pixels per frame
        keyToolToggle: localStorage.getItem(STORAGE_KEY_TOOL_TOGGLE) || 'Space'
    };

    // Active pressed keys tracking for smooth continuous glide
    const activePressedKeys = new Set();
    let animFrameId = null;
    let isRecording = false;
    let recordingTarget = null;
    let recordingCallback = null;

    // Ignore text editing elements
    function isTextEditingElement(el) {
        if (!el) return false;
        if (el.isContentEditable) return true;
        const tag = (el.tagName || '').toLowerCase();
        if (tag === 'textarea') return true;
        if (tag === 'input') {
            const type = (el.type || '').toLowerCase();
            if (['text', 'password', 'search', 'email', 'number', 'tel', 'url'].includes(type)) {
                return true;
            }
        }
        return false;
    }

    // Normalize key code string
    function normalizeKey(e) {
        if (!e) return '';
        if (e.code === 'Space' || e.key === ' ') return 'Space';
        if (e.code === 'ArrowUp' || e.key === 'ArrowUp') return 'ArrowUp';
        if (e.code === 'ArrowDown' || e.key === 'ArrowDown') return 'ArrowDown';
        if (e.code === 'ArrowLeft' || e.key === 'ArrowLeft') return 'ArrowLeft';
        if (e.code === 'ArrowRight' || e.key === 'ArrowRight') return 'ArrowRight';
        if (e.key && e.key.length === 1) return e.key.toUpperCase();
        return e.key || e.code;
    }

    function isKeyMatch(eventKey, configuredKey) {
        if (!eventKey || !configuredKey) return false;
        const ek = eventKey.toUpperCase();
        const ck = configuredKey.toUpperCase();
        if (ck === 'SPACE' && (ek === ' ' || ek === 'SPACE')) return true;
        if (ck === 'ARROWUP' && (ek === 'ARROWUP' || ek === 'UP')) return true;
        if (ck === 'ARROWDOWN' && (ek === 'ARROWDOWN' || ek === 'DOWN')) return true;
        if (ck === 'ARROWLEFT' && (ek === 'ARROWLEFT' || ek === 'LEFT')) return true;
        if (ck === 'ARROWRIGHT' && (ek === 'ARROWRIGHT' || ek === 'RIGHT')) return true;
        return ek === ck;
    }

    // ===== MAP PANNING ENGINE (2D OPENLAYERS & 3D CESIUM) =====
    function panMapStep(deltaX, deltaY) {
        // 1. Try 2D OpenLayers Map
        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        if (map && typeof map.getView === 'function') {
            try {
                const view = map.getView();
                if (view) {
                    const center = view.getCenter();
                    const res = typeof view.getResolution === 'function' ? view.getResolution() : 1.0;
                    if (center && Array.isArray(center)) {
                        const moveX = deltaX * res;
                        const moveY = deltaY * res;
                        view.setCenter([center[0] + moveX, center[1] + moveY]);
                        return true;
                    }
                }
            } catch (e) { }
        }

        // 2. Try 3D Cesium Viewer
        const viewer = window.__topoCesiumViewer;
        if (viewer && viewer.camera) {
            try {
                const camera = viewer.camera;
                const height = camera.positionCartographic ? camera.positionCartographic.height : 1000;
                const moveDist = Math.max(1, height * 0.015);
                if (deltaY > 0) camera.moveUp(moveDist);
                if (deltaY < 0) camera.moveDown(moveDist);
                if (deltaX < 0) camera.moveLeft(moveDist);
                if (deltaX > 0) camera.moveRight(moveDist);
                return true;
            } catch (e) { }
        }

        return false;
    }

    // Continuous Animation Loop for smooth gliding
    function startGlideLoop() {
        if (animFrameId) return;

        function loop() {
            if (activePressedKeys.size === 0 || !settings.navEnabled) {
                animFrameId = null;
                return;
            }

            let dx = 0;
            let dy = 0;

            for (const key of activePressedKeys) {
                if (isKeyMatch(key, settings.keyUp)) dy += 1;
                if (isKeyMatch(key, settings.keyDown)) dy -= 1;
                if (isKeyMatch(key, settings.keyLeft)) dx -= 1;
                if (isKeyMatch(key, settings.keyRight)) dx += 1;
            }

            if (dx !== 0 || dy !== 0) {
                // Normalize diagonal movement speed
                let factor = 1.0;
                if (dx !== 0 && dy !== 0) {
                    factor = 0.7071; // 1 / sqrt(2)
                }

                const stepPixels = settings.speed * factor;
                panMapStep(dx * stepPixels, dy * stepPixels);
            }

            animFrameId = requestAnimationFrame(loop);
        }

        animFrameId = requestAnimationFrame(loop);
    }

    // ===== GLOBAL KEY EVENT LISTENERS =====
    window.addEventListener('keydown', (e) => {
        // 1. If currently recording a new key shortcut
        if (isRecording) {
            e.preventDefault();
            e.stopPropagation();
            const pressed = normalizeKey(e);
            if (recordingCallback) {
                recordingCallback(pressed);
            }
            stopRecording();
            return;
        }

        // 2. Ignore when typing text in input / textarea
        if (isTextEditingElement(e.target) || isTextEditingElement(document.activeElement)) {
            return;
        }

        const pressedKey = normalizeKey(e);

        // 3. Check Map Navigation Keys (WASD / Arrows)
        if (settings.navEnabled) {
            const isNavKey = isKeyMatch(pressedKey, settings.keyUp) ||
                             isKeyMatch(pressedKey, settings.keyDown) ||
                             isKeyMatch(pressedKey, settings.keyLeft) ||
                             isKeyMatch(pressedKey, settings.keyRight);

            if (isNavKey) {
                e.preventDefault();
                e.stopPropagation();
                activePressedKeys.add(pressedKey);
                startGlideLoop();
                return;
            }
        }
    }, true);

    window.addEventListener('keyup', (e) => {
        const pressedKey = normalizeKey(e);
        activePressedKeys.delete(pressedKey);
        for (const k of activePressedKeys) {
            if (k.toUpperCase() === pressedKey.toUpperCase()) {
                activePressedKeys.delete(k);
            }
        }
    }, true);

    // Cancel gliding on window blur
    window.addEventListener('blur', () => {
        activePressedKeys.clear();
    });

    // ===== RECORDING API =====
    function startRecording(targetName, callback) {
        isRecording = true;
        recordingTarget = targetName;
        recordingCallback = callback;
    }

    function stopRecording() {
        isRecording = false;
        recordingTarget = null;
        recordingCallback = null;
    }

    // ===== PRESET APPLY =====
    function applyPreset(presetName) {
        if (presetName === 'WASD') {
            saveSetting('keyUp', 'W');
            saveSetting('keyDown', 'S');
            saveSetting('keyLeft', 'A');
            saveSetting('keyRight', 'D');
        } else if (presetName === 'ARROWS') {
            saveSetting('keyUp', 'ArrowUp');
            saveSetting('keyDown', 'ArrowDown');
            saveSetting('keyLeft', 'ArrowLeft');
            saveSetting('keyRight', 'ArrowRight');
        }
    }

    function saveSetting(key, val) {
        settings[key] = val;
        if (key === 'keyUp') localStorage.setItem(STORAGE_KEY_UP, val);
        if (key === 'keyDown') localStorage.setItem(STORAGE_KEY_DOWN, val);
        if (key === 'keyLeft') localStorage.setItem(STORAGE_KEY_LEFT, val);
        if (key === 'keyRight') localStorage.setItem(STORAGE_KEY_RIGHT, val);
        if (key === 'speed') localStorage.setItem(STORAGE_KEY_SPEED, String(val));
        if (key === 'keyToolToggle') localStorage.setItem(STORAGE_KEY_TOOL_TOGGLE, val);
        if (key === 'navEnabled') localStorage.setItem(STORAGE_KEY_NAV_ENABLED, val ? 'true' : 'false');
    }

    // ===== EXPOSE GLOBAL SHORTCUTS API =====
    window.__topoShortcuts = {
        getSettings: () => ({ ...settings }),
        setSetting: saveSetting,
        applyPreset: applyPreset,
        startRecording: startRecording,
        stopRecording: stopRecording,
        isRecording: () => isRecording,
        panMapStep: panMapStep
    };

    log('Shortcuts & Map Navigation Module loaded successfully.');

})();
