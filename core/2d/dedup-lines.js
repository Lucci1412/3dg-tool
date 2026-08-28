// ============================================================
// 3DG Map Tools — Feature Module 6: Dedup Lines (Xóa Nét Trùng)
// - Scans and identifies duplicate / identical polyline features across map
// - High-performance canonical coordinate hashing & bidirectional spatial matching
// - Removes duplicate overlapping lines, keeping exactly 1 primary line
// - Seamlessly syncs batch deletion with OpenLayers & React Fiber state
// ============================================================

(function () {
    'use strict';

    function log(...args) {
        // console.log('[DedupLines]', ...args);
    }

    function yieldToUI() {
        return new Promise(resolve => {
            if (window.requestIdleCallback) {
                requestIdleCallback(() => resolve(), { timeout: 40 });
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

    function sanitizeLineCoords(coords, tol = 1e-4) {
        if (!coords || !Array.isArray(coords) || coords.length === 0) return [];
        if (coords.length === 1) return coords;

        const tolSq = tol * tol;
        const cleaned = [coords[0]];

        for (let i = 1; i < coords.length; i++) {
            const prev = cleaned[cleaned.length - 1];
            const curr = coords[i];
            if (!curr || typeof curr[0] !== 'number' || typeof curr[1] !== 'number') continue;
            if (distSq(curr, prev) > tolSq) {
                cleaned.push(curr);
            }
        }
        return cleaned;
    }

    // Canonical key generator for fast O(1) hash grouping
    function getCanonicalLineKey(coords, precision = 3) {
        if (!coords || coords.length < 2) return null;
        const len = coords.length;
        
        // Build forward & reverse string
        const fwdParts = [];
        const revParts = [];
        for (let i = 0; i < len; i++) {
            const pFwd = coords[i];
            const pRev = coords[len - 1 - i];
            fwdParts.push(`${pFwd[0].toFixed(precision)},${pFwd[1].toFixed(precision)}`);
            revParts.push(`${pRev[0].toFixed(precision)},${pRev[1].toFixed(precision)}`);
        }

        const strFwd = fwdParts.join(';');
        const strRev = revParts.join(';');
        const minStr = strFwd < strRev ? strFwd : strRev;
        return `${len}_${minStr}`;
    }

    // Check if two coordinate arrays match within tolerance in forward or reverse direction
    function areCoordsMatching(coordsA, coordsB, tol = 0.05) {
        if (!coordsA || !coordsB || coordsA.length !== coordsB.length) return false;
        const len = coordsA.length;
        if (len < 2) return false;

        const tolSq = tol * tol;

        // Check Forward direction
        let forwardMatch = true;
        for (let i = 0; i < len; i++) {
            if (distSq(coordsA[i], coordsB[i]) > tolSq) {
                forwardMatch = false;
                break;
            }
        }
        if (forwardMatch) return true;

        // Check Reverse direction
        let reverseMatch = true;
        for (let i = 0; i < len; i++) {
            if (distSq(coordsA[i], coordsB[len - 1 - i]) > tolSq) {
                reverseMatch = false;
                break;
            }
        }
        return reverseMatch;
    }

    // ===== COLLECT VECTOR LINE FEATURES FROM OPENLAYERS MAP =====
    function collectAllLineFeatures() {
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
                const src = layer.getSource?.();
                if (!src?.getFeatures) return;
                for (const f of src.getFeatures()) {
                    if (seenFeatureObjects.has(f)) continue;
                    seenFeatureObjects.add(f);

                    const geom = f.getGeometry?.();
                    if (!geom) continue;

                    const type = geom.getType?.();
                    if (type === 'LineString') {
                        const rawId = f.getId?.() || f.get?.('id') || f.get?.('_editId') || f.id_ || f._id;
                        const fId = rawId ? rawId.toString() : ('line_' + results.length);
                        if (rawId && seenFeatureIds.has(fId)) continue;
                        if (rawId) seenFeatureIds.add(fId);

                        const coords = geom.getCoordinates?.() || [];
                        const cleaned = sanitizeLineCoords(coords);
                        if (cleaned.length >= 2) {
                            results.push({
                                feature: f,
                                id: fId,
                                rawId: rawId,
                                name: (f.get?.('name') || f.get?.('Layer') || '').toString().trim(),
                                coords: cleaned,
                                originalCoords: coords,
                                geometry: geom,
                                layer: layer,
                                source: src
                            });
                        }
                    } else if (type === 'MultiLineString') {
                        const rawId = f.getId?.() || f.get?.('id') || f.get?.('_editId') || f.id_ || f._id;
                        const fId = rawId ? rawId.toString() : ('mline_' + results.length);
                        if (rawId && seenFeatureIds.has(fId)) continue;
                        if (rawId) seenFeatureIds.add(fId);

                        const lines = geom.getCoordinates?.() || [];
                        lines.forEach((lineCoords, subIdx) => {
                            const cleaned = sanitizeLineCoords(lineCoords);
                            if (cleaned.length >= 2) {
                                results.push({
                                    feature: f,
                                    id: fId,
                                    rawId: rawId,
                                    isMulti: true,
                                    subIndex: subIdx,
                                    totalSubs: lines.length,
                                    name: (f.get?.('name') || f.get?.('Layer') || '').toString().trim(),
                                    coords: cleaned,
                                    originalCoords: lineCoords,
                                    geometry: geom,
                                    layer: layer,
                                    source: src
                                });
                            }
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

    // ===== FIND ALL DUPLICATE LINE GROUPS =====
    async function findDuplicateLineGroups(options = {}) {
        const {
            tolerance = 0.05,
            precision = 3,
            onProgress = null
        } = options;

        if (onProgress) await onProgress(10, 'Đang thu thập các đối tượng đường trên bản đồ...');
        const allLineItems = collectAllLineFeatures();
        const total = allLineItems.length;

        if (total === 0) {
            return {
                totalLines: 0,
                duplicateGroups: [],
                totalDuplicatesToRemove: 0,
                keptCount: 0
            };
        }

        if (onProgress) await onProgress(30, `Đang chuẩn hóa và lập chỉ mục ${total} nét vẽ...`);

        // Group by canonical key
        const hashMap = new Map();
        for (let i = 0; i < total; i++) {
            const item = allLineItems[i];
            const key = getCanonicalLineKey(item.coords, precision);
            if (!key) continue;

            if (!hashMap.has(key)) {
                hashMap.set(key, []);
            }
            hashMap.get(key).push(item);

            if (i % 800 === 0) {
                await yieldToUI();
            }
        }

        if (onProgress) await onProgress(60, 'Đang so khớp chi tiết các nhóm đường trùng...');

        const duplicateGroups = [];
        let totalDuplicatesToRemove = 0;
        let processedKeys = 0;
        const totalKeys = hashMap.size;

        for (const [key, items] of hashMap.entries()) {
            processedKeys++;
            if (items.length < 2) continue;

            // Cluster items within the same bucket that match tolerance
            const visited = new Set();
            for (let i = 0; i < items.length; i++) {
                if (visited.has(i)) continue;
                const cluster = [items[i]];
                visited.add(i);

                for (let j = i + 1; j < items.length; j++) {
                    if (visited.has(j)) continue;
                    if (areCoordsMatching(items[i].coords, items[j].coords, tolerance)) {
                        cluster.push(items[j]);
                        visited.add(j);
                    }
                }

                if (cluster.length > 1) {
                    const primary = cluster[0];
                    const duplicates = cluster.slice(1);
                    duplicateGroups.push({
                        pointCount: primary.coords.length,
                        primaryItem: primary,
                        duplicateItems: duplicates,
                        totalInGroup: cluster.length,
                        sampleCoords: primary.coords
                    });
                    totalDuplicatesToRemove += duplicates.length;
                }
            }

            if (processedKeys % 300 === 0) {
                if (onProgress) {
                    const p = 60 + Math.floor((processedKeys / totalKeys) * 30);
                    await onProgress(p, `Đang phân tích nhóm trùng (${processedKeys}/${totalKeys})...`);
                } else {
                    await yieldToUI();
                }
            }
        }

        if (onProgress) await onProgress(100, `Hoàn thành quét: Tìm thấy ${duplicateGroups.length} nhóm trùng (${totalDuplicatesToRemove} đường dư thừa).`);

        return {
            totalLines: total,
            duplicateGroups,
            totalDuplicatesToRemove,
            keptCount: duplicateGroups.length
        };
    }

    // ===== EXECUTE DEDUP LINES (DELETE DUPLICATES, KEEP 1) =====
    async function executeDedupLines(options = {}) {
        const {
            tolerance = 0.05,
            precision = 3,
            onProgress = null
        } = options;

        const scanResult = await findDuplicateLineGroups({ tolerance, precision, onProgress });
        const { duplicateGroups, totalDuplicatesToRemove } = scanResult;

        if (!duplicateGroups || duplicateGroups.length === 0 || totalDuplicatesToRemove === 0) {
            return {
                deletedCount: 0,
                groupsCount: 0,
                totalLines: scanResult.totalLines,
                message: 'Không tìm thấy đường trùng nét nào.'
            };
        }

        if (onProgress) await onProgress(92, `Đang tiến hành xóa ${totalDuplicatesToRemove} đường trùng...`);

        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        const idsToDelete = new Set();
        const sourcesToRefresh = new Set();
        let deletedCount = 0;

        for (const group of duplicateGroups) {
            for (const dupItem of group.duplicateItems) {
                try {
                    // Remove from OpenLayers vector layer
                    if (dupItem.source && typeof dupItem.source.removeFeature === 'function') {
                        dupItem.source.removeFeature(dupItem.feature);
                        sourcesToRefresh.add(dupItem.source);
                        deletedCount++;
                    }
                    if (dupItem.id) {
                        idsToDelete.add(dupItem.id);
                    }
                    if (dupItem.rawId) {
                        idsToDelete.add(dupItem.rawId.toString());
                    }
                } catch (e) {
                    console.error('[DedupLines] Error removing feature:', e);
                }
            }
        }

        // Batch remove from React Fiber & Redux store in 1 synchronous tick
        if (idsToDelete.size > 0) {
            if (window.__topoRemoveFeaturesBatchFromReactState) {
                window.__topoRemoveFeaturesBatchFromReactState(idsToDelete);
            } else if (window.__topoRemoveFeatureFromReactState) {
                idsToDelete.forEach(id => window.__topoRemoveFeatureFromReactState(id));
            }
        }

        // Clean up corresponding DOM cards in left panel
        try {
            const cards = document.querySelectorAll('.border, [data-feature-id]');
            cards.forEach(c => {
                const text = c.textContent || '';
                idsToDelete.forEach(id => {
                    if (c.dataset?.featureId === id || text.includes(id)) {
                        c.style.opacity = '0';
                        setTimeout(() => { try { c.remove(); } catch(e){} }, 100);
                    }
                });
            });
        } catch (e) {}

        // Refresh OpenLayers sources & render map
        sourcesToRefresh.forEach(src => {
            try { if (typeof src.changed === 'function') src.changed(); } catch (e) {}
        });

        if (map && typeof map.render === 'function') {
            map.render();
        }

        log(`✅ Successfully removed ${deletedCount} duplicate lines across ${duplicateGroups.length} groups!`);

        return {
            deletedCount,
            groupsCount: duplicateGroups.length,
            totalLines: scanResult.totalLines,
            keptCount: scanResult.keptCount,
            idsDeleted: Array.from(idsToDelete)
        };
    }

    // Expose global APIs
    window.__topoFindDuplicateLines = findDuplicateLineGroups;
    window.__topoExecuteDedupLines = executeDedupLines;

})();
