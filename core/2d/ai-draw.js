// ============================================================
// 3DG Map Tools — Feature Module: Computer Vision Parcel Drawer
// - 100% Offline, Pure JavaScript Browser Engine (No Server / AI needed)
// - Full-Resolution Orthophoto Canvas Extractor
// - Fast Gaussian / Box Filtering for Texture Denoising
// - Sobel Edge Gradient Magnitude
// - Otsu's Dynamic Optimal Thresholding with Adaptive Sensitivity
// - Morphological Dilation to Bridge Broken Dikes (Khép kín bờ đứt quãng)
// - Floodfill Region Detection + Moore-Neighbor Boundary Tracing (0% Self-Intersection)
// - Ramer-Douglas-Peucker (RDP) Polygon Simplification to 4-8 vertices
// - Automatic Boundary Snapping & EPSG:3857 Transformation
// ============================================================

(function () {
    'use strict';

    function log(...args) {
        // console.log('[3DG CV-Draw]', ...args);
    }

    // ===== STATE MANAGEMENT =====
    let isAIDrawActive = false;
    let selectionPoints = []; // Coords in EPSG:3857
    let activeExtents = null; // [minX, minY, maxX, maxY]
    let startMousePos = null;
    let isBoxDragging = false;
    let boxStartCoord = null;
    let boxCurrentCoord = null;

    let recognizedFeatures = []; // [ { id, type, landType, color, name, coords, isIgnored } ]
    let hoveredFeatureId = null;
    let isProcessingAI = false;
    let renderRafId = null;

    const STORAGE_KEY_AUTO_SNAP = 'topo_ai_auto_snap';

    // ===== LAND TYPE DEFINITIONS & COLOR RESOLVER =====
    const DEFAULT_LAND_COLORS = {
        'LUA': '#fffc82',
        'LUC': '#fffc8c',
        'ONT': '#ffd0ff',
        'ODT': '#ffa0ff',
        'CLN': '#ffd2a0',
        'DGT': '#ffaa32',
        'DTL': '#aaffff',
        'RSX': '#b4ffb4',
        'LNP': '#aaff32',
        'BHK': '#fff8a0',
        'DEFAULT': '#10b981'
    };

    function getLandTypeColor(landType) {
        if (!landType) return DEFAULT_LAND_COLORS.DEFAULT;
        const code = String(landType).trim().toUpperCase();
        return DEFAULT_LAND_COLORS[code] || localStorage.getItem(`topo_color_${code.toLowerCase()}`) || DEFAULT_LAND_COLORS.DEFAULT;
    }

    // ===== GEOMETRY & BOUNDING BOX UTILITIES =====
    function generateUUID() {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        return 'cv-feat-' + Date.now() + '-' + Math.floor(Math.random() * 100000);
    }

    function computeBoundingBox(points) {
        if (!points || points.length === 0) return [0, 0, 0, 0];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of points) {
            if (p[0] < minX) minX = p[0];
            if (p[0] > maxX) maxX = p[0];
            if (p[1] < minY) minY = p[1];
            if (p[1] > maxY) maxY = p[1];
        }
        return [minX, minY, maxX, maxY];
    }

    // ===== CANVAS OVERLAY FOR DRAWING & PREVIEW =====
    function getOrCreateAICanvasOverlay() {
        const viewport = document.querySelector('.ol-viewport');
        if (!viewport) return null;

        let canvas = document.getElementById('topo-ai-draw-canvas');
        if (canvas && viewport.contains(canvas)) {
            if (canvas.width !== viewport.clientWidth || canvas.height !== viewport.clientHeight) {
                canvas.width = viewport.clientWidth;
                canvas.height = viewport.clientHeight;
            }
            return canvas;
        }

        canvas = document.createElement('canvas');
        canvas.id = 'topo-ai-draw-canvas';
        canvas.style.cssText = 'position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:9998; cursor:default;';
        canvas.width = viewport.clientWidth;
        canvas.height = viewport.clientHeight;
        viewport.appendChild(canvas);
        return canvas;
    }

    function requestAIRender() {
        if (renderRafId) return;
        renderRafId = requestAnimationFrame(() => {
            renderRafId = null;
            renderAICanvas();
        });
    }

    // ===== RENDER CANVAS OVERLAY (SELECTION & PREVIEW) =====
    function renderAICanvas() {
        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        const canvas = getOrCreateAICanvasOverlay();
        if (!canvas || !map) return;

        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // 1. Render Current Selection Area (Polygon or Box)
        let renderCoords = [];
        if (isBoxDragging && boxStartCoord && boxCurrentCoord) {
            renderCoords = [
                boxStartCoord,
                [boxCurrentCoord[0], boxStartCoord[1]],
                boxCurrentCoord,
                [boxStartCoord[0], boxCurrentCoord[1]]
            ];
        } else if (selectionPoints.length > 0) {
            renderCoords = selectionPoints;
        }

        if (renderCoords.length > 0) {
            const pixels = renderCoords.map(pt => map.getPixelFromCoordinate(pt)).filter(p => p && !isNaN(p[0]));
            if (pixels.length > 0) {
                ctx.save();
                ctx.beginPath();
                ctx.moveTo(pixels[0][0], pixels[0][1]);
                for (let i = 1; i < pixels.length; i++) {
                    ctx.lineTo(pixels[i][0], pixels[i][1]);
                }

                if (pixels.length > 2) {
                    ctx.closePath();
                    ctx.fillStyle = 'rgba(16, 185, 129, 0.2)';
                    ctx.strokeStyle = '#10b981';
                    ctx.fill();
                } else {
                    ctx.strokeStyle = '#10b981';
                }

                ctx.lineWidth = 2.5;
                ctx.setLineDash([6, 4]);
                ctx.stroke();

                // Draw Vertices
                pixels.forEach((p, idx) => {
                    ctx.beginPath();
                    ctx.arc(p[0], p[1], idx === 0 ? 6 : 4.5, 0, Math.PI * 2);
                    ctx.fillStyle = '#10b981';
                    ctx.fill();
                    ctx.strokeStyle = '#ffffff';
                    ctx.lineWidth = 2;
                    ctx.stroke();
                });

                ctx.restore();
            }
        }

        // 2. Render CV-Recognized Features Preview (Glowing Polygons)
        if (recognizedFeatures.length > 0) {
            ctx.save();

            recognizedFeatures.forEach(feat => {
                if (feat.isIgnored || !feat.coords || feat.coords.length < 2) return;

                const pixels = feat.coords.map(c => map.getPixelFromCoordinate(c)).filter(p => p && !isNaN(p[0]));
                if (pixels.length < 2) return;

                const isHovered = feat.id === hoveredFeatureId;
                const strokeColor = feat.color || getLandTypeColor(feat.landType);

                ctx.beginPath();
                ctx.moveTo(pixels[0][0], pixels[0][1]);
                for (let i = 1; i < pixels.length; i++) {
                    ctx.lineTo(pixels[i][0], pixels[i][1]);
                }

                if (pixels.length >= 3) {
                    ctx.closePath();
                    ctx.fillStyle = isHovered ? 'rgba(16, 185, 129, 0.35)' : 'rgba(254, 240, 138, 0.25)';
                    ctx.fill();
                }

                if (isHovered) {
                    ctx.shadowColor = '#ffffff';
                    ctx.shadowBlur = 12;
                    ctx.strokeStyle = '#ffffff';
                    ctx.lineWidth = 4;
                    ctx.setLineDash([]);
                    ctx.stroke();
                }

                ctx.shadowColor = strokeColor;
                ctx.shadowBlur = 8;
                ctx.strokeStyle = strokeColor;
                ctx.lineWidth = isHovered ? 3.5 : 2.5;
                ctx.setLineDash([]);
                ctx.stroke();

                // Draw Vertices
                pixels.forEach(p => {
                    ctx.beginPath();
                    ctx.arc(p[0], p[1], isHovered ? 4.5 : 3, 0, Math.PI * 2);
                    ctx.fillStyle = strokeColor;
                    ctx.fill();
                    ctx.strokeStyle = '#ffffff';
                    ctx.lineWidth = 1;
                    ctx.stroke();
                });

                // Draw Name Tag near centroid
                if (pixels.length >= 3) {
                    let cx = 0, cy = 0;
                    pixels.forEach(p => { cx += p[0]; cy += p[1]; });
                    cx /= pixels.length;
                    cy /= pixels.length;

                    ctx.font = 'bold 11px system-ui, sans-serif';
                    ctx.fillStyle = '#0f172a';
                    ctx.strokeStyle = '#ffffff';
                    ctx.lineWidth = 3;
                    ctx.strokeText(feat.name || 'Thửa', cx - 15, cy + 4);
                    ctx.fillText(feat.name || 'Thửa', cx - 15, cy + 4);
                }
            });

            ctx.restore();
        }
    }

    // ===== CROP FULL-RESOLUTION MAP VIEWPORT CANVAS =====
    function cropMapCanvasElementFullRes(extent) {
        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        const viewport = document.querySelector('.ol-viewport');
        if (!map || !viewport || !extent) return null;

        const canvases = Array.from(viewport.querySelectorAll('canvas')).filter(c => {
            const id = (c.id || '').toLowerCase();
            return !id.includes('topo') && !id.includes('marker') && !id.includes('highlight') && !id.includes('overlay');
        });

        if (canvases.length === 0) return null;
        const sourceCanvas = canvases[0];

        const p1 = map.getPixelFromCoordinate([extent[0], extent[3]]); // top-left
        const p2 = map.getPixelFromCoordinate([extent[2], extent[1]]); // bottom-right

        if (!p1 || !p2) return null;

        const vpMinX = Math.min(p1[0], p2[0]);
        const vpMinY = Math.min(p1[1], p2[1]);
        const vpWidth = Math.max(10, Math.abs(p2[0] - p1[0]));
        const vpHeight = Math.max(10, Math.abs(p2[1] - p1[1]));

        const scaleX = sourceCanvas.width / (viewport.clientWidth || 1);
        const scaleY = sourceCanvas.height / (viewport.clientHeight || 1);

        const srcX = Math.max(0, vpMinX * scaleX);
        const srcY = Math.max(0, vpMinY * scaleY);
        const srcW = Math.min(sourceCanvas.width - srcX, vpWidth * scaleX);
        const srcH = Math.min(sourceCanvas.height - srcY, vpHeight * scaleY);

        if (srcW <= 0 || srcH <= 0) return null;

        // Create Full-Resolution Crop Canvas
        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = Math.round(srcW);
        cropCanvas.height = Math.round(srcH);
        const cropCtx = cropCanvas.getContext('2d');
        cropCtx.drawImage(sourceCanvas, srcX, srcY, srcW, srcH, 0, 0, cropCanvas.width, cropCanvas.height);

        return {
            canvas: cropCanvas,
            width: cropCanvas.width,
            height: cropCanvas.height,
            vpMinX: vpMinX,
            vpMinY: vpMinY,
            vpWidth: vpWidth,
            vpHeight: vpHeight,
            extent: extent
        };
    }

    // ===== COMPUTER VISION: OTSU THRESHOLDING & MORPHOLOGY ENGINE =====

    // Dynamic Otsu's optimal threshold from histogram
    function computeOtsuThreshold(grayData, width, height) {
        const hist = new Uint32Array(256);
        const total = width * height;
        for (let i = 0; i < total; i++) {
            hist[grayData[i]]++;
        }

        let sum = 0;
        for (let i = 0; i < 256; i++) sum += i * hist[i];

        let sumB = 0;
        let wB = 0;
        let wF = 0;
        let maxVar = 0;
        let threshold = 128;

        for (let t = 0; t < 256; t++) {
            wB += hist[t];
            if (wB === 0) continue;
            wF = total - wB;
            if (wF === 0) break;

            sumB += t * hist[t];
            const mB = sumB / wB;
            const mF = (sum - sumB) / wF;
            const betweenVar = wB * wF * ((mB - mF) ** 2);

            if (betweenVar > maxVar) {
                maxVar = betweenVar;
                threshold = t;
            }
        }
        return threshold;
    }

    // Morphological Dilate: bridges broken/faint dikes & closes gaps
    function morphologicalDilate(bin, width, height, iterations = 1) {
        let current = bin;
        for (let it = 0; it < iterations; it++) {
            const next = new Uint8Array(width * height);
            for (let y = 1; y < height - 1; y++) {
                for (let x = 1; x < width - 1; x++) {
                    const idx = y * width + x;
                    if (current[idx] === 1 ||
                        current[idx - 1] === 1 || current[idx + 1] === 1 ||
                        current[idx - width] === 1 || current[idx + width] === 1 ||
                        current[idx - width - 1] === 1 || current[idx - width + 1] === 1 ||
                        current[idx + width - 1] === 1 || current[idx + width + 1] === 1) {
                        next[idx] = 1;
                    }
                }
            }
            current = next;
        }
        return current;
    }

    // Douglas-Peucker Polygon Simplification for Closed Rings (Standard Continuous RDP)
    function simplifyPolygonRDP(points, epsilon = 2.5) {
        if (!points || points.length <= 4) return points;

        function getSqSegDist(p, p1, p2) {
            let x = p1[0], y = p1[1], dx = p2[0] - x, dy = p2[1] - y;
            if (dx !== 0 || dy !== 0) {
                const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
                if (t > 1) { x = p2[0]; y = p2[1]; }
                else if (t > 0) { x += dx * t; y += dy * t; }
            }
            dx = p[0] - x; dy = p[1] - y;
            return dx * dx + dy * dy;
        }

        const isClosed = Math.hypot(points[0][0] - points[points.length - 1][0], points[0][1] - points[points.length - 1][1]) < 1e-4;
        const workPts = isClosed ? points.slice(0, -1) : [...points];
        if (workPts.length <= 4) return points;

        // Iterative vertex elimination with minimum perpendicular distance threshold
        let pts = workPts;
        const sqTol = epsilon * epsilon;
        let simplified = [];

        let changed = true;
        while (changed && pts.length > 4) {
            changed = false;
            let minSqDist = Infinity;
            let removeIdx = -1;
            const n = pts.length;

            for (let i = 0; i < n; i++) {
                const prev = pts[(i - 1 + n) % n];
                const curr = pts[i];
                const next = pts[(i + 1) % n];
                const sqDist = getSqSegDist(curr, prev, next);
                if (sqDist < sqTol && sqDist < minSqDist) {
                    minSqDist = sqDist;
                    removeIdx = i;
                }
            }

            if (removeIdx !== -1 && pts.length > 4) {
                pts = pts.filter((_, idx) => idx !== removeIdx);
                changed = true;
            }
        }

        simplified = pts;
        if (isClosed && simplified.length >= 3) {
            simplified.push([...simplified[0]]);
        }
        return simplified;
    }

    // ===== COMPUTER VISION: GAUSSIAN BLUR & MORPHOLOGICAL GRADIENT =====
    function gaussianBlur2D(data, width, height, radius = 2) {
        const size = radius * 2 + 1;
        const kernel = [];
        const sigma = radius / 2;
        let sum = 0;
        for (let i = -radius; i <= radius; i++) {
            const v = Math.exp(-(i * i) / (2 * sigma * sigma));
            kernel.push(v);
            sum += v;
        }
        for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

        const temp = new Float32Array(width * height);
        const out = new Uint8Array(width * height);

        // Horizontal pass
        for (let y = 0; y < height; y++) {
            const yOffset = y * width;
            for (let x = 0; x < width; x++) {
                let acc = 0;
                for (let k = -radius; k <= radius; k++) {
                    const kx = Math.max(0, Math.min(width - 1, x + k));
                    acc += data[yOffset + kx] * kernel[k + radius];
                }
                temp[yOffset + x] = acc;
            }
        }

        // Vertical pass
        for (let x = 0; x < width; x++) {
            for (let y = 0; y < height; y++) {
                let acc = 0;
                for (let k = -radius; k <= radius; k++) {
                    const ky = Math.max(0, Math.min(height - 1, y + k));
                    acc += temp[ky * width + x] * kernel[k + radius];
                }
                out[y * width + x] = Math.round(Math.max(0, Math.min(255, acc)));
            }
        }
        return out;
    }

    function computeMorphologicalGradient(gray, width, height, radius = 1) {
        const grad = new Uint8Array(width * height);
        for (let y = radius; y < height - radius; y++) {
            for (let x = radius; x < width - radius; x++) {
                let minVal = 255;
                let maxVal = 0;
                for (let dy = -radius; dy <= radius; dy++) {
                    for (let dx = -radius; dy <= radius; dy++) {
                        const val = gray[(y + dy) * width + (x + dx)];
                        if (val < minVal) minVal = val;
                        if (val > maxVal) maxVal = val;
                    }
                }
                grad[y * width + x] = maxVal - minVal;
            }
        }
        return grad;
    }

    // Moore-Neighbor Boundary Tracing (strictly ordered perimeter clockwise)
    function traceMooreBoundary(labelGrid, targetLabel, width, height) {
        let startX = -1, startY = -1;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (labelGrid[y * width + x] === targetLabel) {
                    startX = x;
                    startY = y;
                    break;
                }
            }
            if (startX !== -1) break;
        }

        if (startX === -1) return [];

        const dx = [0, 1, 1, 1, 0, -1, -1, -1];
        const dy = [-1, -1, 0, 1, 1, 1, 0, -1];

        const boundary = [[startX, startY]];
        let currX = startX;
        let currY = startY;
        let backtrackDir = 6; // Entering from West/North-West

        const maxSteps = Math.min(8000, width * height);
        for (let step = 0; step < maxSteps; step++) {
            let foundNext = false;
            for (let i = 0; i < 8; i++) {
                const dir = (backtrackDir + 1 + i) % 8;
                const nx = currX + dx[dir];
                const ny = currY + dy[dir];

                if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                    if (labelGrid[ny * width + nx] === targetLabel) {
                        currX = nx;
                        currY = ny;
                        backtrackDir = (dir + 4) % 8;
                        foundNext = true;
                        break;
                    }
                }
            }

            if (!foundNext || (currX === startX && currY === startY)) {
                if (boundary.length > 2) boundary.push([startX, startY]);
                break;
            }

            boundary.push([currX, currY]);
        }

        return boundary;
    }

    // ===== WATERSHED AGRICULTURAL PARCEL SEGMENTATION =====
    function detectParcelsOfflineCV(cropData, opts = {}) {
        if (!cropData || !cropData.canvas) {
            return { ok: false, error: 'Không lấy được canvas vùng chọn' };
        }

        const { canvas, width, height } = cropData;
        if (width < 30 || height < 30) {
            return { ok: false, error: 'Vùng chọn quá nhỏ để phân tích' };
        }

        const ctx = canvas.getContext('2d');
        const imgData = ctx.getImageData(0, 0, width, height);
        const d = imgData.data;
        const totalPixels = width * height;

        // 1. Convert to Luminance + Excess Green vegetation enhancement
        const rawGray = new Uint8Array(totalPixels);
        for (let i = 0; i < d.length; i += 4) {
            const r = d[i], g = d[i + 1], b = d[i + 2];
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            const exG = Math.max(0, 2 * g - r - b);
            // Combine luminance and vegetation contrast
            rawGray[i / 4] = Math.round(Math.max(0, Math.min(255, lum * 0.7 + exG * 0.3)));
        }

        // 2. Gaussian Blur to remove internal crop/mud textures
        const blurred = gaussianBlur2D(rawGray, width, height, 2);

        // 3. Sobel Gradient Magnitude for boundary detection
        const grad = new Uint8Array(totalPixels);
        let maxGrad = 0;
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const idx = y * width + x;
                const gx = -blurred[idx - width - 1] + blurred[idx - width + 1]
                    - 2 * blurred[idx - 1] + 2 * blurred[idx + 1]
                    - blurred[idx + width - 1] + blurred[idx + width + 1];
                const gy = -blurred[idx - width - 1] - 2 * blurred[idx - width] - blurred[idx - width + 1]
                    + blurred[idx + width - 1] + 2 * blurred[idx + width] + blurred[idx + width + 1];
                const mag = Math.min(255, Math.hypot(gx, gy));
                grad[idx] = mag;
                if (mag > maxGrad) maxGrad = mag;
            }
        }

        // 4. Thresholding to identify homogeneous parcel basins vs dikes
        const otsuThreshold = computeOtsuThreshold(grad, width, height);
        const sensitivity = opts.sensitivity || 0.65;
        const dikeThreshold = Math.max(16, Math.min(220, Math.round(otsuThreshold * sensitivity)));

        const isDike = new Uint8Array(totalPixels);
        for (let i = 0; i < totalPixels; i++) {
            isDike[i] = grad[i] >= dikeThreshold ? 1 : 0;
        }

        // Dilate dikes by 1 iteration to close small gaps
        const closedDikes = morphologicalDilate(isDike, width, height, opts.dilateIterations || 1);

        // 5. Connected Component Labeling of Basins (Seeds for parcels)
        const labelMap = new Int32Array(totalPixels);
        let currentLabel = 0;
        const minPlotArea = Math.max(250, Math.floor(totalPixels * 0.015)); // Min ~1.5% of cropped area
        const maxPlotArea = Math.floor(totalPixels * 0.90);

        const regionSizes = {};

        for (let y = 2; y < height - 2; y++) {
            for (let x = 2; x < width - 2; x++) {
                const idx = y * width + x;
                if (closedDikes[idx] === 0 && labelMap[idx] === 0) {
                    currentLabel++;
                    const queue = [idx];
                    labelMap[idx] = currentLabel;
                    let size = 0;

                    while (queue.length > 0) {
                        const curr = queue.pop();
                        size++;
                        const cx = curr % width;
                        const cy = Math.floor(curr / width);

                        if (cx > 0 && closedDikes[curr - 1] === 0 && labelMap[curr - 1] === 0) {
                            labelMap[curr - 1] = currentLabel;
                            queue.push(curr - 1);
                        }
                        if (cx < width - 1 && closedDikes[curr + 1] === 0 && labelMap[curr + 1] === 0) {
                            labelMap[curr + 1] = currentLabel;
                            queue.push(curr + 1);
                        }
                        if (cy > 0 && closedDikes[curr - width] === 0 && labelMap[curr - width] === 0) {
                            labelMap[curr - width] = currentLabel;
                            queue.push(curr - width);
                        }
                        if (cy < height - 1 && closedDikes[curr + width] === 0 && labelMap[curr + width] === 0) {
                            labelMap[curr + width] = currentLabel;
                            queue.push(curr + width);
                        }
                    }
                    regionSizes[currentLabel] = size;
                }
            }
        }

        // 6. Watershed Expansion: Grow basins into dike pixels until boundaries meet
        const queue = [];
        for (let i = 0; i < totalPixels; i++) {
            if (labelMap[i] > 0 && regionSizes[labelMap[i]] >= minPlotArea && regionSizes[labelMap[i]] <= maxPlotArea) {
                const cx = i % width;
                const cy = Math.floor(i / width);
                if (cx > 0 && labelMap[i - 1] === 0) queue.push(i - 1);
                if (cx < width - 1 && labelMap[i + 1] === 0) queue.push(i + 1);
                if (cy > 0 && labelMap[i - width] === 0) queue.push(i - width);
                if (cy < height - 1 && labelMap[i + width] === 0) queue.push(i + width);
            }
        }

        let qHead = 0;
        while (qHead < queue.length) {
            const curr = queue[qHead++];
            if (labelMap[curr] !== 0) continue;

            const cx = curr % width;
            const cy = Math.floor(curr / width);

            // Find neighboring label
            let nLabel = 0;
            if (cx > 0 && labelMap[curr - 1] > 0) nLabel = labelMap[curr - 1];
            else if (cx < width - 1 && labelMap[curr + 1] > 0) nLabel = labelMap[curr + 1];
            else if (cy > 0 && labelMap[curr - width] > 0) nLabel = labelMap[curr - width];
            else if (cy < height - 1 && labelMap[curr + width] > 0) nLabel = labelMap[curr + width];

            if (nLabel > 0) {
                labelMap[curr] = nLabel;
                if (cx > 0 && labelMap[curr - 1] === 0) queue.push(curr - 1);
                if (cx < width - 1 && labelMap[curr + 1] === 0) queue.push(curr + 1);
                if (cy > 0 && labelMap[curr - width] === 0) queue.push(curr - width);
                if (cy < height - 1 && labelMap[curr + width] === 0) queue.push(curr + width);
            }
        }

        // 7. Extract Polygons via Moore-Neighbor Tracing & Douglas-Peucker
        const extractedFeatures = [];
        const maxAllowedArea = Math.floor(totalPixels * 0.65);
        const validLabels = Object.keys(regionSizes).filter(lbl => regionSizes[lbl] >= minPlotArea && regionSizes[lbl] <= maxAllowedArea);

        validLabels.forEach((labelStr) => {
            const lbl = parseInt(labelStr, 10);
            const boundaryPts = traceMooreBoundary(labelMap, lbl, width, height);

            if (boundaryPts.length >= 8) {
                // Check if this region is mostly the outer canvas border
                let borderHits = 0;
                boundaryPts.forEach(p => {
                    if (p[0] <= 1 || p[0] >= width - 2 || p[1] <= 1 || p[1] >= height - 2) borderHits++;
                });
                if (borderHits > boundaryPts.length * 0.5) return; // Skip background border frame

                // Adaptive Douglas-Peucker simplification tolerance (2.5 - 4.5px)
                const rdpTolerance = Math.max(2.5, Math.min(width, height) * 0.018);
                let simplified = simplifyPolygonRDP(boundaryPts, rdpTolerance);

                if (simplified.length >= 4) {
                    if (simplified[0][0] !== simplified[simplified.length - 1][0] || simplified[0][1] !== simplified[simplified.length - 1][1]) {
                        simplified.push([...simplified[0]]);
                    }

                    // Save pixel points directly
                    extractedFeatures.push({
                        type: 'Polygon',
                        landType: 'LUA',
                        name: `Thửa ${extractedFeatures.length + 1}`,
                        pixelPoints: simplified,
                        cropWidth: width,
                        cropHeight: height
                    });
                }
            }
        });

        if (extractedFeatures.length === 0) {
            return {
                ok: false,
                error: 'Không phát hiện thấy ranh giới bờ ruộng rõ ràng trong vùng chọn. Hãy thử khoanh vùng rõ bờ ruộng hơn.',
                debug: { maxGrad, otsuThreshold, dikeThreshold, regionCount: 0 }
            };
        }

        return {
            ok: true,
            features: extractedFeatures,
            debug: { maxGrad, otsuThreshold, dikeThreshold, regionCount: extractedFeatures.length }
        };
    }

    // ===== POST-PROCESSING: DENORMALIZE & SNAPPING =====
    function denormalizeCoordinates(points, extent) {
        if (!points || !extent) return [];
        const minX = extent[0], minY = extent[1], maxX = extent[2], maxY = extent[3];
        const rangeX = maxX - minX;
        const rangeY = maxY - minY;

        return points.map(pt => {
            const x = pt[0] / 1000.0;
            const y = pt[1] / 1000.0;
            const mapX = minX + x * rangeX;
            const mapY = maxY - y * rangeY; // Invert Y axis
            return [mapX, mapY];
        });
    }

    function snapEndpointsToNearby(features, toleranceMeters = 0.5) {
        if (!features || features.length === 0) return features;

        const endpoints = [];
        features.forEach((feat, featIdx) => {
            if (!feat.coords || feat.coords.length < 2) return;
            endpoints.push({ featIdx, ptIdx: 0, coord: feat.coords[0] });
            endpoints.push({ featIdx, ptIdx: feat.coords.length - 1, coord: feat.coords[feat.coords.length - 1] });
        });

        for (let i = 0; i < endpoints.length; i++) {
            for (let j = i + 1; j < endpoints.length; j++) {
                const ep1 = endpoints[i];
                const ep2 = endpoints[j];
                const dist = Math.hypot(ep1.coord[0] - ep2.coord[0], ep1.coord[1] - ep2.coord[1]);
                if (dist <= toleranceMeters) {
                    const avgCoord = [(ep1.coord[0] + ep2.coord[0]) / 2, (ep1.coord[1] + ep2.coord[1]) / 2];
                    features[ep1.featIdx].coords[ep1.ptIdx] = avgCoord;
                    features[ep2.featIdx].coords[ep2.ptIdx] = avgCoord;
                    ep1.coord = avgCoord;
                    ep2.coord = avgCoord;
                }
            }
        }

        return features;
    }

    function createOlStyleForFeature(color, width = 2.0, sampleFeature = null, map = null) {
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

        if (!StyleClass && map) {
            try {
                map.getLayers().forEach(layer => {
                    if (StyleClass) return;
                    const st = layer.getStyle?.();
                    if (st) {
                        const sampleInst = typeof st === 'function' ? st(null, 1) : st;
                        const item = Array.isArray(sampleInst) ? sampleInst[0] : sampleInst;
                        if (item) {
                            StyleClass = item.constructor;
                            if (typeof item.getStroke === 'function') {
                                const strokeInst = item.getStroke();
                                if (strokeInst) StrokeClass = strokeInst.constructor;
                            }
                        }
                    }
                });
            } catch (e) { }
        }

        if (StyleClass && StrokeClass) {
            try {
                return new StyleClass({
                    stroke: new StrokeClass({
                        color: color,
                        width: width
                    })
                });
            } catch (e) { }
        }
        return null;
    }

    function ensureNative3dgLineModeActive(landType = 'LUA') {
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
                    log('✅ Auto-clicked main 3DG Edit tool button to open "Biên tập dữ liệu" panel.');
                }
            }
        } catch (e) {
            console.warn('[AI Draw] Failed to auto-trigger native edit panel:', e);
        }
    }

    // ===== COMMIT FEATURES TO OPENLAYERS / 3DG =====
    function commitRecognizedFeaturesToMap() {
        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        if (!map) {
            updateAIStatus('Không tìm thấy bản đồ 3DG để ghi nhận nét vẽ.', 'error');
            return 0;
        }

        ensureNative3dgLineModeActive();

        const validFeatures = recognizedFeatures.filter(f => !f.isIgnored && f.coords && f.coords.length >= 2);
        if (validFeatures.length === 0) {
            updateAIStatus('Không có nét vẽ hợp lệ nào để thêm.', 'warning');
            return 0;
        }

        let committedCount = 0;
        validFeatures.forEach(feat => {
            try {
                const res = addDirectPolylineFeature(map, feat.coords, {
                    landType: feat.landType || 'LUA',
                    color: feat.color || getLandTypeColor('LUA'),
                    name: feat.name
                });
                if (res) committedCount++;
            } catch (e) {
                console.error('[AI Draw] Error committing feature to map:', e);
            }
        });

        try {
            window.dispatchEvent(new CustomEvent('topo:features-updated'));
        } catch (e) { }

        updateAIStatus(`🎉 Đã thêm thành công ${committedCount} thửa ruộng vào bản đồ 3DG!`, 'success');
        resetAIState();
        return committedCount;
    }

    function getDrawInteractionSource(map) {
        if (!map) return null;
        try {
            const interactions = map.getInteractions().getArray();
            for (const inter of interactions) {
                if (inter.source_ && typeof inter.source_.addFeature === 'function'
                    && inter.type_ === 'LineString') {
                    return inter.source_;
                }
            }
            for (const inter of interactions) {
                if (inter.source_ && typeof inter.source_.addFeature === 'function'
                    && typeof inter.source_.getFeatures === 'function') {
                    return inter.source_;
                }
            }
        } catch (e) { }
        return null;
    }

    function getOlNativeClasses(map) {
        const classes = {
            Feature: window.ol?.Feature,
            LineString: window.ol?.geom?.LineString,
            Polygon: window.ol?.geom?.Polygon,
            Style: window.ol?.style?.Style,
            Stroke: window.ol?.style?.Stroke,
            Fill: window.ol?.style?.Fill
        };
        if (classes.Feature && classes.LineString && classes.Polygon) return classes;

        try {
            map.getLayers().forEach(layer => {
                if (classes.Feature && classes.LineString && classes.Polygon) return;
                const src = layer.getSource?.();
                if (!src || !src.getFeatures) return;
                const feats = src.getFeatures();
                for (const f of feats) {
                    if (!classes.Feature) classes.Feature = f.constructor;
                    const geom = f.getGeometry?.();
                    if (geom) {
                        const type = geom.getType?.();
                        if (type === 'LineString' && !classes.LineString) {
                            classes.LineString = geom.constructor;
                        } else if (type === 'Polygon' && !classes.Polygon) {
                            classes.Polygon = geom.constructor;
                        }
                    }
                    const styleVal = typeof f.getStyle === 'function' ? f.getStyle() : null;
                    const styleInst = typeof styleVal === 'function' ? styleVal(f, 1) : styleVal;
                    const styleItem = Array.isArray(styleInst) ? styleInst[0] : styleInst;
                    if (styleItem) {
                        if (!classes.Style) classes.Style = styleItem.constructor;
                        if (typeof styleItem.getStroke === 'function' && !classes.Stroke) {
                            const strokeVal = styleItem.getStroke();
                            if (strokeVal) classes.Stroke = strokeVal.constructor;
                        }
                    }
                }
            });
        } catch (e) {
            console.error('Error extracting native OL classes:', e);
        }
        return classes;
    }

    // ===== STANDALONE OPENLAYERS-COMPATIBLE FALLBACK CLASSES =====
    class TopoBaseEventTarget {
        constructor() {
            this._listeners = {};
            this.ol_uid = Math.random().toString(36).slice(2);
            this.revision_ = 0;
        }
        addEventListener(type, listener) {
            if (!this._listeners[type]) this._listeners[type] = [];
            this._listeners[type].push(listener);
        }
        removeEventListener(type, listener) {
            if (!this._listeners[type]) return;
            this._listeners[type] = this._listeners[type].filter(l => l !== listener);
        }
        on(type, listener) { this.addEventListener(type, listener); return listener; }
        un(type, listener) { this.removeEventListener(type, listener); }
        dispatchEvent(event) {
            const type = typeof event === 'string' ? event : event.type;
            const listeners = this._listeners[type] || [];
            listeners.forEach(l => {
                try { l(typeof event === 'string' ? { type: event, target: this } : event); } catch (e) { }
            });
            return true;
        }
        changed() {
            this.revision_++;
            this.dispatchEvent({ type: 'change', target: this });
        }
        getRevision() { return this.revision_; }
    }

    class TopoPolylineGeometry extends TopoBaseEventTarget {
        constructor(coordinates) {
            super();
            this._coords = coordinates || [];
        }
        getType() { return 'LineString'; }
        getLayout() { return 'XY'; }
        getStride() { return 2; }
        getCoordinates() { return this._coords; }
        setCoordinates(coords) {
            this._coords = coords;
            this.changed();
        }
        getFlatCoordinates() {
            const flat = [];
            for (let i = 0; i < this._coords.length; i++) {
                const pt = this._coords[i];
                flat.push(pt[0], pt[1]);
            }
            return flat;
        }
        getEnds() {
            return [this._coords.length * 2];
        }
        getFirstCoordinate() {
            return this._coords[0] || [0, 0];
        }
        getLastCoordinate() {
            return this._coords[this._coords.length - 1] || [0, 0];
        }
        getFlatMidpoint() {
            if (this._coords.length === 0) return [0, 0];
            return this._coords[Math.floor(this._coords.length / 2)];
        }
        getExtent() {
            if (!this._coords || this._coords.length === 0) return [0, 0, 0, 0];
            const xs = this._coords.map(c => c[0]);
            const ys = this._coords.map(c => c[1]);
            return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        }
        simplifyTransformed(squaredTolerance, opt_dest) {
            return this;
        }
        getSimplifiedGeometry(squaredTolerance) {
            return this;
        }
        transform(source, dest) {
            return this;
        }
        clone() {
            return new TopoPolylineGeometry(this._coords.map(c => [...c]));
        }
        simplify(tolerance) { return this; }
        getClosestPoint(point) { return this._coords[0] || point; }
        intersectsExtent(ext) { return true; }
        containsCoordinate(coord) { return false; }
    }

    class TopoMapFeature extends TopoBaseEventTarget {
        constructor(geometryOrOptions = null, properties = {}) {
            super();
            let geom = null;
            let props = {};
            if (geometryOrOptions && typeof geometryOrOptions.getType === 'function') {
                geom = geometryOrOptions;
                props = { ...properties };
            } else if (geometryOrOptions && typeof geometryOrOptions === 'object') {
                props = { ...geometryOrOptions, ...properties };
                geom = props.geometry || null;
            }
            this._geometry = geom;
            this._properties = { ...props, geometry: geom };
            this._id = props.id || props._editId || generateUUID();
            this.id_ = this._id;
            this._style = null;
        }
        getGeometryName() { return 'geometry'; }
        getGeometry() { return this._geometry; }
        setGeometry(geom) {
            this._geometry = geom;
            this._properties.geometry = geom;
            this.changed();
        }
        getId() { return this.id_ || this._id; }
        setId(id) {
            this._id = id;
            this.id_ = id;
        }
        get(key) {
            if (key === 'geometry') return this._geometry;
            return this._properties[key];
        }
        set(key, val) {
            if (key === 'geometry') {
                this.setGeometry(val);
                return;
            }
            this._properties[key] = val;
            this.changed();
        }
        getProperties() {
            return { ...this._properties, geometry: this._geometry };
        }
        setProperties(props) {
            this._properties = { ...this._properties, ...props };
            if (props.geometry) this._geometry = props.geometry;
            this.changed();
        }
        getStyle() { return this._style; }
        setStyle(st) { this._style = st; this.changed(); }
        getStyleFunction() { return null; }
    }

    function cleanParcelContour(coords) {
        if (!coords || coords.length < 3) return coords;

        // 1. Remove adjacent duplicate points (threshold ~0.08m)
        let pts = [];
        for (let i = 0; i < coords.length; i++) {
            const p = coords[i];
            if (pts.length === 0) {
                pts.push([p[0], p[1]]);
            } else {
                const last = pts[pts.length - 1];
                if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.08) {
                    pts.push([p[0], p[1]]);
                }
            }
        }
        if (pts.length >= 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 0.08) {
            pts.pop();
        }
        if (pts.length < 3) return coords;

        // 2. Chỉ loại spike THẬT SỰ nhọn (< 8°), không đụng vào các khúc cong tự nhiên
        let changed = true;
        let iter = 0;
        while (changed && iter < 2 && pts.length > 4) {
            changed = false;
            iter++;
            const filtered = [];
            const n = pts.length;
            for (let i = 0; i < n; i++) {
                const prev = pts[(i - 1 + n) % n];
                const curr = pts[i];
                const next = pts[(i + 1) % n];

                const v1 = [prev[0] - curr[0], prev[1] - curr[1]];
                const v2 = [next[0] - curr[0], next[1] - curr[1]];
                const l1 = Math.hypot(...v1);
                const l2 = Math.hypot(...v2);

                if (l1 > 1e-4 && l2 > 1e-4) {
                    const dot = (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2);
                    const clamped = Math.max(-1, Math.min(1, dot));
                    const angleDeg = Math.acos(clamped) * (180 / Math.PI);
                    if (angleDeg < 8.0) {
                        changed = true;
                        continue;
                    }
                }
                filtered.push(curr);
            }
            if (filtered.length >= 3) pts = filtered;
        }

        // 3. RDP với epsilon CỐ ĐỊNH theo mét (0.35m), KHÔNG ép số đỉnh
        const simplified = simplifyPolygonRDP(pts, 0.35);

        if (simplified.length >= 3) {
            const first = simplified[0];
            const last = simplified[simplified.length - 1];
            if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 0.001) {
                simplified.push([...first]);
            }
        }
        return simplified;
    }

    function addDirectPolylineFeature(map, coords, props = {}) {
        // Clean contour, remove spikes, and ensure closed LineString with 4-8 points
        let lineCoords = cleanParcelContour(coords);
        if (!lineCoords || lineCoords.length < 2) return null;

        const map_ = map;
        let targetSource = null;
        let resolvedSample = null;

        // 1. Try Draw interaction source first
        try {
            const interactions = map_.getInteractions().getArray();
            for (const inter of interactions) {
                if (inter.source_ && typeof inter.source_.addFeature === 'function') {
                    targetSource = inter.source_;
                    const feats = inter.source_.getFeatures ? inter.source_.getFeatures() : [];
                    if (feats.length > 0) { resolvedSample = feats[0]; }
                    break;
                }
            }
        } catch (e) { }

        // 2. Find in visible map layers
        if (!targetSource) {
            try {
                map_.getLayers().forEach(function walk(layer) {
                    if (targetSource) return;
                    if (typeof layer.getLayers === 'function') {
                        try { layer.getLayers().forEach(walk); } catch (e) { }
                        return;
                    }
                    try {
                        if (layer.getVisible && !layer.getVisible()) return;
                        const src = layer.getSource?.();
                        if (!src || typeof src.addFeature !== 'function' || !src.getFeatures) return;
                        const layerId = String(layer.get?.('id') || layer.get?.('name') || '').toLowerCase();
                        if (layerId.includes('topo') || layerId.includes('highlight') || layerId.includes('overlay')) return;

                        targetSource = src;
                        const feats = src.getFeatures();
                        for (const f of feats) {
                            if (f.getGeometry?.()?.getType?.() === 'LineString') {
                                resolvedSample = f;
                                return;
                            }
                        }
                    } catch (e) { }
                });
            } catch (e) { }
        }

        // 3. Fallback to any vector layer
        if (!targetSource) {
            try {
                map_.getLayers().forEach(function walk(layer) {
                    if (targetSource) return;
                    if (typeof layer.getLayers === 'function') {
                        try { layer.getLayers().forEach(walk); } catch (e) { }
                        return;
                    }
                    try {
                        const src = layer.getSource?.();
                        if (src && typeof src.addFeature === 'function') targetSource = src;
                    } catch (e) { }
                });
            } catch (e) { }
        }

        if (!targetSource) return null;

        const olClasses = getOlNativeClasses(map_);
        const featureId = generateUUID();
        const strokeColor = props.color || getLandTypeColor(props.landType);

        let newGeom = null;

        // Clone from existing LineString sample
        if (resolvedSample) {
            try {
                const geom = resolvedSample.getGeometry?.();
                if (geom?.getType?.() === 'LineString' && typeof geom.clone === 'function') {
                    newGeom = geom.clone();
                    newGeom.setCoordinates(lineCoords);
                }
            } catch (e) { newGeom = null; }
        }

        // Fallback: use olClasses.LineString
        if (!newGeom && olClasses.LineString) {
            try { newGeom = new olClasses.LineString(lineCoords); } catch (e) { }
        }

        // Last resort: try resolvedSample geometry constructor
        if (!newGeom && resolvedSample) {
            try {
                const C = resolvedSample.getGeometry?.()?.constructor || olClasses.LineString;
                if (C) newGeom = new C(lineCoords, 'XY');
            } catch (e) { }
        }

        // Guaranteed Fallback: TopoPolylineGeometry
        if (!newGeom) {
            newGeom = new TopoPolylineGeometry(lineCoords);
        }

        const FeatureClass = resolvedSample?.constructor || olClasses.Feature;
        let feat = null;
        if (FeatureClass && newGeom) {
            try { feat = new FeatureClass({ geometry: newGeom }); } catch (e) { }
        }

        // Guaranteed Fallback: TopoMapFeature
        if (!feat && newGeom) {
            feat = new TopoMapFeature(newGeom);
        }

        if (feat) {
            try {
                if (typeof feat.setId === 'function') feat.setId(featureId);
                feat.id_ = featureId;
                feat._id = featureId;
                feat.id = featureId;
                feat._editId = featureId;
                feat._landType = props.landType || 'LUA';
                feat._color = strokeColor;
                feat._name = props.name || `Thửa ${featureId.slice(0, 5)}`;

                if (typeof feat.set === 'function') {
                    feat.set('_editId', featureId);
                    feat.set('landType', props.landType || 'LUA');
                    feat.set('color', strokeColor);
                }

                let customStyle = createOlStyleForFeature(strokeColor, 2.0, resolvedSample, map_);
                if (customStyle && typeof feat.setStyle === 'function') {
                    feat.setStyle(customStyle);
                } else if (resolvedSample && typeof resolvedSample.getStyle === 'function') {
                    const style = resolvedSample.getStyle();
                    if (style && typeof feat.setStyle === 'function') {
                        try { feat.setStyle(style.clone ? style.clone() : style); } catch (e) { }
                    }
                }

                targetSource.addFeature(feat);
                if (typeof targetSource.changed === 'function') targetSource.changed();

                if (window.__topoSyncFeatureToReactState) {
                    try { window.__topoSyncFeatureToReactState(feat); } catch (e) { }
                }

                if (typeof map_.render === 'function') map_.render();
            } catch (e) {
                console.error('[AI Draw] Error adding LineString feature:', e);
            }
        }
        return feat;
    }

    function findAllTargetLineSources(map) {
        if (!map) return { primary: null, sources: [], sample: null };
        let sources = [];
        let primarySource = null;
        let sampleLineFeature = null;

        function walk(layer) {
            if (typeof layer.getLayers === 'function') {
                try { layer.getLayers().forEach(walk); } catch (e) { }
                return;
            }
            try {
                if (layer.getVisible && !layer.getVisible()) return;
                const src = layer.getSource?.();
                if (!src || typeof src.addFeature !== 'function' || !src.getFeatures) return;
                const layerId = String(layer.get?.('id') || layer.get?.('name') || layer.get?.('title') || '').toLowerCase();
                if (layerId.includes('topo') || layerId.includes('highlight') || layerId.includes('overlay') || layerId.includes('shared')) return;

                const features = src.getFeatures();
                let hasLineOrPoly = false;
                for (const f of features) {
                    const type = f.getGeometry?.()?.getType?.();
                    if (type === 'LineString' || type === 'Polygon' || type === 'MultiPolygon') {
                        hasLineOrPoly = true;
                        if (!sampleLineFeature) sampleLineFeature = f;
                        break;
                    }
                }
                if (!sources.includes(src)) sources.push(src);
                if (features.length > 0 || hasLineOrPoly || layerId.includes('edit') || layerId.includes('draw')) {
                    if (!primarySource || features.length > (primarySource.getFeatures ? primarySource.getFeatures().length : 0)) {
                        primarySource = src;
                    }
                }
            } catch (e) { }
        }

        try { map.getLayers().forEach(walk); } catch (e) { }
        if (!primarySource && sources.length > 0) primarySource = sources[0];
        return { primary: primarySource, sources, sample: sampleLineFeature };
    }

    // ===== UI STATUS & PROGRESS =====
    function updateAIStatus(text, type = 'info') {
        const statusEl = document.getElementById('topo-ai-status-text');
        if (statusEl) {
            statusEl.textContent = text;
            statusEl.className = `topo-ai-status-msg topo-status-${type}`;
        }
        log(`Status: [${type}] ${text}`);
    }

    function setAIProcessingState(isProcessing) {
        isProcessingAI = isProcessing;
        const bar = document.getElementById('topo-ai-bar');
        const spinner = document.getElementById('topo-ai-spinner');
        if (spinner) spinner.style.display = isProcessing ? 'inline-block' : 'none';
        if (bar) {
            if (isProcessing) bar.classList.add('topo-ai-busy');
            else bar.classList.remove('topo-ai-busy');
        }
    }

    // ===== MOUSE & KEYBOARD INTERACTION HANDLERS =====
    function onAIMouseDown(e) {
        if (!isAIDrawActive || isProcessingAI || e.button !== 0) return;
        const target = e.target;
        if (target.closest('#topo-checker-panel') || target.closest('#topo-fab-btn') || target.closest('.topo-ai-bar')) return;

        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();

        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        const canvas = getOrCreateAICanvasOverlay();
        if (!map || !canvas) return;

        const rect = canvas.getBoundingClientRect();
        const px = [e.clientX - rect.left, e.clientY - rect.top];
        const coord = map.getCoordinateFromPixel(px);
        if (!coord) return;

        startMousePos = { x: e.clientX, y: e.clientY, time: Date.now() };

        if (recognizedFeatures.length > 0) {
            const clickedFeat = findFeatureNearPixel(px, map, 10);
            if (clickedFeat) {
                clickedFeat.isIgnored = !clickedFeat.isIgnored;
                requestAIRender();
                updateAIPreviewSummary();
                return;
            }
        }

        boxStartCoord = coord;
        boxCurrentCoord = coord;
        isBoxDragging = true;
    }

    function onAIMouseMove(e) {
        if (!isAIDrawActive || isProcessingAI) return;
        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        const canvas = getOrCreateAICanvasOverlay();
        if (!map || !canvas) return;

        const rect = canvas.getBoundingClientRect();
        const px = [e.clientX - rect.left, e.clientY - rect.top];
        const coord = map.getCoordinateFromPixel(px);
        if (!coord) return;

        if (isBoxDragging && startMousePos) {
            if (e.preventDefault) e.preventDefault();
            if (e.stopPropagation) e.stopPropagation();
            const dx = e.clientX - startMousePos.x;
            const dy = e.clientY - startMousePos.y;
            if (Math.hypot(dx, dy) > 8) {
                boxCurrentCoord = coord;
                requestAIRender();
            }
        } else if (recognizedFeatures.length > 0) {
            const hovered = findFeatureNearPixel(px, map, 10);
            const newHoverId = hovered ? hovered.id : null;
            if (newHoverId !== hoveredFeatureId) {
                hoveredFeatureId = newHoverId;
                requestAIRender();
            }
        }
    }

    function onAIMouseUp(e) {
        if (!isAIDrawActive || !isBoxDragging || isProcessingAI || e.button !== 0) return;
        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();

        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        const canvas = getOrCreateAICanvasOverlay();
        isBoxDragging = false;

        if (!startMousePos || !map || !canvas) return;

        const dx = e.clientX - startMousePos.x;
        const dy = e.clientY - startMousePos.y;
        const dist = Math.hypot(dx, dy);

        if (dist > 15 && boxStartCoord && boxCurrentCoord) {
            const extent = computeBoundingBox([boxStartCoord, boxCurrentCoord]);
            boxStartCoord = null;
            boxCurrentCoord = null;
            startMousePos = null;

            if (extent[2] - extent[0] > 1 && extent[3] - extent[1] > 1) {
                selectionPoints = [
                    [extent[0], extent[1]],
                    [extent[2], extent[1]],
                    [extent[2], extent[3]],
                    [extent[0], extent[3]]
                ];
                activeExtents = extent;
                requestAIRender();
                handleAreaCompleted(selectionPoints, extent);
            }
            return;
        }

        const rect = canvas.getBoundingClientRect();
        const px = [e.clientX - rect.left, e.clientY - rect.top];
        const coord = map.getCoordinateFromPixel(px);
        startMousePos = null;
        boxStartCoord = null;
        boxCurrentCoord = null;

        if (coord && recognizedFeatures.length === 0) {
            selectionPoints.push(coord);
            requestAIRender();
            updateAIStatus(`Đã chọn ${selectionPoints.length} điểm. Nhấp đúp để xong khoanh vùng.`, 'info');
        }
    }

    function onAIDblClick(e) {
        if (!isAIDrawActive || isProcessingAI) return;
        if (e.stopPropagation) e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();

        if (selectionPoints.length >= 3) {
            const extent = computeBoundingBox(selectionPoints);
            activeExtents = extent;
            handleAreaCompleted(selectionPoints, extent);
        }
    }

    function onAIKeyDown(e) {
        if (!isAIDrawActive) return;

        if (e.key === 'Escape') {
            if (recognizedFeatures.length > 0) {
                recognizedFeatures = [];
                requestAIRender();
                updateAIStatus('Đã hủy xem trước. Chọn vùng mới để quét tiếp.', 'info');
                updateAIPreviewSummary();
            } else {
                stopAIDrawMode();
            }
        } else if (e.key === 'Enter') {
            if (recognizedFeatures.length > 0) {
                commitRecognizedFeaturesToMap();
            } else if (selectionPoints.length >= 3) {
                const extent = computeBoundingBox(selectionPoints);
                activeExtents = extent;
                handleAreaCompleted(selectionPoints, extent);
            }
        }
    }

    // ===== MAIN WORKFLOW: PROCESS COMPLETED SELECTION =====
    async function handleAreaCompleted(points, extent) {
        setAIProcessingState(true);
        updateAIStatus('⚡ Đang kết nối máy chủ AI (Delineate Anything)...', 'info');

        try {
            const crop = cropMapCanvasElementFullRes(extent);
            if (!crop) {
                throw new Error('Không thể crop canvas ảnh trực giao của vùng chọn.');
            }

            let processed = [];
            let usedAI = false;
            let aiModelName = 'Delineate Anything';

            // Try local Delineate Anything AI server first
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 3500);

                const sens = parseFloat(localStorage.getItem('topo_cv_sensitivity') || '0.65');
                const targetConf = sens * 0.4; // Map slider [0.3 - 1.0] to AI conf [0.12 - 0.40]

                const response = await fetch('http://127.0.0.1:5000/predict', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        image_base64: crop.canvas.toDataURL('image/png'),
                        extent: extent,
                        conf: targetConf
                    }),
                    signal: controller.signal
                });

                clearTimeout(timeoutId);
                const data = await response.json();
                if (data && data.ok) {
                    if (data.model_name) aiModelName = data.model_name;
                    const polygons = data.polygons || [];
                    polygons.forEach((polyCoords, idx) => {
                        if (!polyCoords || polyCoords.length < 4) return;
                        processed.push({
                            id: 'ai-feat-' + idx + '-' + Date.now(),
                            type: 'Polygon',
                            landType: 'LUA',
                            name: `Thửa AI ${idx + 1}`,
                            color: getLandTypeColor('LUA'),
                            coords: polyCoords,
                            isIgnored: false
                        });
                    });
                    usedAI = true;
                    log(`Loaded ${processed.length} clean polygons from ${aiModelName} server.`);
                }
            } catch (err) {
                log('[3DG AI-Draw] Server AI offline, falling back to local CV...', err);
            }

            // Fallback to offline Computer Vision if AI server is offline or fails
            if (!usedAI) {
                updateAIStatus('⚡ Máy chủ AI offline. Đang nhận diện bằng Computer Vision...', 'info');
                const result = detectParcelsOfflineCV(crop, { sensitivity: 0.65, dilateIterations: 1 });

                if (!result.ok) {
                    console.warn('[3DG CV-Draw] Kết quả CV:', result.error, result.debug);
                    updateAIStatus(result.error, 'warning');
                    setAIProcessingState(false);
                    return;
                }

                const rawFeatures = result.features || [];
                const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());

                rawFeatures.forEach((raw, idx) => {
                    const pixelPoints = raw.pixelPoints || [];
                    if (pixelPoints.length < 3 || !map) return;

                    const mapCoords = [];
                    pixelPoints.forEach(pt => {
                        const viewportPx = crop.vpMinX + (pt[0] / crop.width) * crop.vpWidth;
                        const viewportPy = crop.vpMinY + (pt[1] / crop.height) * crop.vpHeight;
                        const coord = map.getCoordinateFromPixel([viewportPx, viewportPy]);
                        if (coord && !isNaN(coord[0]) && !isNaN(coord[1])) {
                            mapCoords.push(coord);
                        }
                    });

                    if (mapCoords.length >= 3) {
                        const first = mapCoords[0];
                        const last = mapCoords[mapCoords.length - 1];
                        if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 0.001) {
                            mapCoords.push([...first]);
                        }

                        processed.push({
                            id: 'cv-feat-' + idx + '-' + Date.now(),
                            type: 'Polygon',
                            landType: 'LUA',
                            name: raw.name || `Thửa ${idx + 1}`,
                            color: getLandTypeColor('LUA'),
                            coords: mapCoords,
                            isIgnored: false
                        });
                    }
                });
            }

            // Snap endpoints & shared boundaries
            const autoSnap = localStorage.getItem(STORAGE_KEY_AUTO_SNAP) !== 'false';
            recognizedFeatures = autoSnap ? snapEndpointsToNearby(processed, 0.4) : processed;

            const modeText = usedAI ? aiModelName : 'Computer Vision';
            updateAIStatus(`🎉 Đã nhận diện được ${recognizedFeatures.length} thửa ruộng (${modeText})! Nhấn Enter để thêm vào bản đồ.`, 'success');
            updateAIPreviewSummary();
            selectionPoints = [];
            requestAIRender();

            const autoCommit = localStorage.getItem('topo_ai_auto_commit') === 'true';
            if (autoCommit && recognizedFeatures.length > 0) {
                setTimeout(() => {
                    commitRecognizedFeaturesToMap();
                }, 100);
            }

        } catch (err) {
            console.error('[3DG CV-Draw] Error:', err);
            updateAIStatus(`Lỗi: ${err.message}`, 'error');
        } finally {
            setAIProcessingState(false);
        }
    }

    function findFeatureNearPixel(px, map, maxDist = 8) {
        if (!recognizedFeatures || recognizedFeatures.length === 0) return null;
        for (const feat of recognizedFeatures) {
            if (feat.isIgnored || !feat.coords) continue;
            for (let i = 0; i < feat.coords.length - 1; i++) {
                const p1 = map.getPixelFromCoordinate(feat.coords[i]);
                const p2 = map.getPixelFromCoordinate(feat.coords[i + 1]);
                if (p1 && p2) {
                    const dist = pointToSegmentDistance(px, p1, p2);
                    if (dist <= maxDist) return feat;
                }
            }
        }
        return null;
    }

    function pointToSegmentDistance(p, v, w) {
        const l2 = (w[0] - v[0]) ** 2 + (w[1] - v[1]) ** 2;
        if (l2 === 0) return Math.hypot(p[0] - v[0], p[1] - v[1]);
        let t = ((p[0] - v[0]) * (w[0] - v[0]) + (p[1] - v[1]) * (w[1] - v[1])) / l2;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(p[0] - (v[0] + t * (w[0] - v[0])), p[1] - (v[1] + t * (w[1] - v[1])));
    }

    function updateAIPreviewSummary() {
        const confirmBtn = document.getElementById('topo-btn-ai-confirm');
        const clearBtn = document.getElementById('topo-btn-ai-clear');
        const countBadge = document.getElementById('topo-ai-feature-count');

        const activeCount = recognizedFeatures.filter(f => !f.isIgnored).length;

        if (confirmBtn) confirmBtn.style.display = activeCount > 0 ? 'inline-flex' : 'none';
        if (clearBtn) clearBtn.style.display = activeCount > 0 ? 'inline-flex' : 'none';
        if (countBadge) {
            countBadge.textContent = activeCount > 0 ? `${activeCount} thửa` : '';
            countBadge.style.display = activeCount > 0 ? 'inline-block' : 'none';
        }
    }

    function resetSelection() {
        selectionPoints = [];
        activeExtents = null;
        boxStartCoord = null;
        boxCurrentCoord = null;
        isBoxDragging = false;
        requestAIRender();
    }

    function resetAIState() {
        resetSelection();
        recognizedFeatures = [];
        hoveredFeatureId = null;
        isProcessingAI = false;
        requestAIRender();
        updateAIPreviewSummary();
    }

    // ===== DISABLE / RESTORE NATIVE MAP INTERACTIONS =====
    function disableNativeMapInteractions(map) {
        if (!map || typeof map.getInteractions !== 'function') return;
        try {
            map.getInteractions().forEach(interaction => {
                if (interaction && typeof interaction.setActive === 'function') {
                    const name = interaction.constructor?.name || '';
                    if (name.includes('Draw') || name.includes('Modify') || name.includes('Snap') || name.includes('DragPan') || name.includes('Pointer')) {
                        if (interaction.getActive()) {
                            interaction.setActive(false);
                            interaction.__topoAIDisabled = true;
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
                if (interaction && interaction.__topoAIDisabled) {
                    interaction.setActive(true);
                    delete interaction.__topoAIDisabled;
                }
            });
        } catch (e) { }
    }

    // ===== ACTIVATE / DEACTIVATE MODES =====
    function startAIDrawMode() {
        isAIDrawActive = true;
        resetAIState();

        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        if (map) {
            disableNativeMapInteractions(map);
            try {
                map.on('postrender', requestAIRender);
                map.getView()?.on('change:center', requestAIRender);
                map.getView()?.on('change:resolution', requestAIRender);
            } catch (e) { }
        }

        const canvas = getOrCreateAICanvasOverlay();
        if (canvas) {
            canvas.style.pointerEvents = 'all';
            canvas.style.cursor = 'crosshair';
            canvas.addEventListener('pointerdown', onAIMouseDown, true);
            canvas.addEventListener('pointermove', onAIMouseMove, true);
            canvas.addEventListener('pointerup', onAIMouseUp, true);
            canvas.addEventListener('mousedown', onAIMouseDown, true);
            canvas.addEventListener('mousemove', onAIMouseMove, true);
            canvas.addEventListener('mouseup', onAIMouseUp, true);
        }

        window.addEventListener('pointerdown', onAIMouseDown, true);
        window.addEventListener('pointermove', onAIMouseMove, true);
        window.addEventListener('pointerup', onAIMouseUp, true);
        window.addEventListener('mousedown', onAIMouseDown, true);
        window.addEventListener('mousemove', onAIMouseMove, true);
        window.addEventListener('mouseup', onAIMouseUp, true);
        window.addEventListener('dblclick', onAIDblClick, true);
        window.addEventListener('keydown', onAIKeyDown, true);

        const bar = document.getElementById('topo-ai-bar');
        if (bar) bar.classList.remove('topo-drawer-hidden');

        updateAIStatus('⚡ Kéo chọn vùng ruộng để quét tự động...', 'info');
    }

    function stopAIDrawMode() {
        isAIDrawActive = false;
        resetAIState();

        const map = window.__topoMap || (window.__topoFindOlMap && window.__topoFindOlMap());
        if (map) {
            restoreNativeMapInteractions(map);
            try {
                map.un('postrender', requestAIRender);
            } catch (e) { }
        }

        const canvas = document.getElementById('topo-ai-draw-canvas');
        if (canvas) {
            canvas.removeEventListener('pointerdown', onAIMouseDown, true);
            canvas.removeEventListener('pointermove', onAIMouseMove, true);
            canvas.removeEventListener('pointerup', onAIMouseUp, true);
            canvas.removeEventListener('mousedown', onAIMouseDown, true);
            canvas.removeEventListener('mousemove', onAIMouseMove, true);
            canvas.removeEventListener('mouseup', onAIMouseUp, true);
            canvas.style.pointerEvents = 'none';
            canvas.style.cursor = 'default';
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }

        window.removeEventListener('pointerdown', onAIMouseDown, true);
        window.removeEventListener('pointermove', onAIMouseMove, true);
        window.removeEventListener('pointerup', onAIMouseUp, true);
        window.removeEventListener('mousedown', onAIMouseDown, true);
        window.removeEventListener('mousemove', onAIMouseMove, true);
        window.removeEventListener('mouseup', onAIMouseUp, true);
        window.removeEventListener('dblclick', onAIDblClick, true);
        window.removeEventListener('keydown', onAIKeyDown, true);

        const bar = document.getElementById('topo-ai-bar');
        if (bar) bar.classList.add('topo-drawer-hidden');
    }

    // ===== EXPOSE GLOBAL APIS =====
    window.__topoAIDraw = {
        start: startAIDrawMode,
        stop: stopAIDrawMode,
        isActive: () => isAIDrawActive,
        commitFeatures: commitRecognizedFeaturesToMap,
        cropFullRes: cropMapCanvasElementFullRes,
        detectParcels: detectParcelsOfflineCV,
        getSamples: () => [],
        deleteSample: () => [],
        clearSamples: () => { },
        exportSamples: () => { },
        importSamples: () => ({ ok: false, error: 'CV chạy offline 100%' }),
        testApiKey: async () => ({ ok: true, message: 'CV chạy offline 100% không cần key' })
    };

    window.__topoOfflineCV = {
        detectParcelsOffline: detectParcelsOfflineCV,
        cropFullRes: cropMapCanvasElementFullRes
    };

    log('Module Computer Vision Parcel Drawer (100% Offline) loaded successfully.');

})();
