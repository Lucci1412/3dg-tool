// ============================================================
// 3DG Topology Checker — Feature Module: Check Topo 3D
// - Phát hiện lỗi đầu mút hở (Dangle), trùng nét (Duplicate),
//   chưa khép kín thửa đất trên không gian 3D Mesh
// - Tương thích hoàn toàn với cấu trúc 3D Group/Points của 3DG
// ============================================================

(function () {
    'use strict';

    function log(...args) {
        // console.log('[CheckTopo3D]', ...args);
    }

    // ===== PROJECT COORDINATES TO METERS (EPSG:3857) =====
    function toMercator(lng, lat) {
        const x = (lng * 20037508.34) / 180;
        let y = Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180);
        y = (y * 20037508.34) / 180;
        return [x, y];
    }

    function distMeters(p1, p2, useHeight = false) {
        const m1 = toMercator(p1.lng, p1.lat);
        const m2 = toMercator(p2.lng, p2.lat);
        const dx = m1[0] - m2[0];
        const dy = m1[1] - m2[1];
        if (useHeight && typeof p1.height === 'number' && typeof p2.height === 'number') {
            const dz = p1.height - p2.height;
            return Math.sqrt(dx * dx + dy * dy + dz * dz);
        }
        return Math.sqrt(dx * dx + dy * dy);
    }

    // ===== MAIN 3D TOPOLOGY SCANNER =====
    async function runCheck3D(options = {}) {
        const tolerance = options.tolerance || 0.5; // mét
        const onProgress = options.onProgress || (() => {});

        onProgress(10, 'Đang quét danh sách nét vẽ 3D...');

        // 1. Thu thập tất cả các nhóm 3D từ React Fiber
        const rawItems = window.__topoCollect3dGroups ? window.__topoCollect3dGroups() : [];
        if (!rawItems || rawItems.length === 0) {
            onProgress(100, 'Không tìm thấy nét vẽ nào trên mô hình 3D.');
            return [];
        }

        onProgress(30, `Đã tìm thấy ${rawItems.length} nhóm nét vẽ 3D. Đang phân tích đỉnh...`);

        const errors = [];
        let errorIndex = 1;

        // Chuẩn hóa danh sách các đường
        const strokeItems = rawItems.filter(it => it.group && Array.isArray(it.group.points) && it.group.points.length > 0);

        // Tập hợp tất cả các đỉnh (all vertices) để kiểm tra kết nối đầu mút
        const allPoints = [];
        strokeItems.forEach(item => {
            const grp = item.group;
            grp.points.forEach((pt, ptIdx) => {
                allPoints.push({
                    point: pt,
                    group: grp,
                    item: item,
                    pointIndex: ptIdx,
                    isEndpoint: (ptIdx === 0 || ptIdx === grp.points.length - 1)
                });
            });
        });

        onProgress(50, 'Đang kiểm tra lỗi đầu mút hở (Dangles)...');

        // 2. Kiểm tra ĐẦU MÚT HỞ (Dangles) cho các nét dạng line
        strokeItems.forEach(item => {
            const grp = item.group;
            const pts = grp.points;
            if (pts.length < 2) {
                // Nét suy biến
                errors.push({
                    id: `topo-3d-deg-${grp.id}`,
                    type: 'dangle',
                    title: `Lỗi nét ngắn / suy biến (${grp.name || grp.id})`,
                    desc: `Nét vẽ chỉ có ${pts.length} điểm, không đủ tạo thành đường.`,
                    coord: pts.length > 0 ? [pts[0].lng, pts[0].lat, pts[0].height || 0] : [0, 0, 0],
                    group: grp,
                    item: item,
                    rawError: { group: grp }
                });
                return;
            }

            const connectMode = grp.connectMode || 'line';

            if (connectMode === 'line') {
                // Kiểm tra điểm đầu pts[0] và điểm cuối pts[pts.length - 1]
                const endpoints = [
                    { pt: pts[0], posLabel: 'Điểm đầu' },
                    { pt: pts[pts.length - 1], posLabel: 'Điểm cuối' }
                ];

                endpoints.forEach(({ pt, posLabel }) => {
                    // Đếm số lượng đỉnh khác (trong các nhóm khác hoặc trong cùng nhóm nhưng khác điểm) kết nối với pt
                    let connectedCount = 0;
                    for (const other of allPoints) {
                        if (other.group.id === grp.id && other.point.id === pt.id) continue;
                        const d = distMeters(pt, other.point);
                        if (d <= tolerance) {
                            connectedCount++;
                        }
                    }

                    if (connectedCount === 0) {
                        const hText = pt.height != null ? ` (Cao độ: ${pt.height.toFixed(2)}m)` : '';
                        errors.push({
                            id: `topo-3d-dangle-${grp.id}-${pt.id}`,
                            type: 'dangle',
                            title: `Đầu mút hở #${errorIndex++} — ${grp.name || grp.id}`,
                            desc: `${posLabel} (${pt.lng.toFixed(6)}, ${pt.lat.toFixed(6)})${hText} chưa khép kín với nét nào.`,
                            coord: [pt.lng, pt.lat, pt.height || 0],
                            group: grp,
                            point: pt,
                            item: item,
                            rawError: { group: grp, point: pt }
                        });
                    }
                });
            } else if (connectMode === 'polygon') {
                // Đa giác nhưng chưa nối vòng khép kín
                const startPt = pts[0];
                const endPt = pts[pts.length - 1];
                if (distMeters(startPt, endPt) > tolerance) {
                    errors.push({
                        id: `topo-3d-unclosed-${grp.id}`,
                        type: 'dangle',
                        title: `Vùng chưa khép kín #${errorIndex++} — ${grp.name || grp.id}`,
                        desc: `Đa giác chưa nối liền điểm đầu và điểm cuối (cách nhau ${distMeters(startPt, endPt).toFixed(2)}m).`,
                        coord: [endPt.lng, endPt.lat, endPt.height || 0],
                        group: grp,
                        point: endPt,
                        item: item,
                        rawError: { group: grp }
                    });
                }
            }
        });

        onProgress(75, 'Đang kiểm tra trùng nét (Duplicates)...');

        // 3. Kiểm tra TRÙNG NÉT (Duplicate Segments)
        const segments = [];
        strokeItems.forEach(item => {
            const grp = item.group;
            const pts = grp.points;
            for (let i = 0; i < pts.length - 1; i++) {
                segments.push({
                    p1: pts[i],
                    p2: pts[i + 1],
                    group: grp,
                    item: item,
                    segIndex: i
                });
            }
        });

        for (let i = 0; i < segments.length; i++) {
            for (let j = i + 1; j < segments.length; j++) {
                const s1 = segments[i];
                const s2 = segments[j];

                // Kiểm tra cùng chiều (p1~p1 & p2~p2) hoặc ngược chiều (p1~p2 & p2~p1)
                const d11 = distMeters(s1.p1, s2.p1);
                const d22 = distMeters(s1.p2, s2.p2);
                const d12 = distMeters(s1.p1, s2.p2);
                const d21 = distMeters(s1.p2, s2.p1);

                const isSameDir = d11 <= tolerance && d22 <= tolerance;
                const isOppositeDir = d12 <= tolerance && d21 <= tolerance;

                if (isSameDir || isOppositeDir) {
                    const midLng = (s1.p1.lng + s1.p2.lng) / 2;
                    const midLat = (s1.p1.lat + s1.p2.lat) / 2;
                    const midH = ((s1.p1.height || 0) + (s1.p2.height || 0)) / 2;

                    errors.push({
                        id: `topo-3d-dup-${s1.group.id}-${s2.group.id}-${s1.segIndex}`,
                        type: 'duplicate',
                        title: `Trùng nét #${errorIndex++} — ${s1.group.name || s1.group.id}`,
                        desc: `Đoạn thẳng trùng lặp với "${s2.group.name || s2.group.id}".`,
                        coord: [midLng, midLat, midH],
                        group: s1.group,
                        item: s1.item,
                        rawError: { group1: s1.group, group2: s2.group }
                    });
                }
            }
        }

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

        // 3. Fallback: Điều khiển camera 3D trực tiếp tới toạ độ lỗi
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

    log('Check Topo 3D Module Ready');
})();
