// ============================================================
// 3DG Map Tools — Feature Module 4: Area Deleter (Xóa Vùng)
// - Simple interactive polygon drawing on map (Click points to outline area)
// - Spatial query: finds all lines intersecting user-drawn polygon
// - Highlights lines with glowing thick stroke
// - Confirmation dialog and feature deletion from OpenLayers sources
// ============================================================

(function () {
    'use strict';

    function log() {}

    // ===== STATE MANAGEMENT =====
    let isSelectingRegion = false;
    let drawnPoints = [];
    let selectedFeatureItems = [];
    let renderAnimationFrameId = null;

    // ===== SPATIAL ALGORITHMS =====
    function isPointInPolygon(point, vs) {
        const x = point[0], y = point[1];
        let inside = false;
        for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
            const xi = vs[i][0], yi = vs[i][1];
            const xj = vs[j][0], yj = vs[j][1];
            const intersect = ((yi > y) !== (yj > y)) &&
                (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    function segmentsIntersect(a, b, c, d) {
        function ccw(p1, p2, p3) {
            return (p3[1] - p1[1]) * (p2[0] - p1[0]) > (p2[1] - p1[1]) * (p3[0] - p1[0]);
        }
        return (ccw(a, c, d) !== ccw(b, c, d)) && (ccw(a, b, c) !== ccw(a, b, d));
    }

    function lineIntersectsPolygon(lineCoords, polyCoords) {
        if (!polyCoords || polyCoords.length < 3 || !lineCoords || lineCoords.length === 0) return false;

        // Check 1: Any vertex inside polygon
        for (const pt of lineCoords) {
            if (isPointInPolygon(pt, polyCoords)) return true;
        }

        // Check 2: Any segment midpoint inside polygon
        for (let i = 0; i < lineCoords.length - 1; i++) {
            const mid = [(lineCoords[i][0] + lineCoords[i + 1][0]) / 2, (lineCoords[i][1] + lineCoords[i + 1][1]) / 2];
            if (isPointInPolygon(mid, polyCoords)) return true;
        }

        // Check 3: Any segment intersects polygon edge
        for (let i = 0; i < lineCoords.length - 1; i++) {
            const p1 = lineCoords[i];
            const p2 = lineCoords[i + 1];
            for (let j = 0; j < polyCoords.length; j++) {
                const q1 = polyCoords[j];
                const q2 = polyCoords[(j + 1) % polyCoords.length];
                if (segmentsIntersect(p1, p2, q1, q2)) return true;
            }
        }

        return false;
    }

    // ===== CANVAS OVERLAY FOR DRAWING POLYGON =====
    function getOrCreateCanvasOverlay() {
        const viewport = document.querySelector('.ol-viewport');
        if (!viewport) return null;

        let canvas = document.getElementById('topo-area-draw-canvas');
        if (canvas && viewport.contains(canvas)) {
            if (canvas.width !== viewport.clientWidth || canvas.height !== viewport.clientHeight) {
                canvas.width = viewport.clientWidth;
                canvas.height = viewport.clientHeight;
            }
            return canvas;
        }

        canvas = document.createElement('canvas');
        canvas.id = 'topo-area-draw-canvas';
        canvas.style.cssText = 'position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:9998; cursor:default;';
        canvas.width = viewport.clientWidth;
        canvas.height = viewport.clientHeight;
        viewport.appendChild(canvas);
        return canvas;
    }

    function requestPolygonRender() {
        if (renderAnimationFrameId) return;
        renderAnimationFrameId = requestAnimationFrame(() => {
            renderAnimationFrameId = null;
            drawSelectionPolygonCanvas();
        });
    }

    function drawSelectionPolygonCanvas() {
        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        const canvas = getOrCreateCanvasOverlay();
        if (!canvas || !map) return;

        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (!drawnPoints || drawnPoints.length === 0) return;

        const pixels = drawnPoints.map(pt => map.getPixelFromCoordinate(pt)).filter(p => p && !isNaN(p[0]));
        if (pixels.length === 0) return;

        ctx.save();

        ctx.beginPath();
        ctx.moveTo(pixels[0][0], pixels[0][1]);
        for (let i = 1; i < pixels.length; i++) {
            ctx.lineTo(pixels[i][0], pixels[i][1]);
        }

        if (pixels.length > 2) {
            ctx.closePath();
            ctx.fillStyle = 'rgba(56, 189, 248, 0.22)';
            ctx.fill();
        }

        ctx.strokeStyle = '#0284c7';
        ctx.lineWidth = 2.5;
        ctx.setLineDash([6, 4]);
        ctx.stroke();

        pixels.forEach(p => {
            ctx.beginPath();
            ctx.arc(p[0], p[1], 5, 0, Math.PI * 2);
            ctx.fillStyle = '#0284c7';
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.stroke();
        });

        ctx.restore();
    }

    // ===== DISABLE / RESTORE NATIVE MAP INTERACTIONS =====
    function disableNativeMapInteractions(map) {
        if (!map || typeof map.getInteractions !== 'function') return;
        try {
            map.getInteractions().forEach(interaction => {
                if (interaction && typeof interaction.setActive === 'function') {
                    const name = interaction.constructor?.name || '';
                    if (name.includes('Draw') || name.includes('Modify') || name.includes('Snap')) {
                        if (interaction.getActive()) {
                            interaction.setActive(false);
                            interaction.__topoDisabled = true;
                        }
                    }
                }
            });
        } catch (e) {}
    }

    function restoreNativeMapInteractions(map) {
        if (!map || typeof map.getInteractions !== 'function') return;
        try {
            map.getInteractions().forEach(interaction => {
                if (interaction && interaction.__topoDisabled) {
                    interaction.setActive(true);
                    delete interaction.__topoDisabled;
                }
            });
        } catch (e) {}
    }

    let areaMouseDownPos = null;

    function isUIElementClick(e) {
        if (!e || !e.target) return false;
        return !!(e.target.closest('#topo-checker-panel') || e.target.closest('#topo-fab-btn') || e.target.closest('.topo-area-bar'));
    }

    function onAreaMouseDown(e) {
        if (!isSelectingRegion || isUIElementClick(e) || e.button !== 0) return;
        if (e.stopPropagation) e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        areaMouseDownPos = { x: e.clientX, y: e.clientY, time: Date.now() };
    }

    function onAreaMouseUp(e) {
        if (!isSelectingRegion || !areaMouseDownPos || isUIElementClick(e) || e.button !== 0) return;
        if (e.stopPropagation) e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();

        const dx = e.clientX - areaMouseDownPos.x;
        const dy = e.clientY - areaMouseDownPos.y;
        const dist = Math.hypot(dx, dy);
        const duration = Date.now() - areaMouseDownPos.time;

        areaMouseDownPos = null;

        if (dist > 6 || duration > 350) return;

        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        const canvas = getOrCreateCanvasOverlay();
        if (!map || !canvas) return;

        const rect = canvas.getBoundingClientRect();
        const px = [e.clientX - rect.left, e.clientY - rect.top];
        const coord = map.getCoordinateFromPixel(px);

        if (coord) {
            drawnPoints.push(coord);
            requestPolygonRender();
            document.dispatchEvent(new CustomEvent('topo:area-point-added', { detail: { count: drawnPoints.length } }));
        }
    }

    function attachCanvasMouseEvents() {
        const canvas = getOrCreateCanvasOverlay();
        if (!canvas) return;
        areaMouseDownPos = null;
        canvas.addEventListener('mousedown', onAreaMouseDown, true);
        canvas.addEventListener('mouseup', onAreaMouseUp, true);
    }

    function detachCanvasMouseEvents() {
        const canvas = document.getElementById('topo-area-draw-canvas');
        if (canvas) {
            canvas.removeEventListener('mousedown', onAreaMouseDown, true);
            canvas.removeEventListener('mouseup', onAreaMouseUp, true);
            canvas.style.pointerEvents = 'none';
            canvas.style.cursor = 'default';
        }
    }

    function attachMapRenderListeners() {
        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        if (!map) return;

        try {
            map.on('postrender', requestPolygonRender);
            const view = map.getView();
            if (view && view.on) {
                view.on('change:center', requestPolygonRender);
                view.on('change:resolution', requestPolygonRender);
            }
        } catch (e) {}
    }

    function detachMapRenderListeners() {
        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        if (!map) return;

        try {
            map.un('postrender', requestPolygonRender);
            const view = map.getView();
            if (view && view.un) {
                view.un('change:center', requestPolygonRender);
                view.un('change:resolution', requestPolygonRender);
            }
        } catch (e) {}
    }

    function startAreaSelection() {
        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        if (!map) return false;

        disableNativeMapInteractions(map);

        isSelectingRegion = true;
        drawnPoints = [];
        selectedFeatureItems = [];
        clearHighlightedFeatures();

        const canvas = getOrCreateCanvasOverlay();
        if (canvas) {
            canvas.style.pointerEvents = 'auto';
            canvas.style.cursor = 'crosshair';
        }

        attachCanvasMouseEvents();
        attachMapRenderListeners();
        requestPolygonRender();

        log('Area selection mode activated.');
        return true;
    }

    function cancelAreaSelection() {
        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        if (map) restoreNativeMapInteractions(map);

        isSelectingRegion = false;
        drawnPoints = [];
        selectedFeatureItems = [];

        detachCanvasMouseEvents();
        detachMapRenderListeners();

        const canvas = document.getElementById('topo-area-draw-canvas');
        if (canvas) {
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            canvas.style.pointerEvents = 'none';
            canvas.style.cursor = 'default';
        }

        clearHighlightedFeatures();
        log('Area selection cancelled.');
    }

    function collectAllFeatures() {
        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        if (!map) return [];

        const results = [];
        const seenFeatures = new Set();

        function walk(layer) {
            if (typeof layer.getLayers === 'function') {
                try { layer.getLayers().forEach(walk); } catch (e) { }
                return;
            }
            try {
                const src = layer.getSource?.();
                if (!src?.getFeatures) return;
                for (const f of src.getFeatures()) {
                    if (seenFeatures.has(f)) continue;
                    seenFeatures.add(f);
                    const geom = f.getGeometry?.();
                    if (!geom) continue;

                    results.push({
                        feature: f,
                        id: f.getId?.() || ('feat_' + results.length),
                        geometry: geom,
                        layer: layer,
                        source: src
                    });
                }
            } catch (e) { }
        }

        try {
            map.getLayers().forEach(walk);
        } catch (e) { }

        return results;
    }

    function queryAndHighlightSelectedFeatures() {
        if (drawnPoints.length < 3) return [];

        const allFeatures = collectAllFeatures();
        clearHighlightedFeatures();
        selectedFeatureItems = [];

        for (const item of allFeatures) {
            const geom = item.geometry;
            const type = geom.getType();
            const coords = geom.getCoordinates();

            let matches = false;

            if (type === 'LineString') {
                matches = lineIntersectsPolygon(coords, drawnPoints);
            } else if (type === 'MultiLineString') {
                for (const line of coords) {
                    if (lineIntersectsPolygon(line, drawnPoints)) {
                        matches = true;
                        break;
                    }
                }
            } else if (type === 'Polygon') {
                for (const ring of coords) {
                    if (lineIntersectsPolygon(ring, drawnPoints)) {
                        matches = true;
                        break;
                    }
                }
            }

            if (matches) {
                selectedFeatureItems.push(item);
            }
        }

        highlightSelectedFeatures(selectedFeatureItems);
        return selectedFeatureItems;
    }

    function finishAreaSelection() {
        if (drawnPoints.length < 3) {
            alert('Vui lòng chọn ít nhất 3 điểm trên bản đồ để tạo vùng khép kín!');
            return [];
        }

        isSelectingRegion = false;
        detachCanvasMouseEvents();

        const items = queryAndHighlightSelectedFeatures();
        log(`Scan complete. Found ${items.length} lines inside region.`);
        return items;
    }

    function clearHighlightedFeatures() {
        selectedFeatureItems.forEach(item => {
            try {
                if (item.isColorApplied) {
                    item.feature.setStyle(null);
                    return;
                }
                if (item.originalStyle !== undefined) {
                    item.feature.setStyle(item.originalStyle);
                } else {
                    item.feature.setStyle(null);
                }
            } catch (e) {}
        });
    }

    function highlightSelectedFeatures(items) {
        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        if (!map || !items.length) return;

        items.forEach(item => {
            try {
                if (item.originalStyle === undefined) {
                    item.originalStyle = item.feature.getStyle();
                }

                if (window.ol && window.ol.style) {
                    const highlightStyle = new window.ol.style.Style({
                        stroke: new window.ol.style.Stroke({
                            color: '#0284c7',
                            width: 7
                        }),
                        fill: new window.ol.style.Fill({
                            color: 'rgba(2, 132, 199, 0.4)'
                        })
                    });
                    item.feature.setStyle(highlightStyle);
                    if (typeof item.feature.changed === 'function') item.feature.changed();
                    if (item.source && typeof item.source.changed === 'function') item.source.changed();
                }
            } catch (e) {}
        });

        if (map && typeof map.render === 'function') {
            map.render();
        }
    }

    function deleteSelectedFeatures() {
        if (!selectedFeatureItems || selectedFeatureItems.length === 0) return 0;

        let deletedCount = 0;

        selectedFeatureItems.forEach(item => {
            try {
                if (item.source && typeof item.source.removeFeature === 'function') {
                    item.source.removeFeature(item.feature);
                    deletedCount++;
                }
                const featId = item.feature.getId ? item.feature.getId() : item.feature.get?.('id');
                if (featId && window.__topoRemoveFeatureFromReactState) {
                    window.__topoRemoveFeatureFromReactState(featId);
                }
            } catch (e) {
                console.error('[AreaDeleter] Failed to remove feature:', e);
            }
        });

        cancelAreaSelection();
        log(`Successfully deleted ${deletedCount} features from map.`);
        return deletedCount;
    }

    // Global APIs
    window.__areaDeleterStart = startAreaSelection;
    window.__areaDeleterFinish = finishAreaSelection;
    window.__areaDeleterCancel = cancelAreaSelection;
    window.__areaDeleterDelete = deleteSelectedFeatures;
    window.__areaDeleterGetSelectedCount = () => selectedFeatureItems.length;
    window.__areaDeleterGetSelectedFeatures = () => selectedFeatureItems;

})();
