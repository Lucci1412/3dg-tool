// ============================================================
// 3DG Topology Checker — Feature Module 1: Check Topo
// Accurate Dangle / Unclosed Boundary & Duplicate Line Checker
// ============================================================
// v3 — Bổ sung xử lý MultiPolygon suy biến (thiếu ở v2.1):
//   Nếu 1 polygon con trong MultiPolygon có vành ngoài suy biến (chỉ còn
//   < 4 điểm sau khi loại điểm trùng liên tiếp) -> loại polygon con đó.
//   Nếu TẤT CẢ polygon con đều suy biến -> xóa cả feature khỏi map.
//
// v2.1 — Tự động XÓA feature suy biến khỏi map (không chỉ dọn điểm trùng):
//   - LineString chỉ có 2 điểm trùng nhau (hoặc rút gọn còn < 2 điểm sau
//     khi loại trùng liên tiếp) -> xóa feature.
//   - MultiLineString: loại các line con suy biến; nếu không còn line con
//     nào hợp lệ -> xóa cả feature.
//   - Polygon: vành ngoài suy biến (< 4 điểm sau khi loại trùng) -> xóa
//     feature (áp dụng logic tương tự dedup điểm trùng liên tiếp trên line).
//
// v2 — FIX "Map maximum size exceeded" (xem computeAdaptiveCellSize +
//   buildSegmentGridSafe bên dưới) + chạy async/chunked có onProgress.
//
// v1 — Thay 2 vòng lặp O(n²) (dangle check + duplicate check) bằng
//   Spatial Grid Index. Bỏ JSON.stringify(coords) khi dedup feature.
// ============================================================

