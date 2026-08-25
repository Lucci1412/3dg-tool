// ============================================================
// 3DG Map Tools — Feature Module 5: Cut Line / Split Stroke (Cắt Nét Vẽ)
// - Interactive 2-point cutting line on map: Click 2 points (or Double-Click) to cut
// - Intercepts all canvas clicks (pointer-events: auto) so native 3DG NEVER creates stray lines
// - Live stray line guard & cleanup to prevent any 2-point cutting line from being saved
// - Automatically cuts and splits all intersecting polylines into 2+ segments
// - Preserves all feature properties, landType, Layer, and visual styles
// ============================================================

(function () {
    'use strict';

    function log(...args) {
        // console.log('[CutLine]', ...args);
    }

    // ===== STATE MANAGEMENT =====
    let isCutting = false;
    let activeCutPoints = []; // [p1, p2]
    let currentMouseCoord = null;
    let lastSnapInfo = { coord: null, isSnapped: false };
    let canvasOverlay = null;
    let renderPending = false;
    let lastClickInfo = { time: 0, pos: null };
    let mouseDownPos = null;
    let justFinishedTime = 0;



    // Cache of target sources
    let cachedSourcesResult = null;

    function getCachedSources(map) {
        if (!cachedSourcesResult) {
            cachedSourcesResult = findAllTargetLineSources(map);
        }
        return cachedSourcesResult;
    }

    function invalidateSourcesCache() {
        cachedSourcesResult = null;
    }

    function generateUUID() {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        return 'cut-' + Date.now() + '-' + Math.floor(Math.random() * 100000);
    }

    function sanitizeCoords(pts) {
        if (!pts || pts.length < 2) return pts || [];
        const cleaned = [pts[0]];
        for (let i = 1; i < pts.length; i++) {
            const prev = cleaned[cleaned.length - 1];
            const curr = pts[i];
            if (Math.abs(curr[0] - prev[0]) > 1e-6 || Math.abs(curr[1] - prev[1]) > 1e-6) {
                cleaned.push(curr);
            }
        }
        return cleaned;
    }

    // ===== GEOMETRY INTERSECTION & SPLITTING =====
    function distSq(p1, p2) {
        const dx = p1[0] - p2[0];
        const dy = p1[1] - p2[1];
        return dx * dx + dy * dy;
    }

    /**
     * Finds intersection between segment 1 (p1->p2) and segment 2 (p3->p4)
     * Returns { point: [x, y], t, u } or null
     */
    function findSegmentIntersection(p1, p2, p3, p4) {
        const dx1 = p2[0] - p1[0];
        const dy1 = p2[1] - p1[1];
        const dx2 = p4[0] - p3[0];
        const dy2 = p4[1] - p3[1];

        const det = dx1 * dy2 - dy1 * dx2;
        if (Math.abs(det) < 1e-12) return null; // Parallel or collinear

        const t = ((p3[0] - p1[0]) * dy2 - (p3[1] - p1[1]) * dx2) / det;
        const u = ((p3[0] - p1[0]) * dy1 - (p3[1] - p1[1]) * dx1) / det;

        const EPS = 1e-6;
        if (t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS) {
            const clampedT = Math.max(0, Math.min(1, t));
            const clampedU = Math.max(0, Math.min(1, u));

            const intX = p1[0] + clampedT * dx1;
            const intY = p1[1] + clampedT * dy1;

            return {
                point: [intX, intY],
                t: clampedT,
                u: clampedU
            };
        }

        return null;
    }

    /**
     * Splits polyline coords by a cutting segment [cutStart, cutEnd].
     * Returns array of split sub-polyline coords arrays, or null if no cut.
     */
    function splitPolylineByCutLine(coords, cutStart, cutEnd) {
        if (!coords || coords.length < 2 || !cutStart || !cutEnd) return null;

        const intersections = [];

        for (let i = 0; i < coords.length - 1; i++) {
            const p1 = coords[i];
            const p2 = coords[i + 1];

            const inter = findSegmentIntersection(p1, p2, cutStart, cutEnd);
            if (inter) {
                intersections.push({
                    segIndex: i,
                    t: inter.t,
                    point: inter.point
                });
            }
        }

        if (intersections.length === 0) return null;

        // Sort intersections sequentially along the polyline
        intersections.sort((a, b) => {
            if (a.segIndex !== b.segIndex) return a.segIndex - b.segIndex;
            return a.t - b.t;
        });

        // Split into sub-lines
        const pieces = [];
        let currentPiece = [coords[0]];
        let interIdx = 0;

        for (let i = 0; i < coords.length - 1; i++) {
            const nextVertex = coords[i + 1];

            // Process all intersections occurring on this segment
            while (interIdx < intersections.length && intersections[interIdx].segIndex === i) {
                const cutPt = intersections[interIdx].point;

                // Add intersection point to current piece if not identical to last point
                const lastPt = currentPiece[currentPiece.length - 1];
                if (distSq(lastPt, cutPt) > 1e-10) {
                    currentPiece.push(cutPt);
                }

                const cleanPiece = sanitizeCoords(currentPiece);
                if (cleanPiece.length >= 2) {
                    pieces.push(cleanPiece);
                }

                // Start new piece from the intersection point
                currentPiece = [cutPt];
                interIdx++;
            }

            // Add next vertex to current piece
            const lastPt = currentPiece[currentPiece.length - 1];
            if (distSq(lastPt, nextVertex) > 1e-10) {
                currentPiece.push(nextVertex);
            }
        }

        const finalPiece = sanitizeCoords(currentPiece);
        if (finalPiece.length >= 2) {
            pieces.push(finalPiece);
        }

        return pieces.length >= 2 ? pieces : null;
    }

    // ===== FIND VECTOR SOURCES & FEATURES =====
    function findAllTargetLineSources(map) {
        if (!map) return { primary: null, sources: [], sample: null };

        const sources = [];
        let primarySource = null;
        let sampleLineFeature = null;

        function walk(layer) {
            if (typeof layer.getLayers === 'function') {
                try { layer.getLayers().forEach(walk); } catch (e) { }
                return;
            }

            try {
                const src = layer.getSource?.();
                if (!src || !src.getFeatures) return;

                const layerId = (layer.get?.('id') || layer.get?.('name') || layer.get?.('title') || '').toString().toLowerCase();
                const isIgnored = layerId.includes('marker') || layerId.includes('highlight') ||
                    layerId.includes('canvas') || layerId.includes('overlay') || layerId.includes('topo');

                if (isIgnored) return;

                const feats = src.getFeatures();
                let hasLineString = false;

                for (const f of feats) {
                    const geom = f.getGeometry?.();
                    const gType = geom?.getType?.();
                    if (gType === 'LineString' || gType === 'MultiLineString') {
                        hasLineString = true;
                        if (!sampleLineFeature) sampleLineFeature = f;
                        break;
                    }
                }

                if (!sources.includes(src)) {
                    sources.push(src);
                }

                if (hasLineString || layerId.includes('edit') || layerId.includes('draw') || layerId.includes('main') || layerId.includes('vector')) {
                    if (!primarySource) primarySource = src;
                }
            } catch (e) { }
        }

        try {
            map.getLayers().forEach(walk);
        } catch (e) { }

        if (!primarySource && sources.length > 0) {
            primarySource = sources[0];
        }

        return { primary: primarySource, sources: sources, sample: sampleLineFeature };
    }

    function createOlStyleForFeature(color, width = 3.5, sampleFeature = null, map = null) {
        const ol = window.ol || window.openlayers;
        let StyleClass = ol?.style?.Style;
        let StrokeClass = ol?.style?.Stroke;

        if (!StyleClass && sampleFeature && typeof sampleFeature.getStyle === 'function') {
            try {
                const st = sampleFeature.getStyle();
                const sampleInst = typeof st === 'function' ? st(sampleFeature, 1) : st;
                const item = Array.isArray(sampleInst) ? sampleInst[0] : sampleInst;
                if (item) {
                    StyleClass = item.constructor;
                    if (typeof item.getStroke === 'function') {
                        const strokeInst = item.getStroke();
                        if (strokeInst) StrokeClass = strokeInst.constructor;
                    }
                }
            } catch (e) { }
        }

        if (StyleClass && StrokeClass) {
            try {
                return new StyleClass({
                    stroke: new StrokeClass({
                        color: color || '#ffaa32',
                        width: width
                    })
                });
            } catch (e) { }
        }

        return null;
    }

    function createSplitFeature(origFeature, coords, map) {
        const ol = window.ol || window.openlayers;
        const clean = sanitizeCoords(coords);
        if (!clean || clean.length < 2) return null;

        const origGeom = origFeature.getGeometry?.();
        const LineStringClass = origGeom?.constructor || ol?.geom?.LineString;
        const FeatureClass = origFeature.constructor || ol?.Feature;

        if (!LineStringClass || !FeatureClass) return null;

        try {
            let newGeom = null;
            if (origGeom && typeof origGeom.clone === 'function') {
                newGeom = origGeom.clone();
                newGeom.setCoordinates(clean);
            } else {
                newGeom = new LineStringClass(clean, 'XY');
            }

            let newFeat = null;
            if (typeof origFeature.clone === 'function') {
                try {
                    newFeat = origFeature.clone();
                    newFeat.setGeometry(newGeom);
                } catch (e) { }
            }

            if (!newFeat) {
                newFeat = new FeatureClass({ geometry: newGeom });
            }

            const newId = generateUUID();
            if (typeof newFeat.setId === 'function') newFeat.setId(newId);
            newFeat.id_ = newId;
            newFeat._id = newId;
            newFeat.id = newId;

            // Preserve style
            const origStyle = origFeature.getStyle?.();
            if (origStyle) {
                newFeat.setStyle(origStyle);
            } else {
                const color = origFeature.get?.('color') || origFeature.get?.('strokeColor') || '#ffaa32';
                const customStyle = createOlStyleForFeature(color, 3.5, origFeature, map);
                if (customStyle) newFeat.setStyle(customStyle);
            }

            return newFeat;
        } catch (e) {
            console.error('[CutLine] Failed to create split feature:', e);
        }

        return null;
    }

    // ===== ENSURE NATIVE 3DG EDIT MODE IS "CHỌN/SỬA" (NOT DRAW) =====
    function ensureNative3dgSelectEditModeActive() {
        try {
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

            const trySelectEdit = () => {
                const labels = Array.from(document.querySelectorAll('.ant-segmented-item, label'));
                const selectEditLabel = labels.find(el => {
                    const text = (el.textContent || '').trim();
                    const svg = el.querySelector('svg');
                    const svgHtml = svg?.outerHTML || '';
                    return text.includes('Chọn/Sửa') || text === 'Chọn' || text === 'Sửa' || svgHtml.includes('M4.037 4.688') || svgHtml.includes('4.037');
                });

                if (selectEditLabel) {
                    const input = selectEditLabel.querySelector('input') || selectEditLabel.closest('label')?.querySelector('input');
                    if (input && !input.checked) {
                        selectEditLabel.click();
                        input.click();
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                    } else if (!selectEditLabel.classList.contains('ant-segmented-item-selected')) {
                        selectEditLabel.click();
                    }
                }
            };

            trySelectEdit();
            setTimeout(trySelectEdit, 150);
        } catch (e) { }
    }

    // ===== CANVAS OVERLAY & LIVE PREVIEW =====
    function getOrCreateCanvasOverlay() {
        const viewport = document.querySelector('.ol-viewport');
        if (!viewport) return null;

        let canvas = document.getElementById('topo-cut-line-canvas');
        if (canvas && viewport.contains(canvas)) {
            if (canvas.width !== viewport.clientWidth || canvas.height !== viewport.clientHeight) {
                canvas.width = viewport.clientWidth;
                canvas.height = viewport.clientHeight;
            }
            canvasOverlay = canvas;
            return canvas;
        }

        canvas = document.createElement('canvas');
        canvas.id = 'topo-cut-line-canvas';
        canvas.style.cssText = 'position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:auto; z-index:9998; cursor:crosshair;';
        canvas.width = viewport.clientWidth;
        canvas.height = viewport.clientHeight;
        viewport.appendChild(canvas);

        canvasOverlay = canvas;
        return canvas;
    }

    function clearCanvas() {
        const canvas = getOrCreateCanvasOverlay();
        if (canvas) {
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    }

    function requestCanvasRender() {
        if (renderPending) return;
        renderPending = true;
        requestAnimationFrame(() => {
            renderPending = false;
            renderCutCanvas();
        });
    }

    /**
     * Scans for intersection points between [startPoint, currentMouseCoord] and all features
     */
    function findLiveIntersections(map, pStart, pEnd) {
        if (!map || !pStart || !pEnd) return [];

        const { sources: allSources } = getCachedSources(map);
        const hitPoints = [];
        const seenFeatures = new Set();

        allSources.forEach(source => {
            if (!source || !source.getFeatures) return;
            source.getFeatures().forEach(f => {
                if (seenFeatures.has(f)) return;
                seenFeatures.add(f);

                const geom = f.getGeometry?.();
                if (!geom) return;
                const type = geom.getType?.();

                if (type === 'LineString') {
                    const coords = geom.getCoordinates();
                    if (coords && coords.length >= 2) {
                        for (let i = 0; i < coords.length - 1; i++) {
                            const inter = findSegmentIntersection(coords[i], coords[i + 1], pStart, pEnd);
                            if (inter) hitPoints.push(inter.point);
                        }
                    }
                } else if (type === 'MultiLineString') {
                    const lines = geom.getCoordinates();
                    if (lines) {
                        for (const line of lines) {
                            if (line && line.length >= 2) {
                                for (let i = 0; i < line.length - 1; i++) {
                                    const inter = findSegmentIntersection(line[i], line[i + 1], pStart, pEnd);
                                    if (inter) hitPoints.push(inter.point);
                                }
                            }
                        }
                    }
                }
            });
        });

        return hitPoints;
    }

    function renderCutCanvas() {
        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        const canvas = getOrCreateCanvasOverlay();
        if (!canvas || !map || !isCutting) return;

        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        ctx.save();

        // 1. Draw Green Magnet Ring Snap Indicator if mouse is snapped to existing vertex
        if (lastSnapInfo && lastSnapInfo.isSnapped && lastSnapInfo.coord) {
            const snapPx = map.getPixelFromCoordinate(lastSnapInfo.coord);
            if (snapPx && !isNaN(snapPx[0]) && !isNaN(snapPx[1])) {
                ctx.beginPath();
                ctx.arc(snapPx[0], snapPx[1], 9, 0, Math.PI * 2);
                ctx.strokeStyle = '#22c55e';
                ctx.lineWidth = 2.5;
                ctx.shadowColor = '#22c55e';
                ctx.shadowBlur = 10;
                ctx.stroke();

                ctx.beginPath();
                ctx.arc(snapPx[0], snapPx[1], 4, 0, Math.PI * 2);
                ctx.fillStyle = '#22c55e';
                ctx.fill();
            }
        }

        // 2. Draw Cutting Line & Intersection Markers
        if (activeCutPoints.length >= 1) {
            const p1 = activeCutPoints[0];
            const p2 = activeCutPoints.length >= 2 ? activeCutPoints[1] : (lastSnapInfo && lastSnapInfo.isSnapped && lastSnapInfo.coord ? lastSnapInfo.coord : currentMouseCoord);

            const startPx = p1 ? map.getPixelFromCoordinate(p1) : null;
            const endPx = p2 ? map.getPixelFromCoordinate(p2) : null;

            if (startPx && endPx && !isNaN(startPx[0]) && !isNaN(endPx[0])) {
                // Glow shadow
                ctx.beginPath();
                ctx.moveTo(startPx[0], startPx[1]);
                ctx.lineTo(endPx[0], endPx[1]);
                ctx.strokeStyle = '#ef4444';
                ctx.lineWidth = 4;
                ctx.shadowColor = '#ef4444';
                ctx.shadowBlur = 10;
                ctx.setLineDash([8, 6]);
                ctx.lineCap = 'round';
                ctx.stroke();

                // Core dashed line
                ctx.beginPath();
                ctx.moveTo(startPx[0], startPx[1]);
                ctx.lineTo(endPx[0], endPx[1]);
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 2;
                ctx.shadowBlur = 0;
                ctx.setLineDash([8, 6]);
                ctx.stroke();
                ctx.setLineDash([]);

                // Start point dot
                ctx.beginPath();
                ctx.arc(startPx[0], startPx[1], 6, 0, Math.PI * 2);
                ctx.fillStyle = '#ef4444';
                ctx.fill();
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 2;
                ctx.stroke();

                // End point dot
                ctx.beginPath();
                ctx.arc(endPx[0], endPx[1], 6, 0, Math.PI * 2);
                ctx.fillStyle = '#f59e0b';
                ctx.fill();
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 2;
                ctx.stroke();

                // Find & highlight real-time intersection points
                const intersections = findLiveIntersections(map, p1, p2);
                intersections.forEach(intPt => {
                    const intPx = map.getPixelFromCoordinate(intPt);
                    if (intPx && !isNaN(intPx[0]) && !isNaN(intPx[1])) {
                        // Outer glowing ring
                        ctx.beginPath();
                        ctx.arc(intPx[0], intPx[1], 8, 0, Math.PI * 2);
                        ctx.strokeStyle = '#dc2626';
                        ctx.lineWidth = 2.5;
                        ctx.shadowColor = '#f87171';
                        ctx.shadowBlur = 8;
                        ctx.stroke();

                        // Inner cross ✕
                        ctx.beginPath();
                        ctx.moveTo(intPx[0] - 4, intPx[1] - 4);
                        ctx.lineTo(intPx[0] + 4, intPx[1] + 4);
                        ctx.moveTo(intPx[0] + 4, intPx[1] - 4);
                        ctx.lineTo(intPx[0] - 4, intPx[1] + 4);
                        ctx.strokeStyle = '#ffffff';
                        ctx.lineWidth = 2;
                        ctx.shadowBlur = 0;
                        ctx.stroke();
                    }
                });

                // Status hint text floating near cursor
                const labelText = activeCutPoints.length >= 2
                    ? `✂️ Nhấp đúp để thực hiện cắt (${intersections.length} vị trí)`
                    : (intersections.length > 0 ? `✂️ Cắt ${intersections.length} vị trí (Nhấp đúp/click để cắt)` : `✂️ Chọn điểm 2 (Nhấp đúp để cắt)`);

                ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
                ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
                const textWidth = ctx.measureText(labelText).width;
                const tagX = endPx[0] + 12;
                const tagY = endPx[1] - 12;

                ctx.beginPath();
                ctx.roundRect(tagX, tagY - 14, textWidth + 12, 20, 4);
                ctx.fill();
                ctx.strokeStyle = '#ef4444';
                ctx.lineWidth = 1;
                ctx.stroke();

                ctx.fillStyle = '#ffffff';
                ctx.fillText(labelText, tagX + 6, tagY);
            }
        }

        ctx.restore();
    }

    // ===== VERTEX SNAPPING UTILITY =====
    function getSnappedCoordinate(map, rawCoord, pxThreshold = 20) {
        if (!map || !rawCoord) return { coord: rawCoord, isSnapped: false };
        const mousePx = map.getPixelFromCoordinate(rawCoord);
        if (!mousePx) return { coord: rawCoord, isSnapped: false };

        let closestCoord = rawCoord;
        let minPxDist = pxThreshold;
        let isSnapped = false;

        const view = map.getView();
        const resolution = view ? view.getResolution() : 1;
        const bufferMapUnits = pxThreshold * (resolution || 1) * 1.5;
        const searchExtent = [
            rawCoord[0] - bufferMapUnits,
            rawCoord[1] - bufferMapUnits,
            rawCoord[0] + bufferMapUnits,
            rawCoord[1] + bufferMapUnits
        ];

        const { sources: allSources } = getCachedSources(map);

        for (const src of allSources) {
            if (!src) continue;

            const nearbyFeatures = typeof src.getFeaturesInExtent === 'function'
                ? src.getFeaturesInExtent(searchExtent)
                : (src.getFeatures ? src.getFeatures() : []);

            for (const f of nearbyFeatures) {
                const geom = f.getGeometry?.();
                if (!geom) continue;
                const type = geom.getType?.();

                let coordList = [];
                if (type === 'LineString') {
                    coordList = geom.getCoordinates() || [];
                } else if (type === 'MultiLineString' || type === 'Polygon') {
                    const rings = geom.getCoordinates() || [];
                    for (const r of rings) {
                        if (Array.isArray(r)) {
                            for (const pt of r) coordList.push(pt);
                        }
                    }
                } else if (type === 'Point') {
                    coordList = [geom.getCoordinates()];
                }

                for (const pt of coordList) {
                    if (!pt || !Array.isArray(pt) || pt.length < 2) continue;
                    const px = map.getPixelFromCoordinate(pt);
                    if (!px) continue;
                    const d = Math.hypot(mousePx[0] - px[0], mousePx[1] - px[1]);
                    if (d < minPxDist) {
                        minPxDist = d;
                        closestCoord = pt;
                        isSnapped = true;
                    }
                }
            }
        }

        return { coord: closestCoord, isSnapped };
    }

    // ===== DISABLE / RESTORE NATIVE MAP INTERACTIONS =====
    function disableNativeMapInteractions(map) {
        if (!map || typeof map.getInteractions !== 'function') return;
        try {
            map.getInteractions().forEach(interaction => {
                if (interaction && typeof interaction.setActive === 'function') {
                    const name = interaction.constructor?.name || '';
                    if (name.includes('Draw') || name.includes('Modify') || name.includes('Snap') || name.includes('DoubleClickZoom')) {
                        if (interaction.getActive()) {
                            interaction.setActive(false);
                            interaction.__topoDisabled = true;
                        }
                    }
                }
            });
        } catch (e) { }
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
        } catch (e) { }
    }

    // ===== EXECUTE CUT LINE ACTION =====
    function executeCutLine(pStart, pEnd) {
        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        if (!map || !pStart || !pEnd) return 0;

        const { sources: allSources } = getCachedSources(map);
        let totalCutFeatures = 0;
        let totalCreatedSegments = 0;

        const modifications = []; // { source, origFeature, newFeatures }

        allSources.forEach(source => {
            if (!source || !source.getFeatures) return;
            const features = [...source.getFeatures()];

            features.forEach(f => {
                const geom = f.getGeometry?.();
                if (!geom) return;
                const type = geom.getType?.();

                if (type === 'LineString') {
                    const coords = geom.getCoordinates();
                    const splitPieces = splitPolylineByCutLine(coords, pStart, pEnd);

                    if (splitPieces && splitPieces.length >= 2) {
                        const newFeatures = [];
                        splitPieces.forEach(pieceCoords => {
                            const newFeat = createSplitFeature(f, pieceCoords, map);
                            if (newFeat) newFeatures.push(newFeat);
                        });

                        if (newFeatures.length >= 2) {
                            modifications.push({
                                source: source,
                                origFeature: f,
                                newFeatures: newFeatures
                            });
                        }
                    }
                } else if (type === 'MultiLineString') {
                    const lines = geom.getCoordinates();
                    let anyLineCut = false;
                    const allResultingLines = [];

                    lines.forEach(lineCoords => {
                        const splitPieces = splitPolylineByCutLine(lineCoords, pStart, pEnd);
                        if (splitPieces && splitPieces.length >= 2) {
                            anyLineCut = true;
                            splitPieces.forEach(p => allResultingLines.push(p));
                        } else {
                            allResultingLines.push(lineCoords);
                        }
                    });

                    if (anyLineCut && allResultingLines.length > lines.length) {
                        const newFeatures = [];
                        allResultingLines.forEach(pieceCoords => {
                            const newFeat = createSplitFeature(f, pieceCoords, map);
                            if (newFeat) newFeatures.push(newFeat);
                        });

                        if (newFeatures.length >= 2) {
                            modifications.push({
                                source: source,
                                origFeature: f,
                                newFeatures: newFeatures
                            });
                        }
                    }
                }
            });
        });

        // Apply all modifications safely directly to OpenLayers sources & 3DG React State
        modifications.forEach(mod => {
            try {
                // 1. Remove original feature from OpenLayers map
                mod.source.removeFeature(mod.origFeature);

                // 2. Remove original feature from 3DG React State
                const origId = mod.origFeature.getId?.() || mod.origFeature.get?.('id') || mod.origFeature.id || mod.origFeature.id_ || mod.origFeature.get?.('_editId');
                if (origId && window.__topoRemoveFeatureFromReactState) {
                    try {
                        window.__topoRemoveFeatureFromReactState(origId);
                    } catch (e) { }
                }

                // 3. Add each split piece to OpenLayers map & sync to 3DG React State
                mod.newFeatures.forEach(nf => {
                    mod.source.addFeature(nf);
                    totalCreatedSegments++;

                    // Sync newly created segment into 3DG React State & list
                    if (window.__topoSyncFeatureToReactState) {
                        try {
                            window.__topoSyncFeatureToReactState(nf);
                        } catch (e) { }
                    }
                });
                totalCutFeatures++;

                if (typeof mod.source.changed === 'function') {
                    mod.source.changed();
                }
            } catch (e) {
                console.error('[CutLine] Error applying split feature changes:', e);
            }
        });

        if (totalCutFeatures > 0) {
            invalidateSourcesCache();
            try {
                window.dispatchEvent(new CustomEvent('topo:features-updated'));
            } catch (e) { }

            if (map && typeof map.render === 'function') {
                map.render();
            }

            log(`✂️ Successfully cut ${totalCutFeatures} stroke(s) into ${totalCreatedSegments} segments!`);

            // Update UI status
            const areaStatus = document.getElementById('topo-area-status');
            if (areaStatus) {
                areaStatus.innerHTML = `✂️ <b style="color:#16a34a">Đã cắt thành công ${totalCutFeatures} nét vẽ</b> thành <b>${totalCreatedSegments} đoạn</b>. Sẵn sàng cho lần cắt tiếp theo!`;
            }
        } else {
            const areaStatus = document.getElementById('topo-area-status');
            if (areaStatus) {
                areaStatus.textContent = '❌ Không có nét vẽ nào đi qua đường cắt vừa chọn. Vui lòng thử lại!';
            }
        }

        justFinishedTime = Date.now();
        activeCutPoints = [];
        lastClickInfo = { time: 0, pos: null };
        clearCanvas();

        const areaFinishBtn = document.getElementById('topo-btn-area-finish');
        if (areaFinishBtn) areaFinishBtn.disabled = true;

        return totalCutFeatures;
    }

    function finishCutting() {
        if (activeCutPoints.length < 1) return 0;

        let p1 = activeCutPoints[0];
        let p2 = activeCutPoints.length >= 2 ? activeCutPoints[1] : (lastSnapInfo?.coord || currentMouseCoord);

        if (!p1 || !p2 || distSq(p1, p2) < 1e-6) {
            activeCutPoints = [];
            clearCanvas();
            return 0;
        }

        return executeCutLine(p1, p2);
    }

    // ===== EVENT LISTENERS ATTACHED TO CANVAS (BLOCKS NATIVE 3DG CLICKS) =====
    function onCanvasPointerMove(e) {
        if (!isCutting) return;
        e.preventDefault();
        e.stopPropagation();

        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        if (!map) return;

        const rect = e.target.getBoundingClientRect();
        const px = [e.clientX - rect.left, e.clientY - rect.top];
        const rawCoord = map.getCoordinateFromPixel(px);
        if (!rawCoord) return;

        lastSnapInfo = getSnappedCoordinate(map, rawCoord, 22);
        currentMouseCoord = lastSnapInfo.coord;

        requestCanvasRender();
    }

    function onCanvasMouseDown(e) {
        if (!isCutting || e.button !== 0 || (Date.now() - justFinishedTime < 350)) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        mouseDownPos = { x: e.clientX, y: e.clientY, time: Date.now() };
    }

    function onCanvasMouseUp(e) {
        if (!isCutting || !mouseDownPos || e.button !== 0 || (Date.now() - justFinishedTime < 350)) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        const dx = e.clientX - mouseDownPos.x;
        const dy = e.clientY - mouseDownPos.y;
        const dist = Math.hypot(dx, dy);
        const duration = Date.now() - mouseDownPos.time;
        mouseDownPos = null;

        if (dist > 6 || duration > 400) return; // Ignore drag

        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        if (!map) return;

        const rect = e.target.getBoundingClientRect();
        const px = [e.clientX - rect.left, e.clientY - rect.top];
        const rawCoord = map.getCoordinateFromPixel(px);
        if (!rawCoord) return;

        const snap = getSnappedCoordinate(map, rawCoord, 22);
        const clickedCoord = snap.isSnapped ? snap.coord : rawCoord;

        const now = Date.now();
        const timeDiff = now - lastClickInfo.time;
        const clickDist = lastClickInfo.pos ? Math.hypot(e.clientX - lastClickInfo.pos.x, e.clientY - lastClickInfo.pos.y) : Infinity;

        if (activeCutPoints.length === 0) {
            // First click: Record Point 1
            activeCutPoints.push(clickedCoord);
            lastClickInfo = { time: now, pos: { x: e.clientX, y: e.clientY } };

            const areaStatus = document.getElementById('topo-area-status');
            if (areaStatus) {
                areaStatus.textContent = '✂️ Đã chọn điểm 1. Click chọn điểm 2 (hoặc nhấp đúp để cắt nét)...';
            }
            const areaFinishBtn = document.getElementById('topo-btn-area-finish');
            if (areaFinishBtn) {
                areaFinishBtn.style.display = 'inline-flex';
                areaFinishBtn.textContent = '✓ Hoàn Thành Cắt';
                areaFinishBtn.disabled = false;
            }
            requestCanvasRender();
        } else {
            // Point 1 already exists. Point 2 clicked!
            const p1 = activeCutPoints[0];
            const p2 = clickedCoord;

            if (distSq(p1, p2) < 1e-6) {
                // Clicked exactly on point 1, wait for 2nd point
                return;
            }

            activeCutPoints = [p1, p2];
            lastClickInfo = { time: now, pos: { x: e.clientX, y: e.clientY } };

            // Execute cut immediately
            finishCutting();
        }
    }

    function onCanvasDblClick(e) {
        if (!isCutting || (Date.now() - justFinishedTime < 350)) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        if (activeCutPoints.length >= 1) {
            log('⚡ Captured native dblclick on canvas overlay! Executing cut...');
            const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
            if (map) {
                const rect = e.target.getBoundingClientRect();
                const px = [e.clientX - rect.left, e.clientY - rect.top];
                const rawCoord = map.getCoordinateFromPixel(px);
                if (rawCoord) {
                    const snap = getSnappedCoordinate(map, rawCoord, 22);
                    activeCutPoints[1] = snap.isSnapped ? snap.coord : rawCoord;
                }
            }
            finishCutting();
        }
    }

    function onCanvasContextMenu(e) {
        if (!isCutting) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        if (activeCutPoints.length > 0) {
            activeCutPoints = [];
            lastClickInfo = { time: 0, pos: null };
            const areaStatus = document.getElementById('topo-area-status');
            if (areaStatus) {
                areaStatus.textContent = '✂️ Đã hủy điểm đầu. Click điểm mới để bắt đầu cắt nét...';
            }
            const areaFinishBtn = document.getElementById('topo-btn-area-finish');
            if (areaFinishBtn) areaFinishBtn.disabled = true;
            requestCanvasRender();
        }
    }

    function onKeyDown(e) {
        if (!isCutting) return;
        if (e.key === 'Enter') {
            e.preventDefault();
            if (activeCutPoints.length >= 1) {
                finishCutting();
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            if (activeCutPoints.length > 0) {
                activeCutPoints = [];
                lastClickInfo = { time: 0, pos: null };
                const areaStatus = document.getElementById('topo-area-status');
                if (areaStatus) {
                    areaStatus.textContent = '✂️ Đã hủy điểm đầu. Click điểm mới để bắt đầu cắt nét...';
                }
                const areaFinishBtn = document.getElementById('topo-btn-area-finish');
                if (areaFinishBtn) areaFinishBtn.disabled = true;
                requestCanvasRender();
            } else {
                stopCutLine();
                const cancelBtn = document.getElementById('topo-btn-area-cancel');
                if (cancelBtn) cancelBtn.click();
            }
        }
    }

    function attachEventListeners() {
        const canvas = getOrCreateCanvasOverlay();
        if (canvas) {
            canvas.style.pointerEvents = 'auto';
            canvas.style.cursor = 'crosshair';

            canvas.addEventListener('pointermove', onCanvasPointerMove, true);
            canvas.addEventListener('mousedown', onCanvasMouseDown, true);
            canvas.addEventListener('mouseup', onCanvasMouseUp, true);
            canvas.addEventListener('dblclick', onCanvasDblClick, true);
            canvas.addEventListener('contextmenu', onCanvasContextMenu, true);
        }
        window.addEventListener('keydown', onKeyDown, true);

        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        if (map) {
            try {
                map.on('postrender', requestCanvasRender);
                const view = map.getView();
                if (view && view.on) {
                    view.on('change:center', requestCanvasRender);
                    view.on('change:resolution', requestCanvasRender);
                }
            } catch (e) { }
        }
    }

    function detachEventListeners() {
        const canvas = document.getElementById('topo-cut-line-canvas');
        if (canvas) {
            canvas.removeEventListener('pointermove', onCanvasPointerMove, true);
            canvas.removeEventListener('mousedown', onCanvasMouseDown, true);
            canvas.removeEventListener('mouseup', onCanvasMouseUp, true);
            canvas.removeEventListener('dblclick', onCanvasDblClick, true);
            canvas.removeEventListener('contextmenu', onCanvasContextMenu, true);
            canvas.style.pointerEvents = 'none';
        }
        window.removeEventListener('keydown', onKeyDown, true);

        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        if (map) {
            try {
                map.un('postrender', requestCanvasRender);
                const view = map.getView();
                if (view && view.un) {
                    view.un('change:center', requestCanvasRender);
                    view.un('change:resolution', requestCanvasRender);
                }
            } catch (e) { }
        }
    }

    // ===== START / STOP CUT LINE TOOL =====
    function startCutLine() {
        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        if (!map) {
            alert('Không tìm thấy bản đồ 3DG OpenLayers!');
            return false;
        }

        disableNativeMapInteractions(map);
        ensureNative3dgSelectEditModeActive();

        isCutting = true;
        activeCutPoints = [];
        currentMouseCoord = null;
        lastSnapInfo = { coord: null, isSnapped: false };
        lastClickInfo = { time: 0, pos: null };
        invalidateSourcesCache();

        attachEventListeners();
        clearCanvas();

        log('Cut Line tool activated.');
        return true;
    }

    function stopCutLine() {
        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        if (map) {
            restoreNativeMapInteractions(map);
        }

        isCutting = false;
        activeCutPoints = [];
        currentMouseCoord = null;
        lastSnapInfo = { coord: null, isSnapped: false };
        lastClickInfo = { time: 0, pos: null };
        invalidateSourcesCache();

        detachEventListeners();
        clearCanvas();

        log('Cut Line tool stopped.');
    }

    // Global APIs
    window.__cutLineStart = startCutLine;
    window.__cutLineStop = stopCutLine;
    window.__cutLineCancel = stopCutLine;
    window.__cutLineFinish = finishCutting;
    window.__cutLineIsActive = () => isCutting;

})();
