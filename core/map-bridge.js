// ============================================================
// 3DG Map Tools — Core Map Bridge & Marker Overlay Engine
// - Finds OpenLayers map instance via React Fiber traversal
// - Provides DOM Pixel-synced Red Lightbulb Markers
// - Provides Smooth Zoom & Center navigation APIs
// ============================================================

(function () {
    'use strict';

    function log() {}

    // ===== FIND OPENLAYERS MAP VIA REACT FIBER =====
    function findOlMap() {
        const viewport = document.querySelector('.ol-viewport');
        if (!viewport) return null;
        let el = viewport.parentElement;
        while (el && el !== document.body) {
            const key = Object.keys(el).find(k => k.startsWith('__reactFiber'));
            if (key) {
                let node = el[key];
                for (let d = 0; d < 200 && node; d++) {
                    try {
                        let s = node.memoizedState;
                        while (s) {
                            if (s.queue === null && s.memoizedState?.current) {
                                const cur = s.memoizedState.current;
                                if (typeof cur?.getInteractions === 'function' && typeof cur?.getLayers === 'function') return cur;
                            }
                            s = s.next;
                        }
                    } catch (e) { }
                    node = node.return;
                }
                break;
            }
            el = el.parentElement;
        }
        return null;
    }

    // Global reference for map
    window.__topoFindOlMap = findOlMap;
    window.__topoMap = null;

    // ===== DOM PIXEL-BASED MARKER & LINE HIGHLIGHT LAYER MANAGER =====
    let markerLayerDiv = null;
    let storedErrorItems = []; // { coord, element, activeElement, type }
    let storedDuplicateSegments = []; // [ { p1, p2, id } ]
    let activeDuplicateSegment = null; // { p1, p2, id }
    let activeErrorCoord = null;
    let isListenerAttached = false;

    function getOrCreateMarkerLayerDiv() {
        const viewport = document.querySelector('.ol-viewport');
        if (!viewport) return null;

        if (markerLayerDiv && viewport.contains(markerLayerDiv)) return markerLayerDiv;

        const div = document.createElement('div');
        div.id = 'topo-dom-marker-layer';
        div.style.cssText = 'position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:9999; overflow:visible;';
        viewport.appendChild(div);
        markerLayerDiv = div;
        return markerLayerDiv;
    }

    function getOrCreateHighlightCanvas() {
        const viewport = document.querySelector('.ol-viewport');
        if (!viewport) return null;

        let canvas = document.getElementById('topo-line-highlight-canvas');
        if (canvas && viewport.contains(canvas)) {
            if (canvas.width !== viewport.clientWidth || canvas.height !== viewport.clientHeight) {
                canvas.width = viewport.clientWidth;
                canvas.height = viewport.clientHeight;
            }
            return canvas;
        }

        canvas = document.createElement('canvas');
        canvas.id = 'topo-line-highlight-canvas';
        canvas.style.cssText = 'position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:9997; overflow:visible;';
        canvas.width = viewport.clientWidth;
        canvas.height = viewport.clientHeight;
        viewport.appendChild(canvas);
        return canvas;
    }
    // Set of disabled error highlight IDs (tắt sáng từng dây khi click)
    const disabledHighlightIds = new Set();

    function toggleErrorHighlight(errorId, forceState) {
        if (!errorId) return false;

        let isDisabled = false;
        if (typeof forceState === 'boolean') {
            if (!forceState) disabledHighlightIds.add(errorId);
            else disabledHighlightIds.delete(errorId);
            isDisabled = !forceState;
        } else {
            if (disabledHighlightIds.has(errorId)) {
                disabledHighlightIds.delete(errorId);
                isDisabled = false;
            } else {
                disabledHighlightIds.add(errorId);
                isDisabled = true;
            }
        }

        if (isDisabled && activeDuplicateSegment && activeDuplicateSegment.id === errorId) {
            activeDuplicateSegment = null;
        }

        updateMarkerPositions();
        return isDisabled;
    }

    let storedDanglePoints = [];

    function drawAllHighlightsCanvas() {
        const map = window.__topoMap || findOlMap();
        const canvas = getOrCreateHighlightCanvas();
        if (!canvas || !map) return;

        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const view = map.getView();
        const extent = view ? view.calculateExtent() : null;

        function isInExtent(pt) {
            if (!extent || !pt) return true;
            return pt[0] >= extent[0] && pt[0] <= extent[2] && pt[1] >= extent[1] && pt[1] <= extent[3];
        }

        function drawEndpointGlowingDot(pt, colorRing, colorDot, isLarge = false) {
            if (!pt) return;
            const px = map.getPixelFromCoordinate(pt);
            if (!px || isNaN(px[0]) || isNaN(px[1])) return;

            ctx.save();
            ctx.beginPath();
            ctx.arc(px[0], px[1], isLarge ? 12 : 8, 0, Math.PI * 2);
            ctx.fillStyle = colorRing;
            ctx.fill();

            ctx.beginPath();
            ctx.arc(px[0], px[1], isLarge ? 6 : 4, 0, Math.PI * 2);
            ctx.fillStyle = colorDot;
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.restore();
        }

        // 1. Vẽ các điểm hở ranh (Dangle) trực tiếp lên Canvas (siêu nhẹ, 60fps)
        if (storedDanglePoints && storedDanglePoints.length > 0) {
            ctx.save();
            for (const pt of storedDanglePoints) {
                if (!isInExtent(pt)) continue;
                const px = map.getPixelFromCoordinate(pt);
                if (!px || isNaN(px[0]) || isNaN(px[1])) continue;

                ctx.beginPath();
                ctx.arc(px[0], px[1], 4.5, 0, Math.PI * 2);
                ctx.fillStyle = '#ff1100';
                ctx.fill();
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1.5;
                ctx.stroke();
            }
            ctx.restore();
        }

        // 2. Vẽ các điểm trùng nét (1 đầu mút) lên Canvas
        if (storedDuplicateSegments && storedDuplicateSegments.length > 0) {
            const sortedSegs = [...storedDuplicateSegments].sort((a, b) => (b.length || 0) - (a.length || 0));

            sortedSegs.forEach(seg => {
                if (disabledHighlightIds.has(seg.id)) return;
                const pts = seg.pathCoords || (seg.p1 && seg.p2 ? [seg.p1, seg.p2] : null);
                if (pts && pts.length >= 1) {
                    if (!isInExtent(pts[0])) return;
                    const isShort = (seg.length || 0) < 30;
                    drawEndpointGlowingDot(pts[0], isShort ? 'rgba(234, 88, 12, 0.45)' : 'rgba(245, 158, 11, 0.35)', isShort ? '#ffed4a' : '#fbbf24', isShort);
                }
            });
        }

        // 3. Làm sáng đoạn trùng đang được chọn trong danh sách lỗi
        if (activeDuplicateSegment && !disabledHighlightIds.has(activeDuplicateSegment.id)) {
            const pts = activeDuplicateSegment.pathCoords || (activeDuplicateSegment.p1 && activeDuplicateSegment.p2 ? [activeDuplicateSegment.p1, activeDuplicateSegment.p2] : null);
            if (pts && pts.length >= 1) {
                drawEndpointGlowingDot(pts[0], 'rgba(239, 68, 68, 0.55)', '#ffffff', true);
            }
        }

        // 4. Vẽ điểm Active khi click chọn lỗi
        if (activeErrorCoord && isInExtent(activeErrorCoord)) {
            const px = map.getPixelFromCoordinate(activeErrorCoord);
            if (px && !isNaN(px[0]) && !isNaN(px[1])) {
                ctx.save();
                ctx.beginPath();
                ctx.arc(px[0], px[1], 10, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(255, 0, 68, 0.3)';
                ctx.fill();

                ctx.beginPath();
                ctx.arc(px[0], px[1], 6, 0, Math.PI * 2);
                ctx.fillStyle = '#ff0044';
                ctx.fill();
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 2;
                ctx.stroke();
                ctx.restore();
            }
        }
    }

    let updateMarkerAnimFrame = null;

    function scheduleUpdateMarkerPositions() {
        if (updateMarkerAnimFrame) return;
        updateMarkerAnimFrame = requestAnimationFrame(() => {
            updateMarkerAnimFrame = null;
            updateMarkerPositions();
        });
    }

    function updateMarkerPositions() {
        const map = window.__topoMap || findOlMap();
        if (!map) return;

        if (!storedDanglePoints.length && !storedDuplicateSegments.length && !activeDuplicateSegment && !activeErrorCoord) {
            const canvas = document.getElementById('topo-line-highlight-canvas');
            if (canvas) {
                const ctx = canvas.getContext('2d');
                ctx.clearRect(0, 0, canvas.width, canvas.height);
            }
            return;
        }

        drawAllHighlightsCanvas();
    }

    function attachMapRenderListeners(map) {
        if (isListenerAttached || !map) return;
        isListenerAttached = true;
        try {
            map.on('postrender', scheduleUpdateMarkerPositions);
        } catch(e) {}

        try {
            const view = map.getView();
            if (view && view.on) {
                view.on('change:center', scheduleUpdateMarkerPositions);
                view.on('change:resolution', scheduleUpdateMarkerPositions);
            }
        } catch(e) {}

        window.addEventListener('resize', scheduleUpdateMarkerPositions);
    }

    function detachMapRenderListeners(map) {
        const targetMap = map || window.__topoMap || findOlMap();
        if (!targetMap || !isListenerAttached) return;
        isListenerAttached = false;

        try {
            targetMap.un('postrender', scheduleUpdateMarkerPositions);
        } catch(e) {}

        try {
            const view = targetMap.getView();
            if (view && view.un) {
                view.un('change:center', scheduleUpdateMarkerPositions);
                view.un('change:resolution', scheduleUpdateMarkerPositions);
            }
        } catch(e) {}

        window.removeEventListener('resize', scheduleUpdateMarkerPositions);
    }

    // Clear tất cả các marker & line highlight
    function clearAllErrorOverlays() {
        const container = getOrCreateMarkerLayerDiv();
        if (container) {
            container.innerHTML = '';
        }
        const canvas = document.getElementById('topo-line-highlight-canvas');
        if (canvas) {
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        storedDanglePoints = [];
        storedErrorItems = [];
        storedDuplicateSegments = [];
        activeDuplicateSegment = null;
        activeErrorCoord = null;
        detachMapRenderListeners();
    }

    // Hiển thị highlight cho TẤT CẢ các lỗi trên bản đồ (100% Canvas GPU, 60fps)
    function renderAllErrorOverlays(errors) {
        const map = window.__topoMap || findOlMap();
        if (!map) return;

        clearAllErrorOverlays();

        if (!errors || errors.length === 0) return;

        attachMapRenderListeners(map);

        // Thu thập các điểm đầu sáng và tọa độ của đoạn trùng nét
        const dupLitPoints = [];
        errors.forEach(err => {
            if (err.type === 'duplicate') {
                const pts = err.pathCoords || (err.segment ? err.segment : null);
                if (pts && pts.length > 0) {
                    dupLitPoints.push(pts[0]);
                }
                if (err.coord) {
                    dupLitPoints.push(err.coord);
                }
            }
        });

        function isNearDupLitPoint(coord, tol = 1.0) {
            if (!coord || !dupLitPoints.length) return false;
            const tolSq = tol * tol;
            for (const dp of dupLitPoints) {
                const dx = coord[0] - dp[0];
                const dy = coord[1] - dp[1];
                if (dx * dx + dy * dy <= tolSq) return true;
            }
            return false;
        }

        errors.forEach((err) => {
            if (err.type === 'duplicate') {
                storedDuplicateSegments.push({
                    p1: err.segment ? err.segment[0] : err.coord,
                    p2: err.segment ? err.segment[1] : err.coord,
                    pathCoords: err.pathCoords || err.segment,
                    id: err.id,
                    length: err.length || 0
                });
            } else if (err.type === 'dangle') {
                // Nếu điểm hở ranh trùng với đầu sáng của trùng nét -> ưu tiên chỉ sáng trùng nét
                if (!isNearDupLitPoint(err.coord, 1.0)) {
                    storedDanglePoints.push(err.coord);
                }
            }
        });

        updateMarkerPositions();
        log(`Rendered ${storedDanglePoints.length} dangles & ${storedDuplicateSegments.length} duplicates on Canvas.`);
    }

    // Highlight lỗi được chọn (Zoom tới & hiển thị vòng hào quang trên canvas)
    function highlightErrorLocation(coord, errorObj = null) {
        const map = window.__topoMap || findOlMap();
        if (!map) return;

        activeErrorCoord = coord;

        if (errorObj && errorObj.type === 'duplicate') {
            activeDuplicateSegment = {
                p1: errorObj.segment ? errorObj.segment[0] : errorObj.coord,
                p2: errorObj.segment ? errorObj.segment[1] : errorObj.coord,
                pathCoords: errorObj.pathCoords || errorObj.segment,
                id: errorObj.id
            };
        } else {
            activeDuplicateSegment = null;
        }

        attachMapRenderListeners(map);
        updateMarkerPositions();
    }

    // ===== NAVIGATE & ZOOM TO ERROR LOCATION =====
    function zoomToErrorLocation(coord, targetZoom = 23, errorObj = null) {
        const map = window.__topoMap || findOlMap();
        if (!map) {
            console.warn('[TopologyChecker] Không tìm thấy bản đồ OpenLayers!');
            return false;
        }

        window.__topoMap = map;
        const view = map.getView();
        if (!view) return false;

        highlightErrorLocation(coord, errorObj);

        let maxAllowedZoom = 24;
        if (typeof view.getMaxZoom === 'function') {
            const mz = view.getMaxZoom();
            if (mz && !isNaN(mz) && isFinite(mz)) maxAllowedZoom = mz;
        }

        const finalZoom = Math.min(maxAllowedZoom, Math.max(targetZoom, 23));

        try {
            view.animate({
                center: coord,
                zoom: finalZoom,
                duration: 400
            });
        } catch (e) {
            view.setCenter(coord);
            view.setZoom(finalZoom);
        }

        setTimeout(updateMarkerPositions, 100);
        setTimeout(updateMarkerPositions, 450);

        return true;
    }

    function transformToLonLat(pt) {
        if (!pt || !Array.isArray(pt) || pt.length < 2) return pt;
        if (Math.abs(pt[0]) <= 180 && Math.abs(pt[1]) <= 90) return [pt[0], pt[1]];

        const ol = window.ol || window.openlayers;
        if (ol && ol.proj && typeof ol.proj.transform === 'function') {
            try {
                return ol.proj.transform(pt, 'EPSG:3857', 'EPSG:4326');
            } catch (e) {}
        }

        try {
            const x = pt[0];
            const y = pt[1];
            const lon = (x / 6378137) * (180 / Math.PI);
            const lat = (Math.atan(Math.exp(y / 6378137)) - Math.PI / 4) * 2 * (180 / Math.PI);
            return [lon, lat];
        } catch (e) {
            return pt;
        }
    }

    // ===== SYNC NEW FEATURES TO 3DG.VN REACT STATE & REDUX STORE =====
    function get3dgGroupsQueues() {
        const queues = [];
        const root = document.getElementById('root') || document.body;
        const candidates = [root, ...Array.from(document.querySelectorAll('div, section, aside, main, nav, ul, li'))];
        const seenQueues = new Set();

        for (const el of candidates) {
            const key = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactContainer'));
            if (!key) continue;

            let fiber = el[key];
            for (let depth = 0; depth < 120 && fiber; depth++) {
                if (fiber.memoizedProps?.onFinishDrawing || fiber.memoizedProps?.mapInstance || fiber.elementType?.name === 'Dc' || fiber.elementType?.name === 'tu') {
                    let s = fiber.memoizedState;
                    while (s) {
                        if (s.queue && typeof s.queue.dispatch === 'function' && Array.isArray(s.memoizedState) && !seenQueues.has(s.queue)) {
                            seenQueues.add(s.queue);
                            queues.push(s.queue);
                        }
                        s = s.next;
                    }
                }
                fiber = fiber.return;
            }
        }
        return queues;
    }

    function syncFeatureTo3dgReactState(olFeature, geojsonFeature) {
        const map = window.__topoMap || findOlMap();

        let featureId = (olFeature && typeof olFeature.getId === 'function' && olFeature.getId())
            || olFeature?._editId
            || olFeature?.id_
            || olFeature?._id
            || olFeature?.id
            || (olFeature && typeof olFeature.get === 'function' && (olFeature.get('_editId') || olFeature.get('id')))
            || (geojsonFeature && geojsonFeature.id);

        if (!featureId || featureId.length < 5) {
            featureId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'feat-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
        }

        const geom = olFeature?.getGeometry?.();
        const coords = geom?.getCoordinates?.() || geojsonFeature?.geometry?.coordinates || [];
        const pointCount = coords.length || 0;

        // Transform EPSG:3857 coordinates to WGS84 EPSG:4326 [lon, lat] for GeoJSON file export/import standard
        const lonLatCoords = Array.isArray(coords[0]) ? coords.map(pt => transformToLonLat(pt)) : transformToLonLat(coords);

        const existingProps = (olFeature && typeof olFeature.getProperties === 'function')
            ? olFeature.getProperties()
            : (geojsonFeature?.properties || {});

        const rawType = olFeature?._landType
            || (olFeature && typeof olFeature.get === 'function' && olFeature.get('landType'))
            || existingProps.landType
            || existingProps.Layer
            || (existingProps.name?.includes('Sông') ? 'DTL' : 'DGT');

        const isRiver = String(rawType).toUpperCase() === 'DTL' || String(olFeature?._name || existingProps.name || '').includes('Sông');
        const landType = isRiver ? 'DTL' : 'DGT';
        const defaultColor = isRiver ? (localStorage.getItem('topo_color_dtl') || '#aaffff') : (localStorage.getItem('topo_color_dgt') || '#ffaa32');
        const strokeColor = olFeature?._color || existingProps.strokeColor || existingProps.color || existingProps.stroke || defaultColor;
        const typeName = isRiver ? 'Sông' : 'Đường';
        const featureName = olFeature?._name
            || ((existingProps.name && !existingProps.name.includes('Đất công trình')) ? existingProps.name : `${typeName} ${featureId.slice(0, 6)}`);

        // Clean properties dictionary: exclude internal keys so 3DG property table stays clean like native lines
        const cleanProperties = Object.assign({}, existingProps);
        const internalKeys = ['geometry', 'id', 'name', 'landType', 'color', 'strokeColor', 'stroke', '_editId', 'Layer', 'loaiDat', 'ownerCount', 'pointCount', 'mode'];
        internalKeys.forEach(k => delete cleanProperties[k]);

        // Ensure unique outer ID is saved on olFeature so 3DG retains identity without polluting attribute table
        if (olFeature) {
            if (typeof olFeature.setId === 'function') olFeature.setId(featureId);
            olFeature.id_ = featureId;
            olFeature._id = featureId;
            olFeature.id = featureId;
            olFeature._editId = featureId;
            olFeature._landType = landType;
            olFeature._color = strokeColor;
            olFeature._name = featureName;

            if (typeof olFeature.set === 'function') {
                olFeature.set('_editId', featureId);
                olFeature.set('color', strokeColor);
            }
        }

        if (geojsonFeature) {
            geojsonFeature.id = featureId;
            geojsonFeature.properties = cleanProperties;
        }

        const geojsonFeatureObject = {
            type: 'Feature',
            id: featureId,
            geometry: {
                type: 'LineString',
                coordinates: lonLatCoords
            },
            properties: cleanProperties
        };

        const groupObject = {
            id: featureId,
            name: featureName,
            mode: 'line',
            color: strokeColor,
            pointCount: pointCount,
            landType: landType,
            properties: cleanProperties,
            createdBy: '',
            createdAt: new Date().toISOString(),
            feature: olFeature || geojsonFeatureObject,
            geojsonFeatureObject: geojsonFeatureObject
        };

        const itemContainer = {
            group: groupObject,
            isActive: false,
            hidden: false,
            ownerCount: 0,
            feature: olFeature || geojsonFeatureObject
        };

        // 1. Redux Store Dispatch (Global window.store or Redux DevTools)
        function dispatchReduxStore(storeObj) {
            if (!storeObj || typeof storeObj.dispatch !== 'function') return false;
            let ok = false;
            try {
                const actionTypes = [
                    'groups/addGroup', 'groups/add', 'groups/setGroups',
                    'features/addFeature', 'features/add',
                    'map/addGroup', 'map/addFeature',
                    'ADD_GROUP', 'ADD_FEATURE'
                ];
                actionTypes.forEach(type => {
                    try {
                        storeObj.dispatch({ type: type, payload: groupObject });
                        ok = true;
                    } catch(e) {}
                });
            } catch(e) {}
            return ok;
        }

        if (window.store && typeof window.store.dispatch === 'function') {
            dispatchReduxStore(window.store);
        }

        // 2. Traversal of React Fiber tree to update 3dg.vn React state & Redux Store directly
        const groupsQueues = get3dgGroupsQueues();
        groupsQueues.forEach(q => {
            try {
                q.dispatch(prev => {
                    if (!Array.isArray(prev)) return [groupObject];
                    const idx = prev.findIndex(item => (item?.id === featureId || item?.group?.id === featureId || item?._id === featureId));
                    if (idx !== -1) {
                        const updated = [...prev];
                        const existing = updated[idx];
                        if (existing?.group) {
                            updated[idx] = {
                                ...existing,
                                group: {
                                    ...existing.group,
                                    pointCount: pointCount,
                                    feature: olFeature || existing.group.feature,
                                    geojsonFeatureObject: geojsonFeatureObject || existing.group.geojsonFeatureObject
                                }
                            };
                        } else if (existing) {
                            updated[idx] = {
                                ...existing,
                                pointCount: pointCount,
                                feature: olFeature || existing.feature,
                                geojsonFeatureObject: geojsonFeatureObject || existing.geojsonFeatureObject
                            };
                        }
                        return updated;
                    }
                    if (prev.length > 0 && prev[0].group) {
                        return [...prev, itemContainer];
                    }
                    return [...prev, groupObject];
                });
            } catch (e) { }
        });

        // Also check any general store or callbacks
        const root = document.getElementById('root') || document.body;
        const candidates = [root, ...Array.from(document.querySelectorAll('div, section, aside, main, nav, ul, li'))];
        const dispatchedQueues = new Set(groupsQueues);

        for (const el of candidates) {
            const key = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactContainer'));
            if (!key) continue;

            let node = el[key];
            for (let depth = 0; depth < 80 && node; depth++) {
                try {
                    const fiberStore = node.memoizedProps?.store || node.stateNode?.store || node.memoizedProps?.value?.store;
                    if (fiberStore) dispatchReduxStore(fiberStore);

                    const fiberDispatch = node.memoizedProps?.dispatch || node.memoizedProps?.value?.dispatch;
                    if (typeof fiberDispatch === 'function') {
                        try {
                            fiberDispatch({ type: 'groups/add', payload: groupObject });
                            fiberDispatch({ type: 'features/add', payload: groupObject });
                        } catch(e) {}
                    }

                    const props = node.memoizedProps;
                    if (props) {
                        if (typeof props.onGroupAdd === 'function') props.onGroupAdd(groupObject);
                        if (typeof props.onFeatureAdd === 'function') props.onFeatureAdd(groupObject);
                    }

                    // Only dispatch to known Redux/context stores or callback props
                    if (node.elementType?.name === 'tu' || node.elementType?.name === 'Dc') {
                        let s = node.memoizedState;
                        let idx = 0;
                        while (s) {
                            if (s.queue && typeof s.queue.dispatch === 'function' && Array.isArray(s.memoizedState)) {
                                if (!dispatchedQueues.has(s.queue)) {
                                    dispatchedQueues.add(s.queue);
                                    try {
                                        s.queue.dispatch(prev => {
                                            if (!Array.isArray(prev)) return prev;
                                            const eIdx = prev.findIndex(item => (item?.id === featureId || item?.group?.id === featureId || item?._id === featureId));
                                            if (eIdx !== -1) {
                                                const updated = [...prev];
                                                const existing = updated[eIdx];
                                                if (existing?.group) {
                                                    updated[eIdx] = {
                                                        ...existing,
                                                        group: {
                                                            ...existing.group,
                                                            pointCount: pointCount,
                                                            feature: olFeature || existing.group.feature,
                                                            geojsonFeatureObject: geojsonFeatureObject || existing.group.geojsonFeatureObject
                                                        }
                                                    };
                                                } else if (existing) {
                                                    updated[eIdx] = {
                                                        ...existing,
                                                        pointCount: pointCount,
                                                        feature: olFeature || existing.feature,
                                                        geojsonFeatureObject: geojsonFeatureObject || existing.geojsonFeatureObject
                                                    };
                                                }
                                                return updated;
                                            }
                                            if (prev.length > 0 && prev[0]?.group) {
                                                return [...prev, itemContainer];
                                            }
                                            return [...prev, groupObject];
                                        });
                                    } catch(e) {}
                                }
                            }
                            s = s.next;
                            idx++;
                        }
                    }
                } catch (e) {}
                node = node.return;
            }
        }
    }

    // ===== DISABLE DOUBLE CLICK ZOOM & PREVENT DARK MODAL BACKDROP =====
    function preventDarkModalOnDblClick(map) {
        if (!map || typeof map.getInteractions !== 'function') return;
        try {
            map.getInteractions().forEach(interaction => {
                const ctorName = interaction.constructor?.name || '';
                if (ctorName.includes('DoubleClick') || ctorName.includes('DblClick')) {
                    interaction.setActive(false);
                }
            });
        } catch (e) {}

        const viewport = document.querySelector('.ol-viewport');
        if (viewport && !viewport.__topoDblClickPrevented) {
            viewport.__topoDblClickPrevented = true;
            viewport.addEventListener('dblclick', function (e) {
                if (!e.target || !e.target.closest('#topo-checker-panel')) {
                    e.preventDefault();
                    e.stopPropagation();
                }
            }, true);
        }
    }

    function removeFeatureFrom3dgReactState(featureId) {
        if (!featureId) return;

        // 1. Redux Store
        if (window.store && typeof window.store.dispatch === 'function') {
            try {
                window.store.dispatch({ type: 'groups/remove', payload: featureId });
                window.store.dispatch({ type: 'groups/deleteGroup', payload: featureId });
                window.store.dispatch({ type: 'features/remove', payload: featureId });
            } catch(e) {}
        }

        // 2. Traversal of React Fiber tree
        const groupsQueues = get3dgGroupsQueues();
        groupsQueues.forEach(q => {
            try {
                q.dispatch(prev => {
                    if (!Array.isArray(prev)) return prev;
                    return prev.filter(item => {
                        const id = item.id || item._id || item.group?.id || item.geojsonFeatureObject?.id;
                        return id !== featureId;
                    });
                });
            } catch (e) { }
        });

        const root = document.getElementById('root') || document.body;
        const candidates = [root, ...Array.from(document.querySelectorAll('div, section, aside, main, nav, ul, li'))];
        const dispatchedQueues = new Set(groupsQueues);

        for (const el of candidates) {
            const key = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactContainer'));
            if (!key) continue;

            let node = el[key];
            for (let depth = 0; depth < 120 && node; depth++) {
                try {
                    let s = node.memoizedState;
                    while (s) {
                        if (s.queue && typeof s.queue.dispatch === 'function' && Array.isArray(s.memoizedState)) {
                            if (!dispatchedQueues.has(s.queue)) {
                                const arr = s.memoizedState;
                                if (arr.length > 0 && (arr[0]?.id || arr[0]?.group || arr[0]?.mode)) {
                                    dispatchedQueues.add(s.queue);
                                    s.queue.dispatch(prev => {
                                        if (Array.isArray(prev)) {
                                            return prev.filter(item => {
                                                const id = item.id || item._id || item.group?.id || item.geojsonFeatureObject?.id;
                                                return id !== featureId;
                                            });
                                        }
                                        return prev;
                                    });
                                }
                            }
                        }
                        s = s.next;
                    }
                } catch (e) {}
                node = node.return;
            }
        }
    }

    // ===== QUICK TRASH BIN BUTTON INJECTION FOR 3DG LIST ITEMS =====
    function extractCleanTitle(rawText) {
        if (!rawText) return '';
        let namePart = rawText.split('(')[0].trim();
        namePart = namePart.replace(/^[^\w\sÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝàáâãèéêìíòóôõùúýĂăĐđĨĩŨũƠơƯưẠ-ỹ]+/u, '').trim();
        return namePart;
    }

    function extractFeatureIdFromFiber(el) {
        let curr = el;
        while (curr && curr !== document.body) {
            const key = Object.keys(curr).find(k => k.startsWith('__reactFiber'));
            if (key) {
                let fiber = curr[key];
                for (let d = 0; d < 40 && fiber; d++) {
                    const props = fiber.memoizedProps || fiber.pendingProps;
                    if (props) {
                        const candidate = props.group || props.item || props.feature || props.data || props;
                        if (candidate) {
                            const fid = candidate.id || candidate._id || candidate.featureId || candidate.groupId;
                            if (fid) return fid.toString();
                        }
                        if (props.id) return props.id.toString();
                    }
                    fiber = fiber.return;
                }
            }
            curr = curr.parentElement;
        }
        return null;
    }

    function collectAllMapFeatures() {
        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        if (!map) return [];

        const results = [];
        const seenFeatures = new Set();

        function walk(layer) {
            if (typeof layer.getLayers === 'function') {
                try { layer.getLayers().forEach(walk); } catch (e) {}
                return;
            }
            try {
                const src = layer.getSource?.();
                if (!src?.getFeatures) return;
                for (const f of src.getFeatures()) {
                    if (seenFeatures.has(f)) continue;
                    seenFeatures.add(f);
                    results.push({
                        feature: f,
                        id: (f.getId ? f.getId() : (f.get?.('id') || f.id || f._id || f.id_))?.toString() || '',
                        name: (f.get?.('name') || f.get?.('Layer') || f.get?.('label') || '').toString().trim(),
                        geometry: f.getGeometry?.(),
                        layer: layer,
                        source: src
                    });
                }
            } catch (e) {}
        }

        try {
            map.getLayers().forEach(walk);
        } catch (e) {}

        return results;
    }

    function extractAndCallFiberOnRemove(parentFlex) {
        if (!parentFlex) return false;
        const card = parentFlex.closest('.border') || parentFlex.parentElement || parentFlex;
        const elementsToTry = [parentFlex, card, card.parentElement].filter(Boolean);

        for (const el of elementsToTry) {
            const key = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
            if (!key) continue;
            let node = el[key];
            for (let d = 0; d < 40 && node; d++) {
                const props = node.memoizedProps;
                if (props) {
                    const gId = props.group?.id || props.item?.id || props.id;
                    if (typeof props.onRemove === 'function') {
                        try {
                            props.onRemove(gId || props.group || props.item);
                            return true;
                        } catch(e) {}
                    }
                    if (typeof props.onDelete === 'function') {
                        try {
                            props.onDelete(gId || props.group || props.item);
                            return true;
                        } catch(e) {}
                    }
                    if (typeof props.deleteGroup === 'function') {
                        try {
                            props.deleteGroup(gId || props.group || props.item);
                            return true;
                        } catch(e) {}
                    }
                }
                node = node.return;
            }
        }
        return false;
    }

    function triggerSilentNativeDelete(parentFlex) {
        const toolsBtn = parentFlex.querySelector('button[title="Công cụ nhóm"]') || parentFlex.querySelector('.ant-dropdown-trigger');
        if (!toolsBtn) return;

        try {
            toolsBtn.click();
            setTimeout(() => {
                const dropdowns = Array.from(document.querySelectorAll('.ant-dropdown, .ant-dropdown-menu, div[role="tooltip"]'));
                for (const menu of dropdowns) {
                    const items = Array.from(menu.querySelectorAll('li, button, div, span, a'));
                    const deleteItem = items.find(el => {
                        if (el.classList && el.classList.contains('ant-dropdown-menu-item-danger')) return true;
                        const text = (el.textContent || '').trim().toLowerCase();
                        return /^(xóa|xoá|delete|remove)/i.test(text) || /(xóa nhóm|xoá nhóm|delete group)/i.test(text);
                    });
                    if (deleteItem) {
                        deleteItem.click();
                        break;
                    }
                }
            }, 30);
        } catch (e) {}
    }

    function removeFeatureDirectlyFromFlex(parentFlex) {
        const titleBtn = parentFlex.querySelector('button[title*="chọn nhóm"]') || parentFlex.querySelector('button');
        const rawTitle = titleBtn ? (titleBtn.textContent || '').trim() : '';
        const cleanName = extractCleanTitle(rawTitle);
        const targetId = extractFeatureIdFromFiber(parentFlex);

        // 1. Gọi trực tiếp hàm onRemove từ React Fiber (nếu có)
        const fiberDeleted = extractAndCallFiberOnRemove(parentFlex);

        // 2. Select the item on 3DG first by clicking title button
        if (titleBtn) {
            try { titleBtn.click(); } catch(e) {}
        }

        // 3. Trigger native dropdown delete nếu chưa xóa được qua Fiber
        if (!fiberDeleted) {
            triggerSilentNativeDelete(parentFlex);
        }

        // 4. Xử lý trong chế độ 3D Mesh / Cesium
        const viewer3d = window.__topo3dViewer || (window.__topoFind3dViewer && window.__topoFind3dViewer());
        if (viewer3d) {
            if (targetId && window.__topoUpdateCesium3dGroupColor) {
                window.__topoUpdateCesium3dGroupColor(viewer3d, targetId, 'rgba(0,0,0,0)');
            }
            try { viewer3d.entities?.removeById(targetId); } catch(e) {}
            try { viewer3d.scene?.requestRender(); } catch(e) {}
        }

        // 5. Xử lý trong chế độ 2D OpenLayers
        const allItems = collectAllMapFeatures();
        let itemsToDelete = [];

        if (targetId) {
            itemsToDelete = allItems.filter(item => item.id && (item.id === targetId || item.id.includes(targetId) || targetId.includes(item.id)));
        }

        if (itemsToDelete.length === 0 && cleanName) {
            const cleanLower = cleanName.toLowerCase();
            itemsToDelete = allItems.filter(item => {
                if (!item.name) return false;
                const nLower = item.name.toLowerCase();
                return (nLower === cleanLower || nLower.includes(cleanLower) || cleanLower.includes(nLower));
            });
        }

        // Also check if any feature is selected in OpenLayers Select interaction
        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        if (map) {
            try {
                map.getInteractions().forEach(interaction => {
                    if (typeof interaction.getFeatures === 'function') {
                        const selFeats = interaction.getFeatures();
                        if (selFeats && typeof selFeats.forEach === 'function') {
                            selFeats.forEach(sf => {
                                const found = allItems.find(it => it.feature === sf);
                                if (found && !itemsToDelete.includes(found)) {
                                    itemsToDelete.push(found);
                                }
                            });
                        }
                    }
                });
            } catch(e) {}
        }

        // Delete from OpenLayers sources
        let deletedCount = 0;
        const sourcesToRefresh = new Set();

        itemsToDelete.forEach(item => {
            try {
                if (item.source && typeof item.source.removeFeature === 'function') {
                    item.source.removeFeature(item.feature);
                    sourcesToRefresh.add(item.source);
                    deletedCount++;
                }
                const fid = item.id || item.feature.getId?.() || item.feature.get?.('id');
                if (fid && window.__topoRemoveFeatureFromReactState) {
                    window.__topoRemoveFeatureFromReactState(fid);
                }
            } catch (e) {
                console.error('[TrashDelete] Error removing feature:', e);
            }
        });

        if (targetId && window.__topoRemoveFeatureFromReactState) {
            window.__topoRemoveFeatureFromReactState(targetId);
        }

        sourcesToRefresh.forEach(src => {
            if (typeof src.changed === 'function') src.changed();
        });

        if (map && typeof map.render === 'function') {
            map.render();
        }

        // 6. Smoothly fade out and remove card DOM element
        const cardContainer = parentFlex.closest('.border') || parentFlex.parentElement;
        if (cardContainer && cardContainer.parentNode) {
            cardContainer.style.transition = 'opacity 0.15s ease';
            cardContainer.style.opacity = '0';
            setTimeout(() => {
                try { cardContainer.remove(); } catch(e) {}
            }, 150);
        }
    }

    function injectQuickTrashButtons() {
        const toolsBtns = document.querySelectorAll('button[title="Công cụ nhóm"], .border button.ant-dropdown-trigger');
        toolsBtns.forEach(btn => {
            const title = (btn.getAttribute('title') || '').toLowerCase();
            if (title.includes('xuất') || title.includes('nhập') || title.includes('tải') || title.includes('lớp') || title.includes('cài đặt')) return;
            if (btn.closest('.toolbar') || btn.closest('.topo-panel') || btn.closest('#topo-checker-panel')) return;

            const parentFlex = btn.parentElement;
            if (!parentFlex || parentFlex.querySelector('.topo-quick-delete-btn')) return;

            const trashBtn = document.createElement('button');
            trashBtn.type = 'button';
            trashBtn.className = 'topo-quick-delete-btn p-1 text-red-500 hover:text-red-700 hover:bg-red-50 rounded-md transition-colors cursor-pointer';
            trashBtn.title = 'Xóa nhanh nét vẽ này (1-Click)';
            trashBtn.style.cssText = 'display:inline-flex; align-items:center; justify-content:center; margin-left:2px; padding:3px; border:none; background:transparent; border-radius:4px; cursor:pointer; color:#ef4444; transition:color 0.15s, background 0.15s;';
            trashBtn.innerHTML = `
                <svg stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" style="width:14px; height:14px; pointer-events:none;" xmlns="http://www.w3.org/2000/svg">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
            `;

            trashBtn.addEventListener('mouseenter', () => {
                trashBtn.style.color = '#dc2626';
                trashBtn.style.background = '#fef2f2';
            });
            trashBtn.addEventListener('mouseleave', () => {
                trashBtn.style.color = '#ef4444';
                trashBtn.style.background = 'transparent';
            });

            // Capture phase handler to isolate click
            trashBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                removeFeatureDirectlyFromFlex(parentFlex);
            }, true);

            parentFlex.insertBefore(trashBtn, btn);
        });
    }

    // ===== ENHANCE NATIVE 3DG LAND TYPE COLOR POPOVER WITH STAR FAVORITES =====
    let isProcessingDom = false;

    function getFavoriteLandCodes() {
        try {
            const saved = localStorage.getItem('topo_favorite_land_codes');
            if (saved) return new Set(JSON.parse(saved));
        } catch (e) {}
        return new Set(['DGT', 'DTL', 'CLN', 'LUA', 'ODT', 'ONT']);
    }

    function saveFavoriteLandCodes(favSet) {
        try {
            localStorage.setItem('topo_favorite_land_codes', JSON.stringify(Array.from(favSet)));
        } catch (e) {}
    }

    function enhanceNativeLandTypePopover() {
        const popoverContainers = document.querySelectorAll('.ant-popover-container, .ant-popover, .ant-popover-content');
        popoverContainers.forEach(container => {
            const scrollList = container.querySelector('.max-h-64, .overflow-y-auto, .divide-y');
            if (!scrollList) return;

            const itemBtns = Array.from(scrollList.children).filter(el => el.tagName === 'BUTTON' || (el.classList && el.classList.contains('flex')));
            if (itemBtns.length === 0) return;

            const favSet = getFavoriteLandCodes();

            itemBtns.forEach(btn => {
                const spans = Array.from(btn.querySelectorAll('span'));
                const codeSpan = spans.find(s => {
                    const txt = (s.textContent || '').trim();
                    return txt.length >= 2 && txt.length <= 4 && txt === txt.toUpperCase() && /^[A-Z0-9]+$/.test(txt);
                });

                if (!codeSpan) return;
                const code = codeSpan.textContent.trim().toUpperCase();
                btn.dataset.landCode = code;

                let starBtn = btn.querySelector('.topo-native-star-btn');
                if (!starBtn) {
                    starBtn = document.createElement('button');
                    starBtn.type = 'button';
                    starBtn.className = 'topo-native-star-btn shrink-0 p-0.5 cursor-pointer';
                    starBtn.style.cssText = 'border:none; background:transparent; font-size:14px; line-height:1; padding:2px 4px; cursor:pointer; user-select:none; font-family:sans-serif; margin-right:4px;';

                    starBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        e.stopImmediatePropagation();

                        const currentFavs = getFavoriteLandCodes();
                        if (currentFavs.has(code)) {
                            currentFavs.delete(code);
                        } else {
                            currentFavs.add(code);
                        }
                        saveFavoriteLandCodes(currentFavs);
                        enhanceNativeLandTypePopover();
                    }, true);

                    btn.insertBefore(starBtn, btn.firstChild);
                }

                const isFav = favSet.has(code);
                starBtn.innerHTML = isFav ? '⭐' : '☆';
                starBtn.title = isFav ? 'Đã ghim ưu tiên (Bấm để bỏ ghim)' : 'Ghim ưu tiên loại đất này lên đầu';
                starBtn.style.opacity = isFav ? '1' : '0.4';
                btn.dataset.isFavorite = isFav ? '1' : '0';
            });

            // Check if sorting is actually required before mutating DOM
            const sortedBtns = [...itemBtns].sort((a, b) => {
                const isFavA = a.dataset.isFavorite === '1' ? 1 : 0;
                const isFavB = b.dataset.isFavorite === '1' ? 1 : 0;
                if (isFavA !== isFavB) return isFavB - isFavA;
                return 0;
            });

            let isAlreadyInOrder = true;
            for (let i = 0; i < itemBtns.length; i++) {
                if (itemBtns[i] !== sortedBtns[i]) {
                    isAlreadyInOrder = false;
                    break;
                }
            }

            // ONLY mutate DOM if order changed to avoid MutationObserver loop
            if (!isAlreadyInOrder) {
                sortedBtns.forEach(btn => scrollList.appendChild(btn));
            }
        });
    }

    // Attach popover enhancer ONCE when user clicks any color swatch trigger button or types in search box
    if (typeof window !== 'undefined') {
        document.addEventListener('click', (e) => {
            const target = e.target;
            const colorTrigger = target.closest && target.closest('button[title^="#"], button[title*="Màu"], span[title*="Màu"] button, .topo-color-trigger-btn, .ant-popover-open');
            if (colorTrigger) {
                setTimeout(enhanceNativeLandTypePopover, 30);
                setTimeout(enhanceNativeLandTypePopover, 150);
            }
        }, true);

        document.addEventListener('input', (e) => {
            const target = e.target;
            if (target && (target.placeholder?.includes('Tìm theo mã') || target.closest?.('.ant-popover-container, .ant-popover, .ant-popover-content, #topo-color-popover'))) {
                setTimeout(enhanceNativeLandTypePopover, 30);
                setTimeout(enhanceNativeLandTypePopover, 120);
            }
        }, true);
    }

    // DOM observer ONLY for quick trash button injection
    if (typeof window !== 'undefined') {
        const globalDomObserver = new MutationObserver(() => {
            if (isProcessingDom) return;
            isProcessingDom = true;
            try {
                injectQuickTrashButtons();
            } finally {
                isProcessingDom = false;
            }
        });

        const startObserving = () => {
            if (document.body) {
                globalDomObserver.observe(document.body, { childList: true, subtree: true });
            }
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', startObserving);
        } else {
            startObserving();
        }

        setInterval(() => {
            if (isProcessingDom) return;
            isProcessingDom = true;
            try {
                injectQuickTrashButtons();
            } finally {
                isProcessingDom = false;
            }
        }, 1500);
    }

    // Expose helpers globally
    window.__topoZoomToError = zoomToErrorLocation;
    window.__topoRenderAllOverlays = renderAllErrorOverlays;
    window.__topoClearHighlight = clearAllErrorOverlays;
    window.__topoSyncFeatureToReactState = syncFeatureTo3dgReactState;
    window.__topoRemoveFeatureFromReactState = removeFeatureFrom3dgReactState;
    window.__topoToggleHighlight = toggleErrorHighlight;

    // Auto init check
    (function waitForMap() {
        const map = findOlMap();
        if (map) {
            window.__topoMap = map;
            preventDarkModalOnDblClick(map);
            log('✅ OpenLayers Map detected and hooked ready!');
            attachMapRenderListeners(map);
            document.dispatchEvent(new CustomEvent('topo:map-ready', { detail: { map } }));
        } else {
            setTimeout(waitForMap, 1500);
        }
    })();

})();