(function () {
    'use strict';

    function log() { }
    // Đổi thành console.log nếu cần debug performance:
    // function log(...args) { console.log('[CheckTopo]', ...args); }

    // ===== YIELD TO UI THREAD =====
    function yieldToUI() {
        return new Promise(resolve => {
            if (window.requestIdleCallback) {
                requestIdleCallback(() => resolve(), { timeout: 50 });
            } else {
                setTimeout(resolve, 0);
            }
        });
    }

    // ===== SPATIAL UTILITIES =====
    function distSq(p1, p2) {
        const dx = p1[0] - p2[0];
        const dy = p1[1] - p2[1];
        return dx * dx + dy * dy;
    }

    function pointToSegmentDistSq(p, a, b) {
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const lenSq = dx * dx + dy * dy;
        if (lenSq < 1e-12) return distSq(p, a);

        let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));

        const projX = a[0] + t * dx;
        const projY = a[1] + t * dy;
        return (p[0] - projX) ** 2 + (p[1] - projY) ** 2;
    }

    // ===== SPATIAL GRID INDEX =====
    class SpatialGrid {
        constructor(cellSize) {
            this.cellSize = Math.max(cellSize, 1e-9);
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

        // Tô toàn bộ ô trong 1 bbox. CHỈ dùng khi số ô đã được kiểm tra an toàn.
        insertBBox(minX, minY, maxX, maxY, item) {
            const [cx0, cy0] = this._cellCoord(minX, minY);
            const [cx1, cy1] = this._cellCoord(maxX, maxY);
            for (let cx = cx0; cx <= cx1; cx++) {
                for (let cy = cy0; cy <= cy1; cy++) {
                    this._addToCell(this._key(cx, cy), item);
                }
            }
        }

        // "Đi bộ" dọc đoạn thẳng, chỉ insert vào các ô đường thực sự đi qua
        // (+ vùng đệm tolerance quy đổi ra số ô). An toàn với đoạn dài.
        insertSegmentWalk(p1, p2, tolerance, item) {
            const length = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
            const stepSize = Math.max(this.cellSize * 0.5, 1e-9);
            // Cap số bước để tuyệt đối không thể chạy vô hạn với dữ liệu dị thường.
            const steps = Math.max(1, Math.min(200000, Math.ceil(length / stepSize)));
            const rad = Math.max(0, Math.ceil(tolerance / this.cellSize));
            const inserted = new Set();

            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                const x = p1[0] + (p2[0] - p1[0]) * t;
                const y = p1[1] + (p2[1] - p1[1]) * t;
                const [cx, cy] = this._cellCoord(x, y);
                for (let dx = -rad; dx <= rad; dx++) {
                    for (let dy = -rad; dy <= rad; dy++) {
                        const k = this._key(cx + dx, cy + dy);
                        if (inserted.has(k)) continue;
                        inserted.add(k);
                        this._addToCell(k, item);
                    }
                }
            }
        }

        // Chọn tự động: bbox nếu rẻ, line-walk nếu bbox quá lớn.
        // Đây là hàm NÊN DÙNG khi insert đoạn thẳng (thay cho gọi insertBBox trực tiếp).
        insertSegmentSmart(p1, p2, tolerance, item) {
            const minX = Math.min(p1[0], p2[0]) - tolerance;
            const maxX = Math.max(p1[0], p2[0]) + tolerance;
            const minY = Math.min(p1[1], p2[1]) - tolerance;
            const maxY = Math.max(p1[1], p2[1]) + tolerance;

            const nx = Math.ceil((maxX - minX) / this.cellSize) + 1;
            const ny = Math.ceil((maxY - minY) / this.cellSize) + 1;

            if (nx * ny <= SpatialGrid.CELL_BUDGET) {
                this.insertBBox(minX, minY, maxX, maxY, item);
            } else {
                this.insertSegmentWalk(p1, p2, tolerance, item);
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

        queryBBox(minX, minY, maxX, maxY) {
            const [cx0, cy0] = this._cellCoord(minX, minY);
            const [cx1, cy1] = this._cellCoord(maxX, maxY);
            const out = [];
            const seen = new Set();
            for (let cx = cx0; cx <= cx1; cx++) {
                for (let cy = cy0; cy <= cy1; cy++) {
                    const arr = this.cells.get(this._key(cx, cy));
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
    // Ngân sách số ô tối đa cho phép tô đầy bbox của 1 đoạn thẳng.
    // Vượt ngưỡng này -> tự động chuyển sang line-walk.
    SpatialGrid.CELL_BUDGET = 4000;

    // ===== ADAPTIVE CELL SIZE =====
    // Thay vì gắn cứng cellSize theo tolerance (dễ vỡ khi dữ liệu trải rộng
    // trên phạm vi lớn), tính cellSize dựa trên diện tích bao trùm thực tế
    // của dữ liệu + số lượng đoạn thẳng, sao cho tổng số ô luôn nằm trong
    // tầm kiểm soát (mục tiêu vài đoạn/ô), bất kể tolerance nhỏ hay lớn.
    // Grid thô hơn không ảnh hưởng độ chính xác (chỉ ảnh hưởng hiệu năng lọc
    // ứng viên) vì khoảng cách chính xác vẫn được tính bằng tolerance thật
    // ở bước sau (pointToSegmentDistSq / distSq).
    function computeAdaptiveCellSize(segments, tolerance) {
        if (!segments || !segments.length) return Math.max(tolerance * 2, 1);

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const s of segments) {
            const x1 = s.p1[0], y1 = s.p1[1], x2 = s.p2[0], y2 = s.p2[1];
            if (x1 < minX) minX = x1; if (x1 > maxX) maxX = x1;
            if (x2 < minX) minX = x2; if (x2 > maxX) maxX = x2;
            if (y1 < minY) minY = y1; if (y1 > maxY) maxY = y1;
            if (y2 < minY) minY = y2; if (y2 > maxY) maxY = y2;
        }

        const width = Math.max(maxX - minX, 1e-6);
        const height = Math.max(maxY - minY, 1e-6);
        const area = width * height;

        // Mục tiêu: trung bình ~4 đoạn/ô, tối thiểu 1000 ô, tối đa 2 triệu ô
        // (để tổng entries của Map không bao giờ tiến gần giới hạn 16 triệu
        // dù mỗi đoạn có thể chạm nhiều hơn 1 ô).
        const targetCells = Math.min(2_000_000, Math.max(1000, segments.length * 4));
        let cellSize = Math.sqrt(area / targetCells);

        // Không cần mịn hơn mức cần thiết cho việc lọc ứng viên.
        cellSize = Math.max(cellSize, tolerance * 2);

        return cellSize;
    }

    // ===== COLLECT ALL VECTOR FEATURES FROM MAP =====
    function collectAllFeatures() {
        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        if (!map) return [];

        const results = [];
        const seenFeatureObjects = new Set();
        const seenFeatureIds = new Set();

        function walk(layer) {
            if (typeof layer.getLayers === 'function') {
                try { layer.getLayers().forEach(walk); } catch (e) { }
                return;
            }
            try {
                if (layer.getVisible && !layer.getVisible()) return;
                const src = layer.getSource?.();
                if (!src?.getFeatures) return;
                const layerId = String(layer.get?.('id') || layer.get?.('name') || layer.get?.('title') || '').toLowerCase();
                if (layerId.includes('topo') || layerId.includes('highlight') || layerId.includes('overlay') || layerId.includes('preview')) return;

                for (const f of src.getFeatures()) {
                    if (seenFeatureObjects.has(f)) continue;
                    seenFeatureObjects.add(f);

                    const geom = f.getGeometry?.();
                    if (!geom) continue;

                    const type = geom.getType();
                    if (type === 'LineString' || type === 'MultiLineString' || type === 'Polygon' || type === 'MultiPolygon') {
                        const fId = (typeof f.getId === 'function' ? f.getId() : null) ?? f.get?.('id') ?? f.id ?? f._id ?? f.id_;
                        let uniqueId = (fId != null && fId !== '') ? String(fId) : ('feat_' + results.length);
                        if (seenFeatureIds.has(uniqueId)) {
                            uniqueId = `${uniqueId}_${results.length}`;
                        }
                        seenFeatureIds.add(uniqueId);

                        results.push({
                            feature: f,
                            id: uniqueId,
                            rawId: (fId != null && fId !== '') ? String(fId) : null,
                            geometry: geom,
                            layer: layer,
                            source: src
                        });
                    }
                }
            } catch (e) {
                console.warn('[CheckTopo] Error collecting features from layer:', e);
            }
        }

        try {
            map.getLayers().forEach(walk);
        } catch (e) {
            console.warn('[CheckTopo] Error traversing map layers:', e);
        }

        return results;
    }

    // ===== CONSECUTIVE DUPLICATE VERTEX CLEANER & DEGENERATE FEATURE DETECTOR =====
    function sanitizeLineStringCoords(coords, tol = 1e-5) {
        if (!coords || !Array.isArray(coords) || coords.length === 0) {
            return { cleaned: [], removedCount: 0, isDegenerate: true };
        }
        if (coords.length === 1) {
            return { cleaned: coords, removedCount: 0, isDegenerate: true };
        }

        const tolSq = Math.max(1e-12, (tol > 0 ? tol * tol : 1e-12));
        const cleaned = [coords[0]];
        let removedCount = 0;

        for (let i = 1; i < coords.length; i++) {
            const prev = cleaned[cleaned.length - 1];
            const curr = coords[i];
            if (!curr || typeof curr[0] !== 'number' || typeof curr[1] !== 'number') continue;

            const dx = curr[0] - prev[0];
            const dy = curr[1] - prev[1];
            const dSq = dx * dx + dy * dy;

            if (dSq <= tolSq) {
                removedCount++;
            } else {
                cleaned.push(curr);
            }
        }

        // LineString phải có ít nhất 2 điểm phân biệt để tạo thành đoạn thẳng.
        const isDegenerate = cleaned.length < 2;
        return { cleaned, removedCount, isDegenerate };
    }

    function sanitizePolygonRingCoords(ring, tol = 1e-5) {
        if (!ring || ring.length < 4) return { cleaned: ring, removedCount: 0, isDegenerate: true };

        const tolSq = Math.max(1e-12, (tol > 0 ? tol * tol : 1e-12));
        const cleaned = [ring[0]];
        let removedCount = 0;

        for (let i = 1; i < ring.length; i++) {
            const prev = cleaned[cleaned.length - 1];
            const curr = ring[i];
            if (!curr || typeof curr[0] !== 'number') continue;

            const dx = curr[0] - prev[0];
            const dy = curr[1] - prev[1];
            const dSq = dx * dx + dy * dy;

            const isLastClosing = (i === ring.length - 1);
            if (dSq <= tolSq && !isLastClosing) {
                removedCount++;
            } else {
                cleaned.push(curr);
            }
        }

        if (cleaned.length >= 2) {
            const first = cleaned[0];
            const last = cleaned[cleaned.length - 1];
            if (Math.abs(first[0] - last[0]) > 1e-6 || Math.abs(first[1] - last[1]) > 1e-6) {
                cleaned.push([first[0], first[1]]);
            }
        }

        const isDegenerate = cleaned.length < 4;
        return { cleaned, removedCount, isDegenerate };
    }

    function autoCleanDuplicateVerticesOnMap(cleanTol = 0.05) {
        const featureItems = collectAllFeatures();
        let totalCleanedFeatures = 0;
        let totalPointsRemoved = 0;
        let totalDeletedFeatures = 0;

        function removeFeatureSafely(item) {
            try {
                if (item.source && typeof item.source.removeFeature === 'function') {
                    item.source.removeFeature(item.feature);
                    totalDeletedFeatures++;
                }
                const targetId = item.rawId || item.id;
                if (targetId && window.__topoRemoveFeatureFromReactState) {
                    window.__topoRemoveFeatureFromReactState(targetId);
                }
            } catch (e) { }
        }

        featureItems.forEach(item => {
            const geom = item.geometry;
            if (!geom) return;

            const type = geom.getType?.();

            if (type === 'LineString') {
                const coords = geom.getCoordinates?.();
                const { cleaned, removedCount, isDegenerate } = sanitizeLineStringCoords(coords, cleanTol);

                if (isDegenerate) {
                    // Line chỉ có 2 điểm mà trùng nhau (hoặc suy biến sau khi
                    // loại điểm trùng) -> xóa luôn feature này khỏi map.
                    removeFeatureSafely(item);
                } else if (removedCount > 0) {
                    // Line nhiều điểm hơn, chỉ có vài điểm trùng liên tiếp -> dọn điểm trùng.
                    geom.setCoordinates(cleaned);
                    if (item.feature && typeof item.feature.setGeometry === 'function') {
                        item.feature.setGeometry(geom);
                    }
                    totalCleanedFeatures++;
                    totalPointsRemoved += removedCount;

                    if (item.source && typeof item.source.changed === 'function') {
                        item.source.changed();
                    }
                    if (window.__topoSyncFeatureToReactState && item.feature) {
                        try {
                            window.__topoSyncFeatureToReactState(item.feature);
                        } catch (e) { }
                    }
                }
            } else if (type === 'MultiLineString') {
                const coords = geom.getCoordinates?.() || [];
                const cleanedLines = [];
                let multiRemoved = 0;

                for (const line of coords) {
                    const { cleaned, removedCount, isDegenerate } = sanitizeLineStringCoords(line, cleanTol);
                    multiRemoved += removedCount;
                    if (!isDegenerate) {
                        cleanedLines.push(cleaned);
                    }
                }

                if (cleanedLines.length === 0) {
                    // Không còn line con nào hợp lệ -> xóa cả feature.
                    removeFeatureSafely(item);
                } else if (cleanedLines.length !== coords.length || multiRemoved > 0) {
                    geom.setCoordinates(cleanedLines);
                    if (item.feature && typeof item.feature.setGeometry === 'function') {
                        item.feature.setGeometry(geom);
                    }
                    totalCleanedFeatures++;
                    totalPointsRemoved += multiRemoved;
                    if (item.source && typeof item.source.changed === 'function') {
                        item.source.changed();
                    }
                    if (window.__topoSyncFeatureToReactState && item.feature) {
                        try {
                            window.__topoSyncFeatureToReactState(item.feature);
                        } catch (e) { }
                    }
                }
            } else if (type === 'Polygon') {
                const rings = geom.getCoordinates?.() || [];
                if (rings.length > 0) {
                    const { cleaned: exteriorCleaned, removedCount, isDegenerate } = sanitizePolygonRingCoords(rings[0], cleanTol);
                    if (isDegenerate) {
                        // Vành ngoài suy biến (< 4 điểm sau khi loại trùng) -> xóa feature.
                        removeFeatureSafely(item);
                    } else if (removedCount > 0) {
                        const newRings = [exteriorCleaned, ...rings.slice(1)];
                        geom.setCoordinates(newRings);
                        if (item.feature && typeof item.feature.setGeometry === 'function') {
                            item.feature.setGeometry(geom);
                        }
                        totalCleanedFeatures++;
                        totalPointsRemoved += removedCount;
                        if (item.source && typeof item.source.changed === 'function') {
                            item.source.changed();
                        }
                        if (window.__topoSyncFeatureToReactState && item.feature) {
                            try {
                                window.__topoSyncFeatureToReactState(item.feature);
                            } catch (e) { }
                        }
                    }
                }
            } else if (type === 'MultiPolygon') {
                // Mỗi polygon con trong MultiPolygon xử lý như Polygon đơn:
                // nếu vành ngoài của 1 polygon con suy biến -> loại polygon con đó.
                // Nếu TẤT CẢ polygon con đều suy biến -> xóa cả feature.
                const polys = geom.getCoordinates?.() || [];
                const cleanedPolys = [];
                let multiRemoved = 0;

                for (const poly of polys) {
                    if (!poly || poly.length === 0) continue;
                    const { cleaned: exteriorCleaned, removedCount, isDegenerate } = sanitizePolygonRingCoords(poly[0], cleanTol);
                    multiRemoved += removedCount;
                    if (!isDegenerate) {
                        cleanedPolys.push([exteriorCleaned, ...poly.slice(1)]);
                    }
                }

                if (cleanedPolys.length === 0) {
                    removeFeatureSafely(item);
                } else if (cleanedPolys.length !== polys.length || multiRemoved > 0) {
                    geom.setCoordinates(cleanedPolys);
                    if (item.feature && typeof item.feature.setGeometry === 'function') {
                        item.feature.setGeometry(geom);
                    }
                    totalCleanedFeatures++;
                    totalPointsRemoved += multiRemoved;
                    if (item.source && typeof item.source.changed === 'function') {
                        item.source.changed();
                    }
                    if (window.__topoSyncFeatureToReactState && item.feature) {
                        try {
                            window.__topoSyncFeatureToReactState(item.feature);
                        } catch (e) { }
                    }
                }
            }
        });

        if (totalDeletedFeatures > 0 || totalCleanedFeatures > 0) {
            log(`⚡ Đã xóa ${totalDeletedFeatures} đối tượng suy biến (không đủ điểm phân biệt), loại bỏ ${totalPointsRemoved} điểm tọa độ trùng liên tiếp trên ${totalCleanedFeatures} đối tượng!`);
        }

        return {
            totalCleanedFeatures,
            totalPointsRemoved,
            totalDeletedFeatures,
            cleanedFeatures: totalCleanedFeatures,
            pointsRemoved: totalPointsRemoved,
            deletedFeatures: totalDeletedFeatures
        };
    }

    // ===== SAFE GRID BUILDER (adaptive cellSize + auto-retry coarser) =====
    // Dựng grid cho 1 danh sách đoạn thẳng. Nếu vẫn chạm giới hạn Map (rất
    // hiếm sau khi đã dùng adaptive cellSize), tự động thử lại với cellSize
    // thô hơn (x4 mỗi lần) tối đa vài lần trước khi báo lỗi thân thiện.
    async function buildSegmentGridSafe(segments, tolerance, label, onChunk) {
        let scaleFactor = 1;
        let lastErr = null;

        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                const baseCellSize = computeAdaptiveCellSize(segments, tolerance);
                const grid = new SpatialGrid(baseCellSize * scaleFactor);

                let count = 0;
                for (const seg of segments) {
                    grid.insertSegmentSmart(seg.p1, seg.p2, tolerance, seg);
                    count++;
                    if (count % 3000 === 0) {
                        if (onChunk) await onChunk(count, segments.length);
                        else await yieldToUI();
                    }
                }
                return grid;
            } catch (e) {
                lastErr = e;
                const isMapSizeErr = e instanceof RangeError && /size/i.test(e.message || '');
                if (isMapSizeErr) {
                    log(`[${label}] Grid build hit size limit (attempt ${attempt + 1}), retrying with coarser grid...`);
                    scaleFactor *= 4;
                    await yieldToUI();
                    continue;
                }
                throw e;
            }
        }

        throw new Error(`Không thể dựng lưới không gian cho "${label}" — dữ liệu có thể quá lớn hoặc phân bố bất thường (${lastErr?.message || ''})`);
    }

    // ===== MAIN TOPOLOGY SCANNER (ASYNC + CHUNKED + PROGRESS) =====
    async function runTopologyCheck(options = {}) {
        try {
            return await runTopologyCheckInner(options);
        } catch (e) {
            console.error('[CheckTopoFeature] Topology check failed:', e);
            throw new Error(e?.message?.includes('lưới không gian')
                ? e.message
                : `Quét topology thất bại: ${e?.message || e}`);
        }
    }

    async function runTopologyCheckInner(options = {}) {
        const startTime = performance.now();
        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        if (!map) {
            console.error('[CheckTopoFeature] Map instance not found!');
            return [];
        }

        const onProgressRaw = typeof options.onProgress === 'function' ? options.onProgress : null;
        async function report(pct, msg) {
            log(`[${pct}%] ${msg}`);
            if (onProgressRaw) {
                try { await onProgressRaw(pct, msg); } catch (e) { }
            }
            await yieldToUI();
        }

        const tolerance = options.tolerance !== undefined ? Number(options.tolerance) : 0.5;
        const tolSq = tolerance * tolerance;

        // Dọn dẹp điểm trùng lặp liên tiếp trên cùng 1 nét vẽ (dung sai an toàn 5cm = 0.05m)
        const cleanTol = options.cleanTol !== undefined ? Number(options.cleanTol) : 0.05;

        await report(1, 'Đang dọn dẹp đỉnh trùng lặp và đối tượng suy biến...');
        let cleanStats = { totalCleanedFeatures: 0, totalPointsRemoved: 0, totalDeletedFeatures: 0 };
        if (options.autoClean !== false) {
            cleanStats = autoCleanDuplicateVerticesOnMap(cleanTol);
            if (cleanStats.totalPointsRemoved > 0 || cleanStats.totalDeletedFeatures > 0) {
                await report(2, `Đã dọn dẹp ${cleanStats.totalPointsRemoved} đỉnh trùng lặp (${cleanStats.totalCleanedFeatures} nét)...`);
            }
        }

        await report(5, 'Đang thu thập đối tượng trên bản đồ...');
        const featureItems = collectAllFeatures();
        log(`Scanned ${featureItems.length} features on map for unclosed dangle check...`);

        if (featureItems.length === 0) return [];

        const allSegments = [];
        const allVertices = [];

        let processedFeatures = 0;
        for (const item of featureItems) {
            const geom = item.geometry;
            const type = geom.getType();
            let coords = geom.getCoordinates();

            if (type === 'LineString') {
                const { cleaned, isDegenerate } = sanitizeLineStringCoords(coords, cleanTol);
                if (isDegenerate) continue;
                coords = cleaned;

                for (let i = 0; i < coords.length; i++) {
                    const isEnd = (i === 0 || i === coords.length - 1);
                    allVertices.push({
                        point: coords[i],
                        featureId: item.id,
                        isEndpoint: isEnd,
                        featureItem: item,
                        coordIndex: i
                    });
                    if (i < coords.length - 1) {
                        allSegments.push({
                            p1: coords[i],
                            p2: coords[i + 1],
                            featureId: item.id,
                            featureItem: item
                        });
                    }
                }
            } else if (type === 'MultiLineString') {
                const cleanedLines = [];
                for (const line of coords) {
                    const { cleaned, isDegenerate } = sanitizeLineStringCoords(line, cleanTol);
                    if (!isDegenerate) cleanedLines.push(cleaned);
                }
                if (cleanedLines.length === 0) continue;
                coords = cleanedLines;

                for (const line of coords) {
                    for (let i = 0; i < line.length; i++) {
                        const isEnd = (i === 0 || i === line.length - 1);
                        allVertices.push({
                            point: line[i],
                            featureId: item.id,
                            isEndpoint: isEnd,
                            featureItem: item,
                            coordIndex: i
                        });
                        if (i < line.length - 1) {
                            allSegments.push({
                                p1: line[i],
                                p2: line[i + 1],
                                featureId: item.id,
                                featureItem: item
                            });
                        }
                    }
                }
            } else if (type === 'Polygon') {
                if (!coords || coords.length === 0) continue;
                const { cleaned: extCleaned, isDegenerate } = sanitizePolygonRingCoords(coords[0], cleanTol);
                if (isDegenerate) continue;
                coords = [extCleaned, ...coords.slice(1)];

                for (const ring of coords) {
                    for (let i = 0; i < ring.length - 1; i++) {
                        allVertices.push({
                            point: ring[i],
                            featureId: item.id,
                            isEndpoint: false,
                            featureItem: item,
                            coordIndex: i
                        });
                        allSegments.push({
                            p1: ring[i],
                            p2: ring[i + 1],
                            featureId: item.id,
                            featureItem: item
                        });
                    }
                }
            } else if (type === 'MultiPolygon') {
                const cleanedPolys = [];
                for (const poly of coords) {
                    if (!poly || poly.length === 0) continue;
                    const { cleaned: extCleaned, isDegenerate } = sanitizePolygonRingCoords(poly[0], cleanTol);
                    if (!isDegenerate) cleanedPolys.push([extCleaned, ...poly.slice(1)]);
                }
                if (cleanedPolys.length === 0) continue;
                coords = cleanedPolys;

                for (const poly of coords) {
                    for (const ring of poly) {
                        for (let i = 0; i < ring.length - 1; i++) {
                            allVertices.push({
                                point: ring[i],
                                featureId: item.id,
                                isEndpoint: false,
                                featureItem: item,
                                coordIndex: i
                            });
                            allSegments.push({
                                p1: ring[i],
                                p2: ring[i + 1],
                                featureId: item.id,
                                featureItem: item
                            });
                        }
                    }
                }
            }

            processedFeatures++;
            if (processedFeatures % 3000 === 0) {
                await report(5 + Math.round((processedFeatures / featureItems.length) * 10),
                    `Đang trích xuất tọa độ (${processedFeatures}/${featureItems.length} đối tượng)...`);
            }
        }

        log(`Total vertices: ${allVertices.length}, total segments: ${allSegments.length}`);

        const errors = [];
        const seenErrorCoords = new Set();

        function addError(errorObj) {
            const key = `${Math.round(errorObj.coord[0] * 1e6)}_${Math.round(errorObj.coord[1] * 1e6)}_${errorObj.type}`;
            if (seenErrorCoords.has(key)) return;
            seenErrorCoords.add(key);
            errors.push(errorObj);
        }

        // ========================================================
        // DANGLE CHECK — Spatial Grid + safe segment insertion
        // ========================================================
        await report(15, `Đang dựng lưới không gian (${allVertices.length} đỉnh)...`);
        const dangleStart = performance.now();

        const vertexGrid = new SpatialGrid(Math.max(tolerance, 1e-6));
        let vCount = 0;
        for (const v of allVertices) {
            vertexGrid.insertPoint(v.point[0], v.point[1], v);
            vCount++;
            if (vCount % 5000 === 0) await yieldToUI();
        }

        await report(22, `Đang dựng lưới đoạn thẳng (${allSegments.length} đoạn)...`);
        const segGridForDangle = await buildSegmentGridSafe(
            allSegments,
            tolerance,
            'dangle-segments',
            async (count, total) => {
                await report(22 + Math.round((count / total) * 5), `Đang dựng lưới đoạn thẳng (${count}/${total})...`);
            }
        );

        await report(28, `Đang kiểm tra hở ranh giới (${allVertices.length} đỉnh)...`);
        let checkedV = 0;
        const totalVertices = allVertices.length || 1;

        for (const v of allVertices) {
            if (!v.isEndpoint) {
                checkedV++;
                continue;
            }

            const pt = v.point;
            let isConnected = false;

            const nearVerts = vertexGrid.queryPoint(pt[0], pt[1]);
            for (const otherV of nearVerts) {
                if (otherV === v) continue;
                if (otherV.featureId === v.featureId && otherV.isEndpoint) {
                    if (distSq(pt, otherV.point) < 1e-8) {
                        isConnected = true;
                        break;
                    }
                    continue;
                }

                if (distSq(pt, otherV.point) <= tolSq) {
                    isConnected = true;
                    break;
                }
            }

            if (!isConnected) {
                const nearSegs = segGridForDangle.queryPoint(pt[0], pt[1]);
                for (const seg of nearSegs) {
                    if (seg.featureId === v.featureId) continue;
                    if (pointToSegmentDistSq(pt, seg.p1, seg.p2) <= tolSq) {
                        isConnected = true;
                        break;
                    }
                }
            }

            if (!isConnected) {
                addError({
                    id: 'err_' + (errors.length + 1),
                    type: 'dangle',
                    title: 'Chưa khép thửa',
                    description: `Chưa khép thửa`,
                    coord: pt,
                    featureId: v.featureId,
                    featureItem: v.featureItem,
                    severity: 'high'
                });
            }

            checkedV++;
            if (checkedV % 3000 === 0) {
                await report(28 + Math.round((checkedV / totalVertices) * 27),
                    `Đang kiểm tra hở ranh giới (${checkedV}/${totalVertices})...`);
            }
        }

        log(`Dangle check done in ${(performance.now() - dangleStart).toFixed(1)}ms, found ${errors.length} dangles.`);

        // ========================================================
        // DUPLICATE SEGMENT CHECK — Spatial Grid + safe insertion
        // ========================================================
        await report(56, 'Đang chuẩn bị kiểm tra trùng nét...');
        const dupStart = performance.now();

        function segmentsOverlap(a1, a2, b1, b2) {
            const matchSame = (distSq(a1, b1) <= tolSq && distSq(a2, b2) <= tolSq);
            const matchRev = (distSq(a1, b2) <= tolSq && distSq(a2, b1) <= tolSq);
            if (matchSame || matchRev) return true;

            const dA1_B = pointToSegmentDistSq(a1, b1, b2);
            const dA2_B = pointToSegmentDistSq(a2, b1, b2);
            if (dA1_B <= tolSq && dA2_B <= tolSq) return true;

            const dB1_A = pointToSegmentDistSq(b1, a1, a2);
            const dB2_A = pointToSegmentDistSq(b2, a1, a2);
            if (dB1_A <= tolSq && dB2_A <= tolSq) return true;

            return false;
        }

        const uniqueFeatureItems = featureItems;

        const featureCoordsList = [];
        const allDupSegments = [];
        let globalSegId = 0;

        uniqueFeatureItems.forEach((item, featureIdx) => {
            const geom = item.geometry;
            const type = geom?.getType?.();
            const rawCoords = geom?.getCoordinates?.() || [];

            let lines = [];
            if (type === 'LineString') {
                lines = [rawCoords];
                featureCoordsList[featureIdx] = rawCoords;
            } else if (type === 'MultiLineString') {
                lines = rawCoords;
                featureCoordsList[featureIdx] = rawCoords[0] || [];
            } else if (type === 'Polygon') {
                lines = rawCoords;
                featureCoordsList[featureIdx] = rawCoords[0] || [];
            } else if (type === 'MultiPolygon') {
                lines = rawCoords.flatMap(p => p || []);
                featureCoordsList[featureIdx] = (rawCoords[0] && rawCoords[0][0]) || [];
            } else {
                lines = [rawCoords];
                featureCoordsList[featureIdx] = rawCoords;
            }

            for (const line of lines) {
                if (!line || line.length < 2) continue;
                for (let s = 0; s < line.length - 1; s++) {
                    allDupSegments.push({
                        gid: globalSegId++,
                        p1: line[s],
                        p2: line[s + 1],
                        featureIdx,
                        segIdx: s
                    });
                }
            }
        });

        log(`Duplicate check: ${uniqueFeatureItems.length} unique features, ${allDupSegments.length} segments.`);

        await report(62, `Đang dựng lưới cho ${allDupSegments.length} đoạn thẳng...`);
        const segGridForDup = await buildSegmentGridSafe(
            allDupSegments,
            tolerance,
            'duplicate-segments',
            async (count, total) => {
                await report(62 + Math.round((count / total) * 8), `Đang dựng lưới (${count}/${total})...`);
            }
        );

        await report(72, `Đang so khớp ${allDupSegments.length} đoạn thẳng...`);
        const pairMap = new Map();
        const processedPairs = new Set();

        let matchProgress = 0;
        const totalDupSegs = allDupSegments.length || 1;

        for (const segA of allDupSegments) {
            const minX = Math.min(segA.p1[0], segA.p2[0]) - tolerance;
            const maxX = Math.max(segA.p1[0], segA.p2[0]) + tolerance;
            const minY = Math.min(segA.p1[1], segA.p2[1]) - tolerance;
            const maxY = Math.max(segA.p1[1], segA.p2[1]) + tolerance;

            const candidates = segGridForDup.queryBBox(minX, minY, maxX, maxY);

            for (const segB of candidates) {
                if (segB.featureIdx === segA.featureIdx) continue;

                const pairGidKey = segA.gid < segB.gid
                    ? `${segA.gid}_${segB.gid}`
                    : `${segB.gid}_${segA.gid}`;
                if (processedPairs.has(pairGidKey)) continue;
                processedPairs.add(pairGidKey);

                if (!segmentsOverlap(segA.p1, segA.p2, segB.p1, segB.p2)) continue;

                let fi = segA.featureIdx, fj = segB.featureIdx;
                let s1 = segA.segIdx, s2 = segB.segIdx;
                let p1 = segA.p1, p2 = segA.p2, q1 = segB.p1, q2 = segB.p2;

                if (fi > fj) {
                    [fi, fj] = [fj, fi];
                    [s1, s2] = [s2, s1];
                    [p1, p2, q1, q2] = [q1, q2, p1, p2];
                }

                const pairKey = `${fi}___${fj}`;
                let entry = pairMap.get(pairKey);
                if (!entry) {
                    entry = {
                        f1: uniqueFeatureItems[fi],
                        f2: uniqueFeatureItems[fj],
                        matches: [],
                        coords1: featureCoordsList[fi],
                        coords2: featureCoordsList[fj]
                    };
                    pairMap.set(pairKey, entry);
                }
                entry.matches.push({ s1, s2, p1, p2, q1, q2 });
            }

            matchProgress++;
            if (matchProgress % 3000 === 0) {
                await report(72 + Math.round((matchProgress / totalDupSegs) * 23),
                    `Đang so khớp trùng nét (${matchProgress}/${totalDupSegs})...`);
            }
        }

        await report(96, 'Đang tổng hợp kết quả...');

        pairMap.forEach(({ f1, f2, matches, coords1, coords2 }) => {
            const name1 = f1.feature?.get?.('name') || f1.properties?.name || f1.id;
            const name2 = f2.feature?.get?.('name') || f2.properties?.name || f2.id;
            const totalV1 = coords1.length;
            const totalV2 = coords2.length;

            matches.sort((a, b) => a.s1 - b.s1);

            let currentGroup = [matches[0]];

            for (let k = 1; k < matches.length; k++) {
                const prev = currentGroup[currentGroup.length - 1];
                const curr = matches[k];

                if (curr.s1 === prev.s1 + 1 && Math.abs(curr.s2 - prev.s2) <= 1) {
                    currentGroup.push(curr);
                } else {
                    addConsolidatedDupError(f1, f2, currentGroup, totalV1, totalV2, name1, name2, coords1, coords2);
                    currentGroup = [curr];
                }
            }
            if (currentGroup.length > 0) {
                addConsolidatedDupError(f1, f2, currentGroup, totalV1, totalV2, name1, name2, coords1, coords2);
            }
        });

        function getLineLength(coords) {
            if (!coords || coords.length < 2) return 0;
            let len = 0;
            for (let i = 0; i < coords.length - 1; i++) {
                if (coords[i] && coords[i + 1]) {
                    len += Math.hypot(coords[i + 1][0] - coords[i][0], coords[i + 1][1] - coords[i][1]);
                }
            }
            return len;
        }

        function addConsolidatedDupError(f1, f2, group, totalV1, totalV2, name1, name2, coords1, coords2) {
            const len1 = getLineLength(coords1);
            const len2 = getLineLength(coords2);

            const useCoords2 = (len2 < len1);
            const targetCoords = useCoords2 ? coords2 : coords1;

            let startIdx, endIdx;
            if (useCoords2) {
                const s2List = group.map(m => m.s2);
                startIdx = Math.min(...s2List);
                endIdx = Math.max(...s2List) + 1;
            } else {
                const s1List = group.map(m => m.s1);
                startIdx = Math.min(...s1List);
                endIdx = Math.max(...s1List) + 1;
            }

            startIdx = Math.max(0, Math.min(startIdx, targetCoords.length - 1));
            endIdx = Math.max(startIdx + 1, Math.min(endIdx, targetCoords.length - 1));

            const pathCoords = [];
            for (let idx = startIdx; idx <= endIdx; idx++) {
                if (targetCoords[idx]) {
                    pathCoords.push(targetCoords[idx]);
                }
            }

            if (pathCoords.length < 2 && targetCoords.length >= 2) {
                pathCoords.push(targetCoords[0], targetCoords[targetCoords.length - 1]);
            }

            const midIdx = Math.floor(pathCoords.length / 2);
            const centerPt = pathCoords[midIdx] || pathCoords[0];

            let segLen = getLineLength(pathCoords);
            const shorterFeature = len2 < len1 ? f2 : f1;

            addError({
                id: 'err_dup_' + (errors.length + 1),
                type: 'duplicate',
                title: 'Trùng nét',
                description: `Trùng nét (${segLen < 1000 ? segLen.toFixed(1) + 'm' : (segLen / 1000).toFixed(2) + 'km'}) - ${shorterFeature.feature?.get?.('name') || shorterFeature.properties?.name || shorterFeature.id}`,
                coord: centerPt,
                pathCoords: pathCoords,
                segment: [pathCoords[0], pathCoords[pathCoords.length - 1]],
                featureIds: [f1.id, f2.id],
                shorterFeatureId: shorterFeature.id,
                featureItems: [f1, f2],
                length: segLen,
                severity: 'high'
            });
        }

        log(`Duplicate check done in ${(performance.now() - dupStart).toFixed(1)}ms.`);

        errors.sort((a, b) => {
            if (a.type === 'duplicate' && b.type === 'duplicate') {
                return (a.length || 0) - (b.length || 0);
            }
            if (a.type === 'duplicate') return -1;
            if (b.type === 'duplicate') return 1;
            return 0;
        });

        await report(100, 'Hoàn tất quét.');

        const endTime = performance.now();
        log(`Topology check completed in ${(endTime - startTime).toFixed(1)}ms. Found ${errors.length} errors.`);

        errors.cleanStats = cleanStats;
        return errors;
    }

    // Expose engine globally
    window.__topoRunCheck = runTopologyCheck;
    window.__topoCleanDuplicateVertices = autoCleanDuplicateVerticesOnMap;

})();