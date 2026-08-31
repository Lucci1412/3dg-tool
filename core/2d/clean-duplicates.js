// ============================================================
// 3DG Topology Checker — Module: Clean Duplicate Lines & Features
// Tự động quét toàn bộ bản đồ và xóa nét / thửa đất bị trùng lặp hoàn toàn
// ============================================================

(function () {
    'use strict';

    function log(...args) {
        // console.log('[CleanDuplicates]', ...args);
    }

    // ===== GEOMETRIC SIMILARITY CHECKERS =====
    function areLineCoordsDuplicate(c1, c2, tol = 0.08) {
        if (!c1 || !c2 || c1.length !== c2.length || c1.length < 2) return false;
        const tolSq = tol * tol;
        const n = c1.length;

        // Check Forward
        let forwardMatch = true;
        for (let i = 0; i < n; i++) {
            const dx = c1[i][0] - c2[i][0];
            const dy = c1[i][1] - c2[i][1];
            if (dx * dx + dy * dy > tolSq) {
                forwardMatch = false;
                break;
            }
        }
        if (forwardMatch) return true;

        // Check Reversed
        let reversedMatch = true;
        for (let i = 0; i < n; i++) {
            const dx = c1[i][0] - c2[n - 1 - i][0];
            const dy = c1[i][1] - c2[n - 1 - i][1];
            if (dx * dx + dy * dy > tolSq) {
                reversedMatch = false;
                break;
            }
        }
        return reversedMatch;
    }

    function arePolygonCoordsDuplicate(ring1, ring2, tol = 0.08) {
        if (!ring1 || !ring2) return false;
        let r1 = [...ring1];
        let r2 = [...ring2];
        if (r1.length > 3 && Math.hypot(r1[0][0] - r1[r1.length - 1][0], r1[0][1] - r1[r1.length - 1][1]) < 1e-4) r1.pop();
        if (r2.length > 3 && Math.hypot(r2[0][0] - r2[r2.length - 1][0], r2[0][1] - r2[r2.length - 1][1]) < 1e-4) r2.pop();

        if (r1.length !== r2.length || r1.length < 3) return false;
        const n = r1.length;
        const tolSq = tol * tol;

        // Check all cyclic shifts forward
        for (let shift = 0; shift < n; shift++) {
            let match = true;
            for (let i = 0; i < n; i++) {
                const p1 = r1[i];
                const p2 = r2[(i + shift) % n];
                const dx = p1[0] - p2[0];
                const dy = p1[1] - p2[1];
                if (dx * dx + dy * dy > tolSq) {
                    match = false;
                    break;
                }
            }
            if (match) return true;
        }

        // Check all cyclic shifts reversed
        for (let shift = 0; shift < n; shift++) {
            let match = true;
            for (let i = 0; i < n; i++) {
                const p1 = r1[i];
                const p2 = r2[(n - 1 - i + shift) % n];
                const dx = p1[0] - p2[0];
                const dy = p1[1] - p2[1];
                if (dx * dx + dy * dy > tolSq) {
                    match = false;
                    break;
                }
            }
            if (match) return true;
        }

        return false;
    }

    // ===== COLLECT ALL VECTOR FEATURES FROM MAP =====
    function collectAllMapFeatures() {
        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        if (!map) return [];

        const results = [];
        const seenObjects = new Set();

        function walk(layer) {
            if (typeof layer.getLayers === 'function') {
                try { layer.getLayers().forEach(walk); } catch (e) { }
                return;
            }
            try {
                if (layer.getVisible && !layer.getVisible()) return;
                const src = layer.getSource?.();
                if (!src?.getFeatures || typeof src.removeFeature !== 'function') return;
                const layerId = String(layer.get?.('id') || layer.get?.('name') || layer.get?.('title') || '').toLowerCase();
                if (layerId.includes('topo') || layerId.includes('highlight') || layerId.includes('overlay') || layerId.includes('preview')) return;

                for (const f of src.getFeatures()) {
                    if (seenObjects.has(f)) continue;
                    seenObjects.add(f);

                    const geom = f.getGeometry?.();
                    if (!geom) continue;

                    const type = geom.getType?.();
                    if (type === 'LineString' || type === 'MultiLineString' || type === 'Polygon' || type === 'MultiPolygon') {
                        results.push({
                            feature: f,
                            id: f.getId?.() || f._id || f.id_ || f.id || ('feat_' + results.length),
                            geometry: geom,
                            type: type,
                            source: src,
                            layer: layer
                        });
                    }
                }
            } catch (e) { }
        }

        try {
            map.getLayers().forEach(walk);
        } catch (e) { }

        return results;
    }

    // ===== MAIN DUPLICATE CLEANER FUNCTION =====
    async function cleanDuplicateLinesAndPolygons(options = {}) {
        const tol = options.tolerance !== undefined ? Number(options.tolerance) : 0.08; // 8cm tolerance
        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        if (!map) {
            return { ok: false, error: 'Không tìm thấy bản đồ 3DG', deletedCount: 0 };
        }

        const featureItems = collectAllMapFeatures();
        if (featureItems.length === 0) {
            return { ok: true, deletedCount: 0, message: 'Không có đối tượng nào trên bản đồ.' };
        }

        log(`Đang quét ${featureItems.length} đối tượng để tìm nét trùng lặp...`);

        // Group features by geometric bucket (type + point count + coarse bbox) for O(N) performance
        const buckets = new Map();

        featureItems.forEach(item => {
            const geom = item.geometry;
            const type = item.type;
            let coords = geom.getCoordinates?.() || [];

            let ptCount = 0;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

            if (type === 'LineString') {
                ptCount = coords.length;
                coords.forEach(p => {
                    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
                    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
                });
            } else if (type === 'Polygon') {
                const ring = coords[0] || [];
                ptCount = ring.length;
                ring.forEach(p => {
                    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
                    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
                });
            } else if (type === 'MultiLineString') {
                ptCount = coords.reduce((acc, line) => acc + line.length, 0);
            } else if (type === 'MultiPolygon') {
                ptCount = coords.reduce((acc, poly) => acc + (poly[0]?.length || 0), 0);
            }

            if (ptCount === 0) return;

            // Coarse bucket key
            const bKey = `${type}_${ptCount}_${Math.round(minX / 10)}_${Math.round(minY / 10)}`;
            let list = buckets.get(bKey);
            if (!list) {
                list = [];
                buckets.set(bKey, list);
            }
            list.push({ ...item, coords });
        });

        const duplicatesToDelete = [];
        const preservedFeatures = new Set();

        // Compare pairs within each bucket
        for (const [key, items] of buckets.entries()) {
            if (items.length < 2) continue;

            const n = items.length;
            const isDup = new Array(n).fill(false);

            for (let i = 0; i < n; i++) {
                if (isDup[i]) continue;
                const itemA = items[i];

                for (let j = i + 1; j < n; j++) {
                    if (isDup[j]) continue;
                    const itemB = items[j];

                    let matched = false;

                    if (itemA.type === 'LineString' && itemB.type === 'LineString') {
                        matched = areLineCoordsDuplicate(itemA.coords, itemB.coords, tol);
                    } else if (itemA.type === 'Polygon' && itemB.type === 'Polygon') {
                        matched = arePolygonCoordsDuplicate(itemA.coords[0], itemB.coords[0], tol);
                    } else if (itemA.type === 'MultiLineString' && itemB.type === 'MultiLineString') {
                        if (itemA.coords.length === itemB.coords.length) {
                            matched = itemA.coords.every((lineA, idx) => areLineCoordsDuplicate(lineA, itemB.coords[idx], tol));
                        }
                    } else if (itemA.type === 'MultiPolygon' && itemB.type === 'MultiPolygon') {
                        if (itemA.coords.length === itemB.coords.length) {
                            matched = itemA.coords.every((polyA, idx) => arePolygonCoordsDuplicate(polyA[0], itemB.coords[idx]?.[0], tol));
                        }
                    }

                    if (matched) {
                        // Keep itemA, mark itemB as duplicate to delete
                        isDup[j] = true;
                        duplicatesToDelete.push(itemB);
                        preservedFeatures.add(itemA.feature);
                    }
                }
            }
        }

        let deletedCount = 0;
        const modifiedSources = new Set();

        duplicatesToDelete.forEach(item => {
            try {
                if (item.source && typeof item.source.removeFeature === 'function') {
                    item.source.removeFeature(item.feature);
                    modifiedSources.add(item.source);
                    deletedCount++;

                    // Sync with React / 3DG state
                    if (window.__topoSyncFeatureToReactState) {
                        try { window.__topoSyncFeatureToReactState(item.feature, 'delete'); } catch (e) { }
                    }
                }
            } catch (e) {
                console.error('[CleanDuplicates] Error removing duplicate feature:', e);
            }
        });

        // Trigger map source updates
        modifiedSources.forEach(src => {
            try { if (typeof src.changed === 'function') src.changed(); } catch (e) { }
        });

        if (typeof map.render === 'function') {
            try { map.render(); } catch (e) { }
        }

        try {
            window.dispatchEvent(new CustomEvent('topo:features-updated'));
        } catch (e) { }

        log(`🎉 Đã quét và xóa thành công ${deletedCount} nét trùng lặp.`);

        return {
            ok: true,
            totalScanned: featureItems.length,
            deletedCount: deletedCount
        };
    }

    // Expose Global API
    window.__topoCleanDuplicateLines = cleanDuplicateLinesAndPolygons;

    log('Module Clean Duplicate Features loaded successfully.');

})();
