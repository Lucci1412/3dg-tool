// ============================================================
// 3DG Topology Checker — Feature Module: Check Topo 3D
// - Phát hiện lỗi chưa khép thửa / đầu mút hở (Dangle), trùng nét (Duplicate)
//   trên không gian 3D Mesh với Spatial Grid Index
// - Tự động xóa các đỉnh trùng lặp liên tiếp trên cùng 1 nét vẽ thành 1 (Metric Deduplication <= 5cm)
// - Hỗ trợ đầy đủ: Điểm nối Điểm (Vertex Snap) & Điểm nối Cạnh (T-Junction Segment Snap)
// - Bỏ qua sai số cao độ Z địa hình, tính toán chuẩn metric EPSG/Equirectangular
// ============================================================

(function () {
    'use strict';

    function log(...args) {
        // console.log('[CheckTopo3D]', ...args);
    }

    // ===== SPATIAL UTILITIES & METRIC PROJECTION =====
    function createProjector(centerLat) {
        const rad = Math.PI / 180;
        const R = 6378137;
        const cosLat = Math.cos((centerLat || 0) * rad);
        return {
            toMeters: (pt) => [
                pt.lng * rad * cosLat * R,
                pt.lat * rad * R,
                pt.height || 0
            ],
            toGeo: (m) => [
                (m[0] / (cosLat * R)) / rad,
                (m[1] / R) / rad,
                m[2] || 0
            ]
        };
    }

    function distSq2D(m1, m2) {
        const dx = m1[0] - m2[0];
        const dy = m1[1] - m2[1];
        return dx * dx + dy * dy;
    }

    function pointToSegmentDistSq2D(p, a, b) {
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const lenSq = dx * dx + dy * dy;
        if (lenSq < 1e-12) return distSq2D(p, a);

        let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));

        const projX = a[0] + t * dx;
        const projY = a[1] + t * dy;
        return (p[0] - projX) ** 2 + (p[1] - projY) ** 2;
    }

    // ===== SPATIAL GRID INDEX (2.5D) =====
    class SpatialGrid {
        constructor(cellSize) {
            this.cellSize = Math.max(cellSize, 1e-6);
            this.cells = new Map();
        }

        _cellCoord(x, y) {
            return [Math.floor(x / this.cellSize), Math.floor(y / this.cellSize)];
        }

        _key(cx, cy) {
            return cx + '_' + cy;
        }

        _addToCell(k, item) {
            let arr = this.cells.get(k);
            if (!arr) { arr = []; this.cells.set(k, arr); }
            arr.push(item);
        }

        insertPoint(x, y, item) {
            const [cx, cy] = this._cellCoord(x, y);
            this._addToCell(this._key(cx, cy), item);
        }

        insertSegment(p1, p2, tolerance, item) {
            const minX = Math.min(p1[0], p2[0]) - tolerance;
            const maxX = Math.max(p1[0], p2[0]) + tolerance;
            const minY = Math.min(p1[1], p2[1]) - tolerance;
            const maxY = Math.max(p1[1], p2[1]) + tolerance;

            const [cx0, cy0] = this._cellCoord(minX, minY);
            const [cx1, cy1] = this._cellCoord(maxX, maxY);
            for (let cx = cx0; cx <= cx1; cx++) {
                for (let cy = cy0; cy <= cy1; cy++) {
                    this._addToCell(this._key(cx, cy), item);
                }
            }
        }

        queryPoint(x, y) {
            const [cx, cy] = this._cellCoord(x, y);
            const out = [];
            const seen = new Set();
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    const arr = this.cells.get(this._key(cx + dx, cy + dy));
                    if (arr) {
                        for (const it of arr) {
                            if (!seen.has(it)) { seen.add(it); out.push(it); }
                        }
                    }
                }
            }
            return out;
        }
    }

    // ===== MAIN 3D TOPOLOGY SCANNER =====
    async function runCheck3D(options = {}) {
        const tolerance = options.tolerance !== undefined ? Number(options.tolerance) : 0.5; // mét
        const tolSq = tolerance * tolerance;
        const onProgress = typeof options.onProgress === 'function' ? options.onProgress : (() => {});

        onProgress(5, 'Đang quét danh sách nét vẽ 3D...');

        // 1. Thu thập tất cả các nhóm 3D từ React Fiber & Cesium
        const rawItems = window.__topoCollect3dGroups ? window.__topoCollect3dGroups() : [];
        if (!rawItems || rawItems.length === 0) {
            onProgress(100, 'Không tìm thấy nét vẽ nào trên mô hình 3D.');
            return [];
        }

        // Tính tâm latitude để chiếu phẳng chuẩn mét (Local Equirectangular Projection)
        let sumLat = 0, ptCount = 0;
        rawItems.forEach(it => {
            if (it.group?.points) {
                it.group.points.forEach(p => {
                    sumLat += p.lat;
                    ptCount++;
                });
            }
        });
        const centerLat = ptCount > 0 ? (sumLat / ptCount) : 0;
        const proj = createProjector(centerLat);

        // 2. TỰ ĐỘNG XÓA ĐIỂM TRÙNG LẶP LIÊN TIẾP TRÊN CÙNG 1 NÉT VẼ (Deduplicate <= 5cm)
        onProgress(15, `Đang làm sạch các đỉnh trùng lặp trên ${rawItems.length} nét vẽ 3D...`);
        let totalPointsCleaned = 0;
        let cleanedGroupsCount = 0;

        rawItems.forEach(item => {
            const grp = item.group;
            if (grp && Array.isArray(grp.points) && grp.points.length > 1) {
                const cleaned = [grp.points[0]];
                let prevM = proj.toMeters(grp.points[0]);
                let removed = 0;

                for (let i = 1; i < grp.points.length; i++) {
                    const curr = grp.points[i];
                    const currM = proj.toMeters(curr);
                    // Nếu khoảng cách <= 5cm -> Xóa điểm trùng
                    if (distSq2D(prevM, currM) <= 0.0025) {
                        removed++;
                    } else {
                        cleaned.push(curr);
                        prevM = currM;
                    }
                }

                if (removed > 0) {
                    grp.points = cleaned;
                    totalPointsCleaned += removed;
                    cleanedGroupsCount++;
                }
            }
        });

        if (totalPointsCleaned > 0) {
            log(`[CheckTopo3D] Đã tự động loại bỏ ${totalPointsCleaned} điểm trùng lặp liên tiếp trên ${cleanedGroupsCount} nét vẽ 3D!`);
        }

        // Lọc các nét vẽ hợp lệ sau khi làm sạch
        const strokeItems = rawItems.filter(it => it.group && Array.isArray(it.group.points) && it.group.points.length > 0);
        if (strokeItems.length === 0) {
            onProgress(100, 'Không có nét vẽ hợp lệ để kiểm tra.');
            return [];
        }

        onProgress(30, `Đã tìm thấy ${strokeItems.length} nhóm nét vẽ 3D. Đang phân tích hình học...`);

        const allVertices = [];
        const allSegments = [];
        const errors = [];
        let errorIndex = 1;

        // Trích xuất đỉnh & đoạn thẳng sang toạ độ mét phẳng
        strokeItems.forEach(item => {
            const grp = item.group;
            const pts = grp.points;
            if (pts.length < 2) {
                errors.push({
                    id: `topo-3d-deg-${grp.id}`,
                    type: 'dangle',
                    title: `Nét suy biến — ${grp.name || grp.id}`,
                    desc: `Nét vẽ chỉ có ${pts.length} điểm, không đủ tạo thành đường.`,
                    coord: pts.length > 0 ? [pts[0].lng, pts[0].lat, pts[0].height || 0] : [0, 0, 0],
                    group: grp,
                    item: item,
                    rawError: { group: grp }
                });
                return;
            }

            const mPoints = pts.map(p => proj.toMeters(p));

            pts.forEach((pt, ptIdx) => {
                allVertices.push({
                    point: pt,
                    mPoint: mPoints[ptIdx],
                    group: grp,
                    groupId: grp.id,
                    item: item,
                    pointIndex: ptIdx,
                    isEndpoint: (ptIdx === 0 || ptIdx === pts.length - 1)
                });
            });

            for (let i = 0; i < pts.length - 1; i++) {
                const segLenSq = distSq2D(mPoints[i], mPoints[i + 1]);
                if (segLenSq < 0.0025) continue; // Bỏ qua đoạn vi mô < 5cm

                allSegments.push({
                    p1: pts[i],
                    p2: pts[i + 1],
                    mP1: mPoints[i],
                    mP2: mPoints[i + 1],
                    length: Math.sqrt(segLenSq),
                    group: grp,
                    groupId: grp.id,
                    item: item,
                    segIndex: i
                });
            }
        });

        // 3. Dựng lưới không gian Spatial Grid
        const gridCellSize = Math.max(tolerance * 2, 5.0);
        const vertexGrid = new SpatialGrid(gridCellSize);
        const segmentGrid = new SpatialGrid(gridCellSize);

        allVertices.forEach(v => {
            vertexGrid.insertPoint(v.mPoint[0], v.mPoint[1], v);
        });

        allSegments.forEach(s => {
            segmentGrid.insertSegment(s.mP1, s.mP2, tolerance, s);
        });

        onProgress(55, 'Đang kiểm tra lỗi chưa khép thửa (Điểm nối Đỉnh & Điểm tựa Cạnh T-Junction)...');

        const seenErrorCoords = new Set();
        function addError(errorObj) {
            const key = `${Math.round(errorObj.coord[0] * 1e5)}_${Math.round(errorObj.coord[1] * 1e5)}_${errorObj.type}`;
            if (seenErrorCoords.has(key)) return;
            seenErrorCoords.add(key);
            errors.push(errorObj);
        }

        // 4. Kiểm tra ĐẦU MÚT HỞ / CHƯA KHÉP THỬA (Dangles)
        strokeItems.forEach(item => {
            const grp = item.group;
            const pts = grp.points;
            if (pts.length < 2) return;

            const mPoints = pts.map(p => proj.toMeters(p));
            const isSelfClosed = distSq2D(mPoints[0], mPoints[mPoints.length - 1]) <= tolSq;

            // Nếu nét đã tự khép vòng tròn (Closed Loop) -> Không cần kiểm tra 2 đầu
            if (isSelfClosed && grp.connectMode !== 'polygon') {
                return;
            }

            if (grp.connectMode === 'polygon' && !isSelfClosed) {
                const endPt = pts[pts.length - 1];
                const d = Math.sqrt(distSq2D(mPoints[0], mPoints[mPoints.length - 1]));
                addError({
                    id: `topo-3d-unclosed-${grp.id}`,
                    type: 'dangle',
                    title: `Chưa khép thửa #${errorIndex++} — ${grp.name || grp.id}`,
                    desc: `Vùng đa giác chưa nối liền điểm đầu và điểm cuối (cách nhau ${d.toFixed(2)}m).`,
                    coord: [endPt.lng, endPt.lat, endPt.height || 0],
                    group: grp,
                    point: endPt,
                    item: item,
                    rawError: { group: grp }
                });
                return;
            }

            // Kiểm tra điểm đầu pts[0] và điểm cuối pts[pts.length - 1]
            const endpoints = [
                { pt: pts[0], mPt: mPoints[0], ptIdx: 0, posLabel: 'Điểm đầu' },
                { pt: pts[pts.length - 1], mPt: mPoints[mPoints.length - 1], ptIdx: pts.length - 1, posLabel: 'Điểm cuối' }
            ];

            endpoints.forEach(({ pt, mPt, ptIdx, posLabel }) => {
                let isConnected = false;

                // Cách 1: Kiểm tra nối với ĐỈNH (Vertex) khác
                const nearVerts = vertexGrid.queryPoint(mPt[0], mPt[1]);
                for (const other of nearVerts) {
                    if (other.groupId === grp.id) {
                        // Cùng nét: chỉ tính nếu nối với đầu mút đối diện (khép vòng)
                        if (other.isEndpoint && other.pointIndex !== ptIdx) {
                            if (distSq2D(mPt, other.mPoint) <= tolSq) {
                                isConnected = true;
                                break;
                            }
                        }
                        continue;
                    }

                    // Khác nét: nối với bất kỳ đỉnh nào trong phạm vi tolerance
                    if (distSq2D(mPt, other.mPoint) <= tolSq) {
                        isConnected = true;
                        break;
                    }
                }

                // Cách 2: Kiểm tra tựa trên CẠNH (T-Junction Segment Snap)
                // (Khi nét vẽ kết thúc ở điểm nằm giữa một cạnh của thửa đất khác)
                if (!isConnected) {
                    const nearSegs = segmentGrid.queryPoint(mPt[0], mPt[1]);
                    for (const seg of nearSegs) {
                        if (seg.groupId === grp.id) {
                            // Cùng nét: bỏ qua các đoạn kề trực tiếp với đầu mút này
                            if (ptIdx === 0 && seg.segIndex === 0) continue;
                            if (ptIdx === pts.length - 1 && seg.segIndex === pts.length - 2) continue;
                        }

                        if (pointToSegmentDistSq2D(mPt, seg.mP1, seg.mP2) <= tolSq) {
                            isConnected = true;
                            break;
                        }
                    }
                }

                if (!isConnected) {
                    const hText = pt.height != null ? ` (Cao độ: ${pt.height.toFixed(2)}m)` : '';
                    addError({
                        id: `topo-3d-dangle-${grp.id}-${ptIdx}`,
                        type: 'dangle',
                        title: `Chưa khép thửa #${errorIndex++} — ${grp.name || grp.id}`,
                        desc: `${posLabel} (${pt.lng.toFixed(6)}, ${pt.lat.toFixed(6)})${hText} chưa nối vào nét nào.`,
                        coord: [pt.lng, pt.lat, pt.height || 0],
                        group: grp,
                        point: pt,
                        item: item,
                        rawError: { group: grp, point: pt }
                    });
                }
            });
        });

        onProgress(80, 'Đang kiểm tra trùng nét (Duplicate Segments)...');

        // 5. Kiểm tra TRÙNG NÉT (Duplicate Segments) giữa các nét khác nhau
        const seenSegmentPairs = new Set();
        allSegments.forEach(s1 => {
            const nearSegs = segmentGrid.queryPoint(s1.mP1[0], s1.mP1[1]);
            for (const s2 of nearSegs) {
                // Cùng 1 nhóm: chỉ xét nếu không phải 2 đoạn kề nhau (tránh đỉnh chung)
                if (s1.groupId === s2.groupId) {
                    if (Math.abs(s1.segIndex - s2.segIndex) <= 1) continue;
                    // Bỏ qua đoạn đầu và đoạn cuối của vòng khép kín
                    const grpPtsCount = s1.group.points.length;
                    if (Math.min(s1.segIndex, s2.segIndex) === 0 && Math.max(s1.segIndex, s2.segIndex) === grpPtsCount - 2) continue;
                }

                const pairKey = s1.groupId < s2.groupId
                    ? `${s1.groupId}_${s1.segIndex}_${s2.groupId}_${s2.segIndex}`
                    : (s1.groupId > s2.groupId
                        ? `${s2.groupId}_${s2.segIndex}_${s1.groupId}_${s1.segIndex}`
                        : `${s1.groupId}_${Math.min(s1.segIndex, s2.segIndex)}_${Math.max(s1.segIndex, s2.segIndex)}`);

                if (seenSegmentPairs.has(pairKey)) continue;

                // Kiểm tra cùng chiều hoặc ngược chiều
                const d11 = distSq2D(s1.mP1, s2.mP1);
                const d22 = distSq2D(s1.mP2, s2.mP2);
                const d12 = distSq2D(s1.mP1, s2.mP2);
                const d21 = distSq2D(s1.mP2, s2.mP1);

                const isSameDir = d11 <= tolSq && d22 <= tolSq;
                const isOppositeDir = d12 <= tolSq && d21 <= tolSq;

                if (isSameDir || isOppositeDir) {
                    seenSegmentPairs.add(pairKey);
                    const midLng = (s1.p1.lng + s1.p2.lng) / 2;
                    const midLat = (s1.p1.lat + s1.p2.lat) / 2;
                    const midH = ((s1.p1.height || 0) + (s1.p2.height || 0)) / 2;

                    const otherName = (s1.groupId === s2.groupId)
                        ? `đoạn khác trong cùng nhóm`
                        : `"${s2.group.name || s2.groupId}"`;

                    addError({
                        id: `topo-3d-dup-${pairKey}`,
                        type: 'duplicate',
                        title: `Trùng nét #${errorIndex++} — ${s1.group.name || s1.groupId}`,
                        desc: `Đoạn thẳng trùng lặp với ${otherName}.`,
                        coord: [midLng, midLat, midH],
                        segment: [s1.p1, s1.p2],
                        group: s1.group,
                        item: s1.item,
                        rawError: { group1: s1.group, group2: s2.group }
                    });
                }
            }
        });

        onProgress(100, `Hoàn thành quét 3D: Tìm thấy ${errors.length} lỗi.`);
        log(`3D Topo Check Completed: found ${errors.length} errors.`);
        return errors;
    }

    function clearCheck3D() {
        log('Clearing Check Topo 3D');
    }

    // ===== ZOOM TO ERROR IN 3D =====
    function zoomToError3D(err) {
        if (!err) return;
        log('Zooming to 3D Error:', err);

        // 1. Thử gọi callback onZoom trực tiếp từ component React Fiber
        if (err.item && typeof err.item.onZoom === 'function') {
            try {
                err.item.onZoom();
            } catch (e) {
                log('onZoom callback error:', e);
            }
        }

        // 2. Thử gọi onSelect để làm nổi bật item trên 3DG
        if (err.item && typeof err.item.onSelect === 'function') {
            try {
                err.item.onSelect();
            } catch (e) {}
        }

        // 3. Điều khiển camera 3D trực tiếp tới toạ độ lỗi
        if (err.coord && Array.isArray(err.coord) && err.coord.length >= 2) {
            const [lng, lat, height] = err.coord;
            if (window.__topoFlyTo3DCoord) {
                window.__topoFlyTo3DCoord(lng, lat, height);
            }
        }
    }

    // Global APIs for 3D Topo
    window.__topoRunCheck3D = runCheck3D;
    window.__topoClearCheck3D = clearCheck3D;
    window.__topoZoomToError3D = zoomToError3D;

    log('Check Topo 3D Module Ready (Sanitize Duplicates & Accurate Topo)');
})();
