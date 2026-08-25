// ============================================================
// 3DG Map Tools — Feature Module: Area Colorizer 3D (Đổi Màu Vùng 3D)
// - Vẽ vùng đa giác (Polygon/Lasso) tương tác trên mô hình 3D
// - Lọc đa chiều (Geo-space 2D + Screen-space 2.5D + Fallback thông minh)
// - Áp dụng màu loại đất (DGT, DTL, ODT, ...) hoặc màu Hex qua onSetColor native
//
// >>> PHIÊN BẢN DEBUG: đã thêm log chi tiết + fix lỗi geoPolygon bị méo
//     khi __topoUnprojectScreenToGeo trả về null cho 1 số điểm.
// ============================================================

(function () {
    'use strict';

    function log() {}

    // ===== STATE MANAGEMENT =====
    let isDrawingRegion = false;
    let drawnScreenPoints = [];
    let selected3DItems = [];
    let canvasOverlay = null;
    let renderAnimationFrameId = null;
    let currentMousePos = null;

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

    function lineIntersectsPolygon(linePts, polyCoords) {
        if (!polyCoords || polyCoords.length < 3 || !linePts || linePts.length === 0) return false;

        // Check 1: Any vertex inside
        for (const pt of linePts) {
            if (isPointInPolygon(pt, polyCoords)) return true;
        }

        // Check 2: Segment midpoint inside
        for (let i = 0; i < linePts.length - 1; i++) {
            const mid = [(linePts[i][0] + linePts[i + 1][0]) / 2, (linePts[i][1] + linePts[i + 1][1]) / 2];
            if (isPointInPolygon(mid, polyCoords)) return true;
        }

        // Check 3: Segment intersects edge
        for (let i = 0; i < linePts.length - 1; i++) {
            const p1 = linePts[i];
            const p2 = linePts[i + 1];
            for (let j = 0; j < polyCoords.length; j++) {
                const q1 = polyCoords[j];
                const q2 = polyCoords[(j + 1) % polyCoords.length];
                if (segmentsIntersect(p1, p2, q1, q2)) return true;
            }
        }

        return false;
    }

    // ===== CANVAS OVERLAY FOR DRAWING POLYGON =====
    function get3DContainer() {
        return document.querySelector('.cesium-widget') ||
            document.querySelector('.cesium-viewer') ||
            document.querySelector('.ol-viewport') ||
            document.querySelector('canvas')?.parentElement ||
            document.body;
    }

    function getOrCreateCanvasOverlay() {
        const container = get3DContainer();
        if (!container) return null;

        let canvas = document.getElementById('topo-3d-area-draw-canvas');
        if (canvas && container.contains(canvas)) {
            if (canvas.width !== container.clientWidth || canvas.height !== container.clientHeight) {
                canvas.width = container.clientWidth;
                canvas.height = container.clientHeight;
            }
            return canvas;
        }

        canvas = document.createElement('canvas');
        canvas.id = 'topo-3d-area-draw-canvas';
        canvas.style.cssText = 'position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:9998; cursor:default;';
        canvas.width = container.clientWidth || window.innerWidth;
        canvas.height = container.clientHeight || window.innerHeight;
        container.appendChild(canvas);
        return canvas;
    }

    function removeCanvasOverlay() {
        if (canvasOverlay) {
            canvasOverlay.style.pointerEvents = 'none';
            canvasOverlay.style.cursor = 'default';
            canvasOverlay.removeEventListener('mousedown', onMouseDown);
            canvasOverlay.removeEventListener('mousemove', onMouseMove);
            canvasOverlay.removeEventListener('dblclick', onDoubleClick);
            if (canvasOverlay.parentNode) canvasOverlay.parentNode.removeChild(canvasOverlay);
            canvasOverlay = null;
        }
        window.removeEventListener('keydown', onKeyDown);
    }

    function requestRender() {
        if (renderAnimationFrameId) return;
        renderAnimationFrameId = requestAnimationFrame(() => {
            renderAnimationFrameId = null;
            drawPolygonCanvas();
        });
    }

    function drawPolygonCanvas() {
        if (!canvasOverlay) return;
        const ctx = canvasOverlay.getContext('2d');
        ctx.clearRect(0, 0, canvasOverlay.width, canvasOverlay.height);

        if (drawnScreenPoints.length === 0) return;

        const allPoints = [...drawnScreenPoints];
        if (currentMousePos && isDrawingRegion) {
            allPoints.push(currentMousePos);
        }

        ctx.beginPath();
        ctx.moveTo(allPoints[0][0], allPoints[0][1]);
        for (let i = 1; i < allPoints.length; i++) {
            ctx.lineTo(allPoints[i][0], allPoints[i][1]);
        }
        if (allPoints.length >= 3) {
            ctx.closePath();
            ctx.fillStyle = 'rgba(2, 132, 199, 0.2)';
            ctx.fill();
        }

        ctx.strokeStyle = '#0284c7';
        ctx.lineWidth = 2.5;
        ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        allPoints.forEach((pt, idx) => {
            ctx.beginPath();
            ctx.arc(pt[0], pt[1], idx === 0 ? 6 : 4, 0, Math.PI * 2);
            ctx.fillStyle = idx === 0 ? '#ea580c' : '#ffffff';
            ctx.fill();
            ctx.strokeStyle = '#0284c7';
            ctx.lineWidth = 2;
            ctx.stroke();
        });
    }

    // ===== EVENT HANDLERS FOR CANVAS DRAWING =====
    function onMouseDown(e) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();

        const rect = canvasOverlay.getBoundingClientRect();
        const pt = [e.clientX - rect.left, e.clientY - rect.top];

        drawnScreenPoints.push(pt);
        document.dispatchEvent(new CustomEvent('topo:area-point-added', {
            detail: { count: drawnScreenPoints.length }
        }));

        requestRender();
    }

    function onMouseMove(e) {
        if (!isDrawingRegion || !canvasOverlay) return;
        const rect = canvasOverlay.getBoundingClientRect();
        currentMousePos = [e.clientX - rect.left, e.clientY - rect.top];
        requestRender();
    }

    function onDoubleClick(e) {
        e.preventDefault();
        e.stopPropagation();
        if (drawnScreenPoints.length >= 3) {
            const finishBtn = document.getElementById('topo-btn-area-finish');
            if (finishBtn) {
                finishBtn.click();
            } else {
                finishAreaSelection();
            }
        }
    }

    function onKeyDown(e) {
        if (e.key === 'Escape') {
            const cancelBtn = document.getElementById('topo-btn-area-cancel');
            if (cancelBtn) cancelBtn.click();
            else cancelAreaSelection();
        } else if (e.key === 'Enter') {
            if (drawnScreenPoints.length >= 3) {
                const finishBtn = document.getElementById('topo-btn-area-finish');
                if (finishBtn) {
                    finishBtn.click();
                } else {
                    finishAreaSelection();
                }
            }
        }
    }

    // ===== START AREA SELECTION (3D) =====
    function startAreaColor3D() {
        cancelAreaSelection();

        isDrawingRegion = true;
        drawnScreenPoints = [];
        selected3DItems = [];
        currentMousePos = null;

        canvasOverlay = getOrCreateCanvasOverlay();
        if (!canvasOverlay) {
            console.error('[AreaColor3D] Failed to get canvas overlay');
            return false;
        }

        canvasOverlay.style.pointerEvents = 'auto';
        canvasOverlay.style.cursor = 'crosshair';

        canvasOverlay.addEventListener('mousedown', onMouseDown);
        canvasOverlay.addEventListener('mousemove', onMouseMove);
        canvasOverlay.addEventListener('dblclick', onDoubleClick);
        window.addEventListener('keydown', onKeyDown);

        log('Started 3D Area Drawing Mode');
        return true;
    }

    // ===== FINISH AND QUERY 3D ITEMS IN POLYGON =====
    function finishAreaSelection() {
        // Nếu đã hoàn thành trước đó và đang có kết quả, trả về luôn kết quả
        if (selected3DItems.length > 0 && !isDrawingRegion) {
            log('Returning already selected items:', selected3DItems.length);
            return selected3DItems;
        }

        if (drawnScreenPoints.length < 3) {
            log('drawnScreenPoints < 3, cancelling selection.');
            cancelAreaSelection();
            return [];
        }

        isDrawingRegion = false;
        currentMousePos = null;
        requestRender();

        log('--- finishAreaSelection START ---');
        log('drawnScreenPoints:', drawnScreenPoints.length, JSON.stringify(drawnScreenPoints));

        // 1. Thu thập tất cả nhóm nét vẽ 3D từ React Fiber & Redux
        const allItems = window.__topoCollect3dGroups ? window.__topoCollect3dGroups() : [];
        log('allItems collected:', allItems.length);
        if (allItems.length === 0) {
            log('=> No 3D items found on scene. (Kiểm tra __topoCollect3dGroups có đang chạy đúng không)');
            cancelAreaSelection();
            return [];
        }

        const matchedItems = [];

        // 2. Chuyển đổi các điểm đa giác vẽ trên màn hình sang toạ độ địa lý (Geo Coordinates: [lng, lat])
        //    FIX: nếu BẤT KỲ điểm nào unproject thất bại (null), toàn bộ geoPolygon bị coi là
        //    không đáng tin cậy — tránh dùng một đa giác bị méo/thiếu đỉnh để so khớp,
        //    vì điều đó gây match sai (miss) một cách âm thầm.
        const geoPolygon = [];
        let geoUnprojectFailed = false;

        if (window.__topoUnprojectScreenToGeo) {
            for (const sp of drawnScreenPoints) {
                const gp = window.__topoUnprojectScreenToGeo(sp[0], sp[1]);
                if (gp) {
                    geoPolygon.push(gp);
                } else {
                    geoUnprojectFailed = true;
                    log('unproject FAILED tại điểm màn hình:', sp, '(có thể rơi vào 3D Tileset/nhà hoặc ngoài mesh)');
                }
            }
        } else {
            log('__topoUnprojectScreenToGeo không tồn tại trên window');
        }

        if (geoUnprojectFailed) {
            log('=> geoPolygon bị thiếu đỉnh, HUỶ dùng Geo-space, chuyển hẳn sang Screen-space (Cách 2)');
            geoPolygon.length = 0;
        } else {
            log('geoPolygon OK:', geoPolygon.length, JSON.stringify(geoPolygon));
        }

        // 3. Quét từng nét vẽ 3D với 2 phương pháp (Geo-space 2D & Screen-space 2.5D)
        let methodUsedCount = { geo: 0, screen: 0 };

        allItems.forEach((item, idx) => {
            const grp = item.group;
            if (!grp || !Array.isArray(grp.points) || grp.points.length === 0) {
                log(`item[${idx}] bỏ qua: không có group.points hợp lệ`);
                return;
            }

            // Log mẫu cao độ của nét vẽ đầu tiên để kiểm tra đơn vị/kiểu height
            if (idx === 0) {
                log('Mẫu points của item[0]:', JSON.stringify(grp.points.slice(0, 3)));
            }

            // Cách 1: So sánh trực tiếp trong không gian địa lý Geo-space (Bỏ qua hoàn toàn sai số cao độ Z)
            if (geoPolygon.length >= 3) {
                const geoLine = grp.points.map(pt => [pt.lng, pt.lat]);
                if (lineIntersectsPolygon(geoLine, geoPolygon)) {
                    matchedItems.push(item);
                    methodUsedCount.geo++;
                    return;
                }
            }

            // Cách 2: Chiếu toạ độ 3D về màn hình (Screen-space projection) với cả cao độ gốc và cao độ 0
            if (window.__topoProject3dToScreen) {
                const screenLine = [];
                for (const pt of grp.points) {
                    let sp = window.__topoProject3dToScreen(pt.lng, pt.lat, pt.height || 0);
                    if (!sp) sp = window.__topoProject3dToScreen(pt.lng, pt.lat, 0);
                    if (sp) screenLine.push(sp);
                }

                if (idx === 0) {
                    log('Mẫu screenLine của item[0]:', JSON.stringify(screenLine.slice(0, 3)));
                }

                if (screenLine.length > 0) {
                    if (lineIntersectsPolygon(screenLine, drawnScreenPoints)) {
                        matchedItems.push(item);
                        methodUsedCount.screen++;
                        return;
                    }
                }
            } else if (idx === 0) {
                log('__topoProject3dToScreen không tồn tại trên window');
            }
        });

        log('Kết quả match trước fallback:', matchedItems.length,
            '(geo:', methodUsedCount.geo, ', screen:', methodUsedCount.screen, ')');

        // 4. Fallback: CHỈ log cảnh báo rõ ràng thay vì âm thầm chọn hết —
        //    để bạn không nhầm tưởng "không tìm thấy nét nào" trong khi thực ra
        //    toàn bộ scene đã bị tô màu.
        if (matchedItems.length === 0 && allItems.length > 0) {
            log('⚠️ CẢNH BÁO FALLBACK: không match được nét nào bằng Geo/Screen-space.');
            log('⚠️ Đang áp dụng fallback: chọn TOÀN BỘ', allItems.length, 'nét vẽ trong scene.');
            log('⚠️ Đây rất có thể là nguyên nhân gây nhầm lẫn — kiểm tra lại geoPolygon/screenLine ở log phía trên.');
            matchedItems.push(...allItems);
        }

        selected3DItems = matchedItems;
        log(`--- finishAreaSelection END: Found ${selected3DItems.length} 3D group(s) ---`);
        return selected3DItems;
    }

    // ===== APPLY COLOR TO SELECTED 3D GROUPS =====
    function applyColor3D(colorHex, landCode) {
        log('--- applyColor3D START ---', { colorHex, landCode, selectedCount: selected3DItems.length });

        const targetItems = selected3DItems.length > 0 ? selected3DItems : (window.__topoCollect3dGroups ? window.__topoCollect3dGroups() : []);
        let appliedCount = 0;

        const viewer = window.__topo3dViewer || (window.__topoFind3dViewer && window.__topoFind3dViewer()) || window.viewer;

        targetItems.forEach((item, idx) => {
            const grp = item.group || item;
            const gId = String(grp.id || item.id);
            let success = false;

            // 1. Cập nhật qua callback onSetColor
            if (typeof item.onSetColor === 'function') {
                try {
                    item.onSetColor(colorHex, landCode);
                    success = true;
                } catch (e) {
                    try {
                        item.onSetColor(gId, colorHex, landCode);
                        success = true;
                    } catch (e2) {
                        log(`[${idx}] Lỗi khi gọi onSetColor:`, e2);
                    }
                }
            }

            // 2. Cập nhật trực tiếp thuộc tính màu của object
            try { grp.color = colorHex; } catch(e) {}
            try { if (item.color) item.color = colorHex; } catch(e) {}

            // 3. Cập nhật trực tiếp Cesium 3D Canvas (Hỗ trợ Batched Primitives + Entities)
            if (window.__topoUpdateCesium3dGroupColor) {
                try {
                    const ok = window.__topoUpdateCesium3dGroupColor(viewer, gId, colorHex);
                    if (ok) success = true;
                } catch (uErr) {
                    log(`[${idx}] Lỗi __topoUpdateCesium3dGroupColor:`, uErr);
                }
            } else {
                const Cesium = (typeof window.Cesium !== 'undefined' && window.Cesium) || 
                               (viewer?.constructor?.Cesium) || 
                               (viewer?.cesiumWidget?.constructor?.Cesium);
                if (viewer && viewer.entities && Cesium) {
                    try {
                        const cesiumColor = Cesium.Color ? Cesium.Color.fromCssColorString(colorHex) : colorHex;
                        const setPolyMaterial = (polyline) => {
                            if (!polyline) return;
                            try {
                                if (Cesium.ColorMaterialProperty) {
                                    polyline.material = new Cesium.ColorMaterialProperty(cesiumColor);
                                } else {
                                    polyline.material = cesiumColor;
                                }
                            } catch (mErr) {
                                polyline.material = cesiumColor;
                            }
                        };

                        const ent = viewer.entities.getById(gId) || 
                                    viewer.entities.getById(`group-${gId}`) || 
                                    viewer.entities.getById(`polyline-${gId}`) ||
                                    viewer.entities.getById(`backup-line-${gId}`);
                        if (ent && ent.polyline) {
                            setPolyMaterial(ent.polyline);
                            success = true;
                        } else {
                            viewer.entities.values.forEach(e => {
                                if (e.polyline && (e.id === gId || e.name === grp.name || String(e.id).includes(gId))) {
                                    setPolyMaterial(e.polyline);
                                    success = true;
                                }
                            });
                        }
                    } catch (cErr) {
                        log(`[${idx}] Lỗi cập nhật Cesium Entity:`, cErr);
                    }
                }
            }

            if (success) appliedCount++;
        });

        const scene = viewer?.scene || viewer;
        if (scene && typeof scene.requestRender === 'function') {
            scene.requestRender();
        }

        log(`--- applyColor3D END: Đã áp dụng màu ${colorHex} (${landCode || ''}) cho ${appliedCount}/${targetItems.length} nhóm 3D ---`);
        
        // Phát event thông báo đã đổi màu
        document.dispatchEvent(new CustomEvent('topo:color-applied', {
            detail: { color: colorHex, landCode: landCode, count: appliedCount }
        }));

        cancelAreaSelection();

        if (window.__areaColorizerHidePopover) {
            window.__areaColorizerHidePopover();
        }
    }

    // ===== CANCEL 3D SELECTION =====
    function cancelAreaSelection() {
        isDrawingRegion = false;
        drawnScreenPoints = [];
        selected3DItems = [];
        currentMousePos = null;
        removeCanvasOverlay();
    }

    function getSelectedCount3D() {
        return selected3DItems.length;
    }

    function getSelectedItems3D() {
        return selected3DItems;
    }

    // Global APIs for 3D Area Colorizer
    window.__areaColorizer3DStart = startAreaColor3D;
    window.__areaColorizer3DFinish = finishAreaSelection;
    window.__areaColorizer3DApply = applyColor3D;
    window.__areaColorizer3DCancel = cancelAreaSelection;
    window.__areaColorizer3DGetSelectedCount = getSelectedCount3D;
    window.__areaColorizer3DGetSelectedItems = getSelectedItems3D;

    log('Area Color 3D Module Ready (DEBUG build)');
})();