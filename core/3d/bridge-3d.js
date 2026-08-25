// ============================================================
// 3DG Map Tools — Core 3D Bridge & Engine Detector (Chế độ 3D Mesh)
// - Khớp 100% cấu trúc Component 3DG (props.groups, onSetColor, onZoom, Memo hooks)
// - Duyệt toàn diện React Fiber Tree từ root (depth-first traversal qua child/sibling)
// - Hỗ trợ cả danh sách phẳng { kind: 'group', g } và { kind: 'point', g, p }
// - Chiếu toạ độ không gian 2D/3D phục vụ chọn vùng và đổi màu
// ============================================================

(function () {
    'use strict';

    function log(...args) {
        // console.log('[Bridge3D]', ...args);
    }

    // ===== 3D ENGINE / VIEWER DETECTOR =====
    function find3dViewer() {
        if (window.viewer && (window.viewer.scene || window.viewer.camera)) {
            return window.viewer;
        }
        if (window.__cesiumViewer && (window.__cesiumViewer.scene || window.__cesiumViewer.camera)) {
            return window.__cesiumViewer;
        }

        const canvas3d = document.querySelector('canvas.cesium-widget') || 
                         document.querySelector('div.cesium-viewer') ||
                         document.querySelector('.cesium-widget') ||
                         document.querySelector('canvas[data-engine="three.js"]') ||
                         document.querySelector('canvas');

        if (!canvas3d) return null;

        if (canvas3d.viewer) return canvas3d.viewer;
        if (canvas3d.parentElement?.viewer) return canvas3d.parentElement.viewer;

        let el = canvas3d.parentElement;
        while (el && el !== document.body) {
            const key = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactContainer'));
            if (key) {
                let node = el[key];
                for (let d = 0; d < 250 && node; d++) {
                    try {
                        const props = node.memoizedProps;
                        const state = node.memoizedState;
                        const stateNode = node.stateNode;

                        if (props?.viewer?.scene || props?.viewer?.camera) return props.viewer;
                        if (props?.scene?.camera) return props;
                        if (stateNode?.viewer?.scene) return stateNode.viewer;
                        if (stateNode?.scene?.camera) return stateNode;

                        let s = state;
                        while (s) {
                            if (s.memoizedState?.current) {
                                const cur = s.memoizedState.current;
                                if (cur?.scene || cur?.camera || cur?.entities) return cur;
                            }
                            if (s.memoizedState?.viewer) return s.memoizedState.viewer;
                            if (s.memoizedState?.scene) return s.memoizedState;
                            s = s.next;
                        }
                    } catch (e) {}
                    node = node.return;
                }
                break;
            }
            el = el.parentElement;
        }

        return null;
    }

    // ===== PROJECT 3D GEO COORD (LNG, LAT, HEIGHT) TO 2D SCREEN PIXELS =====
    function project3dToScreen(lng, lat, height = 0) {
        const viewer = window.__topo3dViewer || find3dViewer();
        if (!viewer) return null;

        const scene = viewer.scene || viewer;
        if (!scene) return null;

        const ellipsoid = scene.globe?.ellipsoid || scene.mapProjection?.ellipsoid;
        if (ellipsoid && typeof scene.cartesianToCanvasCoordinates === 'function') {
            try {
                const radLng = (lng * Math.PI) / 180;
                const radLat = (lat * Math.PI) / 180;
                const cartesian = ellipsoid.cartographicToCartesian({
                    longitude: radLng,
                    latitude: radLat,
                    height: height || 0
                });
                if (cartesian) {
                    const winPos = scene.cartesianToCanvasCoordinates(cartesian);
                    if (winPos && typeof winPos.x === 'number') {
                        return [winPos.x, winPos.y];
                    }
                }
            } catch (e) {}
        }

        if (window.Cesium && window.Cesium.Cartesian3 && window.Cesium.SceneTransforms) {
            try {
                const cart = window.Cesium.Cartesian3.fromDegrees(lng, lat, height || 0);
                const pos = window.Cesium.SceneTransforms.wgs84ToWindowCoordinates(scene, cart);
                if (pos && typeof pos.x === 'number') {
                    return [pos.x, pos.y];
                }
            } catch (e) {}
        }

        return null;
    }

    // ===== UNPROJECT 2D SCREEN PIXELS (X, Y) TO GEO COORDS (LNG, LAT, HEIGHT) =====
    function unprojectScreenToGeo(screenX, screenY) {
        const viewer = window.__topo3dViewer || find3dViewer();
        if (!viewer) return null;

        const scene = viewer.scene || viewer;
        const camera = viewer.camera || scene?.camera;
        const ellipsoid = scene?.globe?.ellipsoid || scene?.mapProjection?.ellipsoid;

        if (scene) {
            try {
                const windowCoord = (window.Cesium && window.Cesium.Cartesian2) ? 
                                    new window.Cesium.Cartesian2(screenX, screenY) : 
                                    { x: screenX, y: screenY };

                // 1. Ưu tiên pickPosition trực tiếp trên 3D Mesh / 3D Tiles (độ cao chính xác nhất)
                if (typeof scene.pickPosition === 'function') {
                    const cartesian = scene.pickPosition(windowCoord);
                    if (cartesian && window.Cesium && window.Cesium.Cartographic) {
                        const carto = window.Cesium.Cartographic.fromCartesian(cartesian);
                        if (carto && typeof carto.latitude === 'number') {
                            return [
                                (carto.longitude * 180) / Math.PI,
                                (carto.latitude * 180) / Math.PI,
                                carto.height || 0
                            ];
                        }
                    }
                }

                // 2. Fallback: Ray pick trên Globe Surface
                if (camera && typeof camera.getPickRay === 'function' && scene.globe && typeof scene.globe.pick === 'function') {
                    const ray = camera.getPickRay(windowCoord);
                    const cartesian = scene.globe.pick(ray, scene);
                    if (cartesian && ellipsoid) {
                        const carto = ellipsoid.cartesianToCartographic(cartesian);
                        if (carto) {
                            return [
                                (carto.longitude * 180) / Math.PI,
                                (carto.latitude * 180) / Math.PI,
                                carto.height || 0
                            ];
                        }
                    }
                }

                // 3. Fallback: Pick Ellipsoid
                if (camera && typeof camera.pickEllipsoid === 'function' && ellipsoid) {
                    const cartesian = camera.pickEllipsoid(windowCoord);
                    if (cartesian) {
                        const carto = ellipsoid.cartesianToCartographic(cartesian);
                        if (carto) {
                            return [
                                (carto.longitude * 180) / Math.PI,
                                (carto.latitude * 180) / Math.PI,
                                carto.height || 0
                            ];
                        }
                    }
                }
            } catch (e) {}
        }

        return null;
    }

    // ===== COLLECT ALL 3D STROKES / GROUPS (TREE TRAVERSAL + MEMO HOOKS + LIVE CESIUM ENTITIES) =====
    function collectAll3dGroups() {
        const groupsMap = new Map(); // groupId -> item { group, onSetColor, onZoom, onSelect... }
        const pointsByGroupId = new Map(); // groupId -> Array<Point>

        function sanitizePoints(rawPoints) {
            if (!rawPoints) return [];
            let pts = rawPoints;
            if (typeof pts === 'string') {
                try { pts = JSON.parse(pts); } catch(e) { return []; }
            }
            if (!Array.isArray(pts)) return [];
            return pts.filter(p => p && typeof p.lng === 'number' && typeof p.lat === 'number');
        }

        function registerGroup(rawGroup, callbacks = {}) {
            if (!rawGroup || !rawGroup.id) return;
            const gId = String(rawGroup.id);
            const pts = sanitizePoints(rawGroup.points || rawGroup.coordinates);
            const existing = groupsMap.get(gId);

            if (!existing) {
                const colorFnSet = new Set();
                [
                    callbacks.onSetColor,
                    callbacks.setGroupColor,
                    callbacks.onColorChange,
                    callbacks.onChangeColor,
                    callbacks.setColor,
                    callbacks.onUpdateGroup,
                    callbacks.onGroupUpdate,
                    callbacks.onChange
                ].forEach(fn => { if (typeof fn === 'function') colorFnSet.add(fn); });

                const item = {
                    group: {
                        ...rawGroup,
                        id: gId,
                        points: pts
                    },
                    id: gId,
                    name: rawGroup.name || 'Nhóm',
                    connectMode: rawGroup.connectMode || 'line',
                    isActive: Boolean(callbacks.activeGroupId === gId || callbacks.selection?.groupId === gId),
                    _colorFns: colorFnSet,
                    onZoom: () => {
                        if (typeof callbacks.onZoom === 'function') {
                            try { callbacks.onZoom(gId); } catch(e) { callbacks.onZoom(rawGroup); }
                        }
                    },
                    onSelect: () => {
                        if (typeof callbacks.onSelect === 'function') {
                            try { callbacks.onSelect(gId); } catch(e) { callbacks.onSelect(rawGroup); }
                        }
                    },
                    onRemove: () => {
                        if (typeof callbacks.onRemove === 'function') {
                            try { callbacks.onRemove(gId); } catch(e) { callbacks.onRemove(rawGroup); }
                        }
                    },
                    onToggleHidden: () => {
                        if (typeof callbacks.onToggleHidden === 'function') {
                            try { callbacks.onToggleHidden(gId); } catch(e) {}
                        }
                    },
                    onRename: (newName) => {
                        if (typeof callbacks.onRename === 'function') {
                            try { callbacks.onRename(gId, newName); } catch(e) {}
                        }
                    },
                    onSetConnectMode: (mode) => {
                        if (typeof callbacks.onSetConnectMode === 'function') {
                            try { callbacks.onSetConnectMode(gId, mode); } catch(e) {}
                        }
                    },
                    onSetColor: (color, landCode) => {
                        // 1. Cập nhật an toàn vào item.group (không mutate trực tiếp frozen rawGroup)
                        try { item.group.color = color; } catch(e) {}
                        if (landCode) { try { item.group.landType = landCode; } catch(e) {} }

                        // 2. Gọi các hàm callback đổi màu từ React Component 3DG
                        item._colorFns.forEach(fn => {
                            try {
                                fn(gId, color, landCode);
                            } catch (e1) {
                                try {
                                    fn(color, gId);
                                } catch (e2) {
                                    try { fn({ ...rawGroup, color, landType: landCode }); } catch (e3) {
                                        try { fn(color); } catch (e4) {}
                                    }
                                }
                            }
                        });

                        // 3. Gọi fallback nếu có setter toàn cục
                        if (window.__topoNativeSetGroupColor && !item._colorFns.has(window.__topoNativeSetGroupColor)) {
                            try {
                                window.__topoNativeSetGroupColor(gId, color, landCode);
                            } catch (nErr) {}
                        }

                        // 4. Cập nhật trực tiếp màu hiển thị trên Cesium 3D Scene
                        try {
                            const viewer = window.__topo3dViewer || find3dViewer();
                            if (viewer && viewer.entities && window.Cesium) {
                                const cesiumColor = window.Cesium.Color.fromCssColorString(color);
                                const ent = viewer.entities.getById(gId) || 
                                            viewer.entities.getById(`group-${gId}`) || 
                                            viewer.entities.getById(`polyline-${gId}`) ||
                                            viewer.entities.getById(`backup-line-${gId}`);
                                if (ent && ent.polyline) {
                                    ent.polyline.material = cesiumColor;
                                } else {
                                    viewer.entities.values.forEach(e => {
                                        if (e.polyline && (e.id === gId || e.name === rawGroup.name || String(e.id).includes(gId))) {
                                            e.polyline.material = cesiumColor;
                                        }
                                    });
                                }
                            }
                        } catch (cesiumErr) {}
                    },
                    ...callbacks
                };
                groupsMap.set(gId, item);
            } else {
                if (pts.length > 0 && (!existing.group.points || existing.group.points.length === 0)) {
                    existing.group.points = pts;
                }
                // Bổ sung callback mới vào Set mà không tạo hàm bọc đệ quy
                [
                    callbacks.onSetColor,
                    callbacks.setGroupColor,
                    callbacks.onColorChange,
                    callbacks.onChangeColor,
                    callbacks.setColor,
                    callbacks.onUpdateGroup,
                    callbacks.onGroupUpdate,
                    callbacks.onChange
                ].forEach(fn => {
                    if (typeof fn === 'function' && existing._colorFns) {
                        existing._colorFns.add(fn);
                    }
                });
                if (!existing.onZoom && typeof callbacks.onZoom === 'function') {
                    existing.onZoom = () => { try { callbacks.onZoom(gId); } catch(e) {} };
                }
                if (!existing.onSelect && typeof callbacks.onSelect === 'function') {
                    existing.onSelect = () => { try { callbacks.onSelect(gId); } catch(e) {} };
                }
                if (!existing.onRemove && typeof callbacks.onRemove === 'function') {
                    existing.onRemove = () => { try { callbacks.onRemove(gId); } catch(e) {} };
                }
            }
        }

        function inspectFiberNode(node) {
            if (!node) return;
            const props = node.memoizedProps;
            const state = node.memoizedState;

            if (props) {
                if (typeof props.setGroupColor === 'function') {
                    window.__topoNativeSetGroupColor = props.setGroupColor;
                }
                if (Array.isArray(props.groups)) {
                    props.groups.forEach(g => registerGroup(g, props));
                }
                if (props.group && props.group.id) {
                    registerGroup(props.group, props);
                }
                if (Array.isArray(props.items)) {
                    props.items.forEach(it => {
                        if (it?.group) registerGroup(it.group, props);
                        else if (it?.id && (it?.points || it?.coordinates)) registerGroup(it, props);
                    });
                }
                // Bắt nét vẽ dở / draft đang vẽ chưa lưu trong props
                if (Array.isArray(props.draftPoints) && props.draftPoints.length > 0) {
                    registerGroup({
                        id: 'draft-active-stroke',
                        name: 'Nét đang vẽ dở (Chưa lưu)',
                        connectMode: 'line',
                        points: props.draftPoints,
                        isDraft: true
                    }, props);
                }
            }

            let s = state;
            while (s) {
                const ms = s.memoizedState;
                if (Array.isArray(ms)) {
                    ms.forEach(entry => {
                        if (entry && entry.kind === 'group' && entry.g) {
                            registerGroup(entry.g);
                        } else if (entry && entry.kind === 'point' && entry.g && entry.p) {
                            registerGroup(entry.g);
                            if (!pointsByGroupId.has(entry.g.id)) {
                                pointsByGroupId.set(entry.g.id, []);
                            }
                            const ptList = pointsByGroupId.get(entry.g.id);
                            if (!ptList.some(p => p.id === entry.p.id)) {
                                ptList.push(entry.p);
                            }
                        } else if (entry && entry.id && (entry.points || entry.coordinates)) {
                            registerGroup(entry);
                        }
                    });
                } else if (ms && typeof ms === 'object') {
                    if (Array.isArray(ms.groups)) {
                        ms.groups.forEach(g => registerGroup(g));
                    }
                    if (ms.group && ms.group.id) {
                        registerGroup(ms.group);
                    }
                    if (Array.isArray(ms.points) && ms.points.length > 1 && !ms.id) {
                        registerGroup({
                            id: 'draft-hook-stroke',
                            name: 'Nét vẽ từ State Hook (Chưa lưu)',
                            connectMode: 'line',
                            points: ms.points,
                            isDraft: true
                        });
                    }
                }
                s = s.next;
            }
        }

        // 1. Quét từ Root Container (Duyệt toàn bộ Virtual DOM Tree)
        const rootEl = document.getElementById('root') || document.body;
        const rootKey = Object.keys(rootEl).find(k => k.startsWith('__reactContainer') || k.startsWith('__reactFiber'));
        if (rootKey && rootEl[rootKey]) {
            const stack = [rootEl[rootKey]];
            const visited = new Set();
            while (stack.length > 0) {
                const node = stack.pop();
                if (!node || visited.has(node)) continue;
                visited.add(node);
                inspectFiberNode(node);
                if (node.child) stack.push(node.child);
                if (node.sibling) stack.push(node.sibling);
            }
        }

        // 2. Quét bổ sung từ mọi DOM elements trên trang
        const allElements = Array.from(document.querySelectorAll('*'));
        for (const el of allElements) {
            const key = Object.keys(el).find(k => k.startsWith('__reactFiber'));
            if (!key || !el[key]) continue;
            let node = el[key];
            for (let d = 0; d < 50 && node; d++) {
                inspectFiberNode(node);
                node = node.return;
            }
        }

        // 3. Ghép nối danh sách điểm nếu được lấy từ Hook Memo dạng phẳng
        pointsByGroupId.forEach((pts, gId) => {
            const item = groupsMap.get(gId);
            if (item && (!item.group.points || item.group.points.length === 0)) {
                item.group.points = pts;
            }
        });

        // 4. Quét bổ sung từ Cesium Viewer Live Entities (Trường hợp chưa lưu vào React state / UI)
        const viewer = window.__topo3dViewer || find3dViewer();
        if (viewer && viewer.entities && window.Cesium) {
            try {
                let entIdx = 0;
                viewer.entities.values.forEach(entity => {
                    if (entity.id && String(entity.id).startsWith('backup-line-')) return;
                    if (entity.polyline && entity.polyline.positions) {
                        const positions = entity.polyline.positions.getValue ? 
                                          entity.polyline.positions.getValue(window.Cesium.JulianDate.now()) : 
                                          entity.polyline.positions;
                        if (Array.isArray(positions) && positions.length >= 2) {
                            entIdx++;
                            const entId = String(entity.id || `live-cesium-${entIdx}`);
                            if (!groupsMap.has(entId)) {
                                const pts = positions.map((pos, pIdx) => {
                                    if (pos && typeof pos.x === 'number') {
                                        const carto = window.Cesium.Cartographic.fromCartesian(pos);
                                        if (carto) {
                                            return {
                                                id: `pt-${entId}-${pIdx}`,
                                                lng: (carto.longitude * 180) / Math.PI,
                                                lat: (carto.latitude * 180) / Math.PI,
                                                height: carto.height || 0
                                            };
                                        }
                                    }
                                    return null;
                                }).filter(Boolean);

                                if (pts.length >= 2) {
                                    registerGroup({
                                        id: entId,
                                        name: entity.name || `Nét vẽ 3D ${entIdx} (Live Canvas)`,
                                        connectMode: 'line',
                                        points: pts,
                                        isLiveCesium: true
                                    });
                                }
                            }
                        }
                    }
                });
            } catch (e) {}
        }

        const result = Array.from(groupsMap.values());
        log(`[Bridge3D] collectAll3dGroups successfully resolved ${result.length} 3D groups.`);
        return result;
    }

    // ===== FLY CAMERA TO 3D COORD =====
    function flyTo3DCoord(lng, lat, height = 150) {
        const viewer = window.__topo3dViewer || find3dViewer();
        if (viewer && viewer.camera && typeof viewer.camera.flyTo === 'function') {
            try {
                if (window.Cesium && window.Cesium.Cartesian3) {
                    viewer.camera.flyTo({
                        destination: window.Cesium.Cartesian3.fromDegrees(lng, lat, (height || 100) + 50),
                        duration: 1.0
                    });
                    return true;
                }
            } catch (e) {}
        }

        try {
            const hash = window.location.hash;
            if (hash && (hash.includes('lng=') || hash.includes('lat='))) {
                const newHash = hash
                    .replace(/lng=[^&]+/, `lng=${lng.toFixed(6)}`)
                    .replace(/lat=[^&]+/, `lat=${lat.toFixed(6)}`);
                if (newHash !== hash) {
                    window.location.hash = newHash;
                    return true;
                }
            }
        } catch (e) {}

        return false;
    }

    // Global APIs for 3D Bridge
    window.__topoFind3dViewer = find3dViewer;
    window.__topoCollect3dGroups = collectAll3dGroups;
    window.__topoFlyTo3DCoord = flyTo3DCoord;
    window.__topoProject3dToScreen = project3dToScreen;
    window.__topoUnprojectScreenToGeo = unprojectScreenToGeo;

    log('Bridge 3D Module Loaded');
})();
