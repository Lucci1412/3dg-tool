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

    // ===== CESIUM LIB DETECTOR =====
    function getCesium() {
        return window.Cesium || null;
    }

    // ===== 3D ENGINE / VIEWER DETECTOR =====
    function find3dViewer() {
        if (window.viewer && (window.viewer.scene || window.viewer.camera)) {
            return window.viewer;
        }
        if (window.__cesiumViewer && (window.__cesiumViewer.scene || window.__cesiumViewer.camera)) {
            return window.__cesiumViewer;
        }
        if (window.cesiumViewer && (window.cesiumViewer.scene || window.cesiumViewer.camera)) {
            return window.cesiumViewer;
        }

        // 1. Quét từ tất cả canvas trên trang
        const allCanvases = Array.from(document.querySelectorAll('canvas'));
        for (const canvas3d of allCanvases) {
            if (canvas3d.id === 'topo-3d-area-draw-canvas' || canvas3d.id === 'topo-3d-line-highlight-canvas' || canvas3d.id === 'topo-line-highlight-canvas') continue;
            if (canvas3d.viewer && (canvas3d.viewer.scene || canvas3d.viewer.camera)) return canvas3d.viewer;
            if (canvas3d.parentElement?.viewer && (canvas3d.parentElement.viewer.scene || canvas3d.parentElement.viewer.camera)) return canvas3d.parentElement.viewer;
            if (canvas3d._cesium && canvas3d._cesium.viewer) return canvas3d._cesium.viewer;
            if (canvas3d.__cesiumWidget && canvas3d.__cesiumWidget.scene) return canvas3d.__cesiumWidget;
        }

        // 2. Quét từ React Fiber của toàn bộ DOM elements
        const allElements = Array.from(document.querySelectorAll('*'));
        for (const el of allElements) {
            if (el.viewer && (el.viewer.scene || el.viewer.camera)) return el.viewer;
            if (el.cesiumViewer && (el.cesiumViewer.scene || el.cesiumViewer.camera)) return el.cesiumViewer;

            const key = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactContainer'));
            if (!key || !el[key]) continue;

            let node = el[key];
            for (let d = 0; d < 100 && node; d++) {
                try {
                    const props = node.memoizedProps;
                    const state = node.memoizedState;
                    const stateNode = node.stateNode;

                    if (props?.viewer?.scene || props?.viewer?.camera) return props.viewer;
                    if (props?.cesiumViewer?.scene || props?.cesiumViewer?.camera) return props.cesiumViewer;
                    if (props?.scene?.camera) return props;
                    if (stateNode?.viewer?.scene) return stateNode.viewer;
                    if (stateNode?.scene?.camera) return stateNode;
                    if (stateNode?.cesiumWidget?.scene) return stateNode.cesiumWidget;

                    let s = state;
                    while (s) {
                        const cur = s.memoizedState?.current || s.memoizedState;
                        if (cur) {
                            if (cur.scene || cur.camera || cur.entities) return cur;
                            if (cur.viewer?.scene || cur.viewer?.camera) return cur.viewer;
                            if (cur.cesiumViewer?.scene || cur.cesiumViewer?.camera) return cur.cesiumViewer;
                            if (cur.cesiumWidget?.scene) return cur.cesiumWidget;
                        }
                        s = s.next;
                    }
                } catch (e) {}
                node = node.return;
            }
        }

        return null;
    }

    // ===== CESIUM HELPER RESOLVER =====
    function getCesium() {
        if (typeof window.Cesium !== 'undefined' && window.Cesium) return window.Cesium;
        const viewer = window.__topo3dViewer || find3dViewer();
        if (viewer) {
            if (viewer.constructor?.Cesium) return viewer.constructor.Cesium;
            if (viewer.cesiumWidget?.constructor?.Cesium) return viewer.cesiumWidget.constructor.Cesium;
        }
        return null;
    }

    // ===== UPDATE CESIUM 3D GROUP COLOR (BATCHED PRIMITIVES + LIVE ENTITIES) =====
    function updateCesium3dGroupColor(viewer, gId, colorHex) {
        if (!viewer) viewer = window.__topo3dViewer || find3dViewer();
        if (!viewer) return false;
        const scene = viewer.scene || viewer;
        const Cesium = getCesium();
        let updated = false;

        // 1. Phân giải mã màu sang mảng byte RGBA [0..255]
        let r = 255, g = 0, b = 0, a = 255;
        if (Cesium && Cesium.Color && Cesium.Color.fromCssColorString) {
            try {
                const c = Cesium.Color.fromCssColorString(colorHex);
                r = Math.round(c.red * 255);
                g = Math.round(c.green * 255);
                b = Math.round(c.blue * 255);
                a = Math.round((c.alpha !== undefined ? c.alpha : 1.0) * 255);
            } catch(e) {}
        } else if (colorHex && colorHex.startsWith('#')) {
            const hex = colorHex.replace('#', '');
            if (hex.length === 6) {
                r = parseInt(hex.slice(0, 2), 16) || 0;
                g = parseInt(hex.slice(2, 4), 16) || 0;
                b = parseInt(hex.slice(4, 6), 16) || 0;
            } else if (hex.length === 3) {
                r = parseInt(hex[0] + hex[0], 16) || 0;
                g = parseInt(hex[1] + hex[1], 16) || 0;
                b = parseInt(hex[2] + hex[2], 16) || 0;
            }
        } else if (colorHex && colorHex.startsWith('rgb')) {
            const nums = colorHex.match(/\d+/g);
            if (nums && nums.length >= 3) {
                r = parseInt(nums[0], 10);
                g = parseInt(nums[1], 10);
                b = parseInt(nums[2], 10);
                if (nums.length >= 4) a = parseInt(nums[3], 10);
            }
        }
        const rgbaBytes = [r, g, b, a];

        // 2. Cập nhật qua Cesium Batched Primitives (getGeometryInstanceAttributes)
        //    (3DG trên 3D Mesh vẽ toàn bộ các nét CAD gom chung vào Cesium Primitive)
        function scanPrimitive(p) {
            if (!p) return;
            if (p._primitives && Array.isArray(p._primitives)) {
                p._primitives.forEach(scanPrimitive);
            }
            if (typeof p.getGeometryInstanceAttributes === 'function') {
                try {
                    const attr = p.getGeometryInstanceAttributes(gId) ||
                                 p.getGeometryInstanceAttributes(`group-${gId}`) ||
                                 p.getGeometryInstanceAttributes(`polyline-${gId}`);
                    if (attr && attr.color) {
                        attr.color = rgbaBytes;
                        updated = true;
                    }
                } catch (e) {}
            }
        }

        if (scene.primitives) {
            for (let i = 0; i < scene.primitives.length; i++) {
                scanPrimitive(scene.primitives.get(i));
            }
        }
        if (scene.groundPrimitives) {
            for (let i = 0; i < scene.groundPrimitives.length; i++) {
                scanPrimitive(scene.groundPrimitives.get(i));
            }
        }

        // 3. Cập nhật qua Cesium Entities (nếu nét vẽ dạng Entity)
        if (viewer.entities) {
            try {
                const cesiumColor = Cesium?.Color ? Cesium.Color.fromCssColorString(colorHex) : colorHex;
                const setPolyMaterial = (polyline) => {
                    if (!polyline) return;
                    try {
                        if (Cesium?.ColorMaterialProperty) {
                            polyline.material = new Cesium.ColorMaterialProperty(cesiumColor);
                        } else {
                            polyline.material = cesiumColor;
                        }
                        updated = true;
                    } catch (mErr) {
                        polyline.material = cesiumColor;
                        updated = true;
                    }
                };

                const ent = viewer.entities.getById(gId) || 
                            viewer.entities.getById(`group-${gId}`) || 
                            viewer.entities.getById(`polyline-${gId}`) ||
                            viewer.entities.getById(`backup-line-${gId}`);
                if (ent && ent.polyline) {
                    setPolyMaterial(ent.polyline);
                } else {
                    viewer.entities.values.forEach(e => {
                        if (e.polyline && (e.id === gId || String(e.id).includes(gId))) {
                            setPolyMaterial(e.polyline);
                        }
                    });
                }
            } catch (entErr) {}
        }

        // 4. Buộc Cesium re-render ngay lập tức để người dùng thấy màu mới
        if (updated && typeof scene.requestRender === 'function') {
            scene.requestRender();
        }

        return updated;
    }

    // ===== PROJECT 3D GEO COORD (LNG, LAT, HEIGHT) TO 2D SCREEN PIXELS =====
    function project3dToScreen(lng, lat, height = 0) {
        const viewer = window.__topo3dViewer || find3dViewer();
        if (!viewer) return null;

        const scene = viewer.scene || viewer;
        if (!scene) return null;

        const Cesium = window.Cesium || getCesium();

        if (Cesium?.Cartesian3?.fromDegrees && Cesium?.SceneTransforms) {
            try {
                const cart = Cesium.Cartesian3.fromDegrees(lng, lat, height || 0);
                const transformFn = Cesium.SceneTransforms.worldToWindowCoordinates ||
                    Cesium.SceneTransforms.wgs84ToWindowCoordinates;
                if (typeof transformFn === 'function') {
                    const pos = transformFn.call(Cesium.SceneTransforms, scene, cart);
                    if (pos && typeof pos.x === 'number') {
                        return [pos.x, pos.y];
                    }
                }
            } catch (e) {}
        }

        try {
            const ellipsoid = scene.globe?.ellipsoid || scene.mapProjection?.ellipsoid;
            if (ellipsoid?.cartographicToCartesian) {
                const radLng = (lng * Math.PI) / 180;
                const radLat = (lat * Math.PI) / 180;
                const cartesian = ellipsoid.cartographicToCartesian({
                    longitude: radLng,
                    latitude: radLat,
                    height: height || 0
                });
                if (cartesian) {
                    const transformFn = Cesium?.SceneTransforms?.worldToWindowCoordinates ||
                        Cesium?.SceneTransforms?.wgs84ToWindowCoordinates;
                    if (typeof transformFn === 'function') {
                        const pos = transformFn.call(Cesium.SceneTransforms, scene, cartesian);
                        if (pos && typeof pos.x === 'number') return [pos.x, pos.y];
                    }
                    if (scene.camera?.worldToWindowCoordinates) {
                        const pos = scene.camera.worldToWindowCoordinates(cartesian);
                        if (pos && typeof pos.x === 'number') return [pos.x, pos.y];
                    }
                }
            }
        } catch (e) {}

        return null;
    }

    // ===== UNPROJECT 2D SCREEN PIXELS (X, Y) TO GEO COORDS (LNG, LAT, HEIGHT) =====
    function unprojectScreenToGeo(screenX, screenY) {
        const viewer = window.__topo3dViewer || find3dViewer();
        if (!viewer) return null;

        const scene = viewer.scene || viewer;
        const camera = viewer.camera || scene?.camera;
        const ellipsoid = scene?.globe?.ellipsoid || scene?.mapProjection?.ellipsoid;
        const Cesium = getCesium();

        if (scene) {
            try {
                const windowCoord = (Cesium && Cesium.Cartesian2) ? 
                                    new Cesium.Cartesian2(screenX, screenY) : 
                                    { x: screenX, y: screenY };

                // 1. Ưu tiên pickPosition trực tiếp trên 3D Mesh / 3D Tiles (độ cao chính xác nhất)
                if (typeof scene.pickPosition === 'function') {
                    try {
                        const cartesian = scene.pickPosition(windowCoord);
                        if (cartesian) {
                            if (Cesium?.Cartographic) {
                                const carto = Cesium.Cartographic.fromCartesian(cartesian);
                                if (carto && typeof carto.latitude === 'number') {
                                    return [
                                        (carto.longitude * 180) / Math.PI,
                                        (carto.latitude * 180) / Math.PI,
                                        carto.height || 0
                                    ];
                                }
                            } else if (ellipsoid?.cartesianToCartographic) {
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
                    } catch (pErr) {}
                }

                // 2. Fallback: Ray pick trên Globe Surface
                if (camera && typeof camera.getPickRay === 'function' && scene.globe && typeof scene.globe.pick === 'function') {
                    try {
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
                    } catch (rErr) {}
                }

                // 3. Fallback: Pick Ellipsoid
                if (camera && typeof camera.pickEllipsoid === 'function' && ellipsoid) {
                    try {
                        const cartesian = camera.pickEllipsoid(windowCoord, ellipsoid);
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
                    } catch (eErr) {}
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

                        // 4. Cập nhật trực tiếp màu hiển thị trên Cesium 3D Scene (Batched Primitives + Entities)
                        try {
                            const viewer = window.__topo3dViewer || find3dViewer();
                            updateCesium3dGroupColor(viewer, gId, color);
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
                if (typeof props.onSetColor === 'function') {
                    window.__topoNativeOnSetColor = props.onSetColor;
                }
                if (typeof props.changeGroupColor === 'function') {
                    window.__topoNativeChangeGroupColor = props.changeGroupColor;
                }

                // 1. Quét các mảng dữ liệu nét vẽ
                const groupArrays = [
                    props.groups,
                    props.items,
                    props.list,
                    props.strokes,
                    props.polylines,
                    props.lines,
                    props.data,
                    props.vectors,
                    props.features,
                    props.drawings,
                    props.cadData,
                    props.layers
                ];
                groupArrays.forEach(arr => {
                    if (Array.isArray(arr)) {
                        arr.forEach(g => {
                            if (!g) return;
                            if (g.group) registerGroup(g.group, props);
                            else if (g.id || g.points || g.coordinates) registerGroup(g, props);
                        });
                    }
                });

                if (props.group && props.group.id) {
                    registerGroup(props.group, props);
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
                        if (!entry) return;
                        if (entry.kind === 'group' && entry.g) {
                            registerGroup(entry.g);
                        } else if (entry.kind === 'point' && entry.g && entry.p) {
                            registerGroup(entry.g);
                            if (!pointsByGroupId.has(entry.g.id)) {
                                pointsByGroupId.set(entry.g.id, []);
                            }
                            const ptList = pointsByGroupId.get(entry.g.id);
                            if (!ptList.some(p => p.id === entry.p.id)) {
                                ptList.push(entry.p);
                            }
                        } else if (entry.id && (entry.points || entry.coordinates)) {
                            registerGroup(entry);
                        }
                    });
                } else if (ms && typeof ms === 'object') {
                    if (Array.isArray(ms.groups)) {
                        ms.groups.forEach(g => registerGroup(g));
                    }
                    if (Array.isArray(ms.items)) {
                        ms.items.forEach(it => {
                            if (it?.group) registerGroup(it.group);
                            else if (it?.id && (it?.points || it?.coordinates)) registerGroup(it);
                        });
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
        const rootEl = document.getElementById('root') || document.getElementById('app') || document.body;
        const rootKey = Object.keys(rootEl).find(k => k.startsWith('__reactContainer') || k.startsWith('__reactFiber'));
        if (rootKey && rootEl[rootKey]) {
            const rootNode = rootEl[rootKey];
            const startFiber = rootNode.current || rootNode;
            const stack = [startFiber];
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

        // 2. Quét bổ sung từ mọi DOM elements trên trang (quét cả nhánh child/sibling)
        const allElements = Array.from(document.querySelectorAll('*'));
        for (const el of allElements) {
            const key = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
            if (!key || !el[key]) continue;
            let node = el[key];
            for (let d = 0; d < 50 && node; d++) {
                inspectFiberNode(node);
                if (node.child) inspectFiberNode(node.child);
                if (node.sibling) inspectFiberNode(node.sibling);
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
        const Cesium = getCesium();
        if (viewer && viewer.entities && Cesium) {
            try {
                let entIdx = 0;
                viewer.entities.values.forEach(entity => {
                    if (entity.id && String(entity.id).startsWith('backup-line-')) return;
                    if (entity.polyline && entity.polyline.positions) {
                        const julianNow = Cesium.JulianDate ? Cesium.JulianDate.now() : null;
                        const positions = entity.polyline.positions.getValue ? 
                                          entity.polyline.positions.getValue(julianNow) : 
                                          entity.polyline.positions;
                        if (Array.isArray(positions) && positions.length >= 2) {
                            entIdx++;
                            const entId = String(entity.id || `live-cesium-${entIdx}`);
                            if (!groupsMap.has(entId)) {
                                const pts = positions.map((pos, pIdx) => {
                                    if (pos && typeof pos.x === 'number') {
                                        const carto = Cesium.Cartographic ? Cesium.Cartographic.fromCartesian(pos) : null;
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
    function flyTo3DCoord(lng, lat, height = 120) {
        const viewer = window.__topo3dViewer || find3dViewer();
        const Cesium = window.Cesium || getCesium();
        if (viewer && viewer.camera && typeof viewer.camera.flyTo === 'function') {
            try {
                if (Cesium && Cesium.Cartesian3) {
                    const targetHeight = (typeof height === 'number' && height > 0) ? (height + 40) : 150;
                    viewer.camera.flyTo({
                        destination: Cesium.Cartesian3.fromDegrees(lng, lat, targetHeight),
                        duration: 0.8
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

    // ===== 3D CANVAS OVERLAY FOR TOPOLOGY ERROR MARKERS (ĐỐM ĐỎ ĐẦU MÚT HỞ) =====
    let stored3dErrors = [];
    let active3dErrorId = null;
    let is3dPostRenderAttached = false;
    let postRenderListener = null;

    function getOrCreate3DHighlightCanvas() {
        // Tìm viewport hoặc canvas container của Cesium
        const container = document.querySelector('.cesium-widget') ||
            document.querySelector('.cesium-viewer') ||
            document.querySelector('canvas')?.parentElement ||
            document.body;
        if (!container) return null;

        let canvas = document.getElementById('topo-3d-line-highlight-canvas');
        if (canvas && container.contains(canvas)) {
            if (canvas.width !== container.clientWidth || canvas.height !== container.clientHeight) {
                canvas.width = container.clientWidth || window.innerWidth;
                canvas.height = container.clientHeight || window.innerHeight;
            }
            return canvas;
        }

        canvas = document.createElement('canvas');
        canvas.id = 'topo-3d-line-highlight-canvas';
        canvas.style.cssText = 'position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:9996; overflow:visible;';
        canvas.width = container.clientWidth || window.innerWidth;
        canvas.height = container.clientHeight || window.innerHeight;
        container.appendChild(canvas);
        return canvas;
    }

    function draw3DHighlightsCanvas() {
        const canvas = getOrCreate3DHighlightCanvas();
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (!stored3dErrors || stored3dErrors.length === 0) return;

        // Vẽ từng điểm lỗi lên canvas dựa theo toạ độ 3D đã chiếu về màn hình
        stored3dErrors.forEach(err => {
            if (!err.coord || !Array.isArray(err.coord)) return;
            const [lng, lat, height] = err.coord;

            let sp = project3dToScreen(lng, lat, height || 0);
            if (!sp) sp = project3dToScreen(lng, lat, 0);
            if (!sp) return;

            const [px, py] = sp;
            // Bỏ qua nếu nằm ngoài màn hình hiển thị
            if (px < -40 || px > canvas.width + 40 || py < -40 || py > canvas.height + 40) return;

            const isActive = (err.id === active3dErrorId);

            ctx.save();

            if (err.type === 'duplicate') {
                // ĐỐM CAM/VÀNG CHO LỖI TRÙNG NÉT
                ctx.beginPath();
                ctx.arc(px, py, isActive ? 14 : 9, 0, Math.PI * 2);
                ctx.fillStyle = isActive ? 'rgba(234, 88, 12, 0.6)' : 'rgba(245, 158, 11, 0.38)';
                ctx.fill();

                ctx.beginPath();
                ctx.arc(px, py, isActive ? 7 : 5, 0, Math.PI * 2);
                ctx.fillStyle = isActive ? '#ffffff' : '#fbbf24';
                ctx.fill();
                ctx.strokeStyle = '#ea580c';
                ctx.lineWidth = isActive ? 2.5 : 1.5;
                ctx.stroke();
            } else {
                // ĐỐM ĐỎ CHO ĐẦU MÚT HỞ / CHƯA KHÉP THỬA (GIỐNG 100% 2D)
                // 1. Vòng hào quang đỏ mờ (Outer glow halo)
                ctx.beginPath();
                ctx.arc(px, py, isActive ? 16 : 10, 0, Math.PI * 2);
                ctx.fillStyle = isActive ? 'rgba(255, 0, 68, 0.45)' : 'rgba(255, 17, 0, 0.32)';
                ctx.fill();

                // 2. Điểm tròn đỏ tươi trung tâm
                ctx.beginPath();
                ctx.arc(px, py, isActive ? 8 : 5.5, 0, Math.PI * 2);
                ctx.fillStyle = '#ff1100';
                ctx.fill();

                // 3. Viền trắng nổi bật trên nền 3D
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = isActive ? 2.5 : 1.8;
                ctx.stroke();

                // 4. Nếu đang được chọn (Active): vẽ thêm tâm trắng
                if (isActive) {
                    ctx.beginPath();
                    ctx.arc(px, py, 3, 0, Math.PI * 2);
                    ctx.fillStyle = '#ffffff';
                    ctx.fill();
                }
            }

            ctx.restore();
        });
    }

    function attach3dRenderListener() {
        const viewer = window.__topo3dViewer || find3dViewer();
        const scene = viewer?.scene || viewer;
        if (!scene || is3dPostRenderAttached) return;

        if (scene.postRender && typeof scene.postRender.addEventListener === 'function') {
            postRenderListener = () => {
                draw3DHighlightsCanvas();
            };
            scene.postRender.addEventListener(postRenderListener);
            is3dPostRenderAttached = true;
        }

        window.addEventListener('resize', draw3DHighlightsCanvas);
    }

    function detach3dRenderListener() {
        const viewer = window.__topo3dViewer || find3dViewer();
        const scene = viewer?.scene || viewer;
        if (scene && scene.postRender && postRenderListener) {
            try {
                scene.postRender.removeEventListener(postRenderListener);
            } catch(e) {}
        }
        is3dPostRenderAttached = false;
        postRenderListener = null;
        window.removeEventListener('resize', draw3DHighlightsCanvas);
    }

    function render3dErrorOverlays(errors) {
        clear3dErrorOverlays();
        if (!errors || errors.length === 0) return;

        stored3dErrors = [...errors];
        attach3dRenderListener();
        draw3DHighlightsCanvas();

        const viewer = window.__topo3dViewer || find3dViewer();
        const scene = viewer?.scene || viewer;
        if (scene && typeof scene.requestRender === 'function') {
            scene.requestRender();
        }
    }

    function clear3dErrorOverlays() {
        stored3dErrors = [];
        active3dErrorId = null;
        const canvas = document.getElementById('topo-3d-line-highlight-canvas');
        if (canvas) {
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        detach3dRenderListener();
    }

    function toggle3dErrorHighlight(errorId, forceState) {
        if (!errorId) return;
        if (forceState === true) {
            active3dErrorId = errorId;
        } else if (forceState === false) {
            if (active3dErrorId === errorId) active3dErrorId = null;
        } else {
            active3dErrorId = (active3dErrorId === errorId) ? null : errorId;
        }
        draw3DHighlightsCanvas();

        const viewer = window.__topo3dViewer || find3dViewer();
        const scene = viewer?.scene || viewer;
        if (scene && typeof scene.requestRender === 'function') {
            scene.requestRender();
        }
    }

    // Global APIs for 3D Bridge
    window.__topoFind3dViewer = find3dViewer;
    window.__topoCollect3dGroups = collectAll3dGroups;
    window.__topoFlyTo3DCoord = flyTo3DCoord;
    window.__topoProject3dToScreen = project3dToScreen;
    window.__topoUnprojectScreenToGeo = unprojectScreenToGeo;
    window.__topoUpdateCesium3dGroupColor = updateCesium3dGroupColor;
    window.__topoRender3DOverlays = render3dErrorOverlays;
    window.__topoClear3DOverlays = clear3dErrorOverlays;
    window.__topoToggle3DHighlight = toggle3dErrorHighlight;

    log('Bridge 3D Module Loaded');
})();
