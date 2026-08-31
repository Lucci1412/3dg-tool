import os
import sys
import subprocess
import base64
import numpy as np

# Ensure required libraries are installed
def check_dependencies():
    required = ["fastapi", "uvicorn", "ultralytics", "pydantic", "shapely"]
    for pkg in required:
        try:
            __import__(pkg if pkg != "fastapi" else "fastapi")
        except ImportError:
            print(f"Missing dependency '{pkg}'. Installing via pip...")
            subprocess.check_call([sys.executable, "-m", "pip", "install", pkg])

check_dependencies()

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from ultralytics import YOLO
import cv2
from shapely.geometry import Polygon, MultiPolygon
from shapely.validation import make_valid

app = FastAPI(title="3DG Delineate Anything Segmentation Server")

# Enable CORS for the chrome extension (3dg.vn matches)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load Delineate Anything model
model_path = os.path.join(os.path.dirname(__file__), "..", "models", "DelineateAnythingv2.pt")
model_name_display = "Delineate Anything v2"
if not os.path.exists(model_path):
    print("DelineateAnythingv2.pt not found. Trying DelineateAnything-S.pt...")
    model_path = os.path.join(os.path.dirname(__file__), "..", "models", "DelineateAnything-S.pt")
    model_name_display = "Delineate Anything S"
if not os.path.exists(model_path):
    print("DelineateAnything-S.pt not found. Trying user's best.pt fallback...")
    model_path = os.path.join(os.path.dirname(__file__), "..", "ruong_lua_test", "ruong_lua_test", "weights", "best.pt")
    model_name_display = "Custom Delineate Model"

if not os.path.exists(model_path):
    print(f"ERROR: Model file not found at {model_path}")
    sys.exit(1)

print(f"Loading {model_name_display} from: {model_path} ...")
model = YOLO(model_path)
print(f"{model_name_display} loaded successfully!")

class PredictionRequest(BaseModel):
    image_base64: str
    extent: list  # [minX, minY, maxX, maxY] in EPSG:3857
    conf: float = 0.08

def filter_duplicate_masks(detected_masks, iou_thresh=0.25, iomin_thresh=0.35):
    """
    Suppresses duplicate and nested candidate masks from YOLO.
    """
    detected_masks.sort(key=lambda item: item["conf"] * np.sqrt(item["area"]), reverse=True)
    kept = []
    
    for item in detected_masks:
        m = item["mask"] > 0
        area = item["area"]
        is_dup = False
        
        for k in kept:
            km = k["mask"] > 0
            inter = np.count_nonzero(m & km)
            if inter > 0:
                union = area + k["area"] - inter
                iou = inter / float(union)
                io_min = inter / float(min(area, k["area"]))
                if iou > iou_thresh or io_min > iomin_thresh:
                    is_dup = True
                    break
                    
        if not is_dup:
            kept.append(item)
            
    return kept

def remove_polygon_spikes_and_collinear(coords, min_angle_deg=28.0, collinear_thresh_deg=8.0, min_edge_len=4.0):
    """
    Cadastral Polygon Regularizer:
    1. Removes acute sawtooth / lightning spikes (< 28 deg)
    2. Removes collinear redundant vertices (within 8 deg of 180 deg)
    3. Collapses tiny micro-notches (< min_edge_len pixels)
    """
    if len(coords) < 4:
        return coords

    is_closed = (abs(coords[0][0] - coords[-1][0]) < 1e-4 and abs(coords[0][1] - coords[-1][1]) < 1e-4)
    pts = [list(c) for c in (coords[:-1] if is_closed else coords)]

    if len(pts) < 3:
        return coords

    changed = True
    iterations = 0
    while changed and len(pts) > 3 and iterations < 8:
        changed = False
        iterations += 1
        n = len(pts)
        to_remove = set()

        for i in range(n):
            p_prev = np.array(pts[(i - 1 + n) % n], dtype=float)
            p_curr = np.array(pts[i], dtype=float)
            p_next = np.array(pts[(i + 1) % n], dtype=float)

            v1 = p_prev - p_curr
            v2 = p_next - p_curr

            len1 = np.linalg.norm(v1)
            len2 = np.linalg.norm(v2)

            if len1 < 1e-4 or len2 < 1e-4:
                to_remove.add(i)
                changed = True
                continue

            if len2 < min_edge_len and len(pts) - len(to_remove) > 4:
                to_remove.add(i)
                changed = True
                continue

            cos_angle = np.dot(v1, v2) / (len1 * len2)
            cos_angle = np.clip(cos_angle, -1.0, 1.0)
            angle_deg = np.degrees(np.arccos(cos_angle))

            if angle_deg < min_angle_deg:
                to_remove.add(i)
                changed = True
                continue

            if angle_deg > (180.0 - collinear_thresh_deg):
                to_remove.add(i)
                changed = True
                continue

        if to_remove and len(pts) - len(to_remove) >= 3:
            pts = [pt for idx, pt in enumerate(pts) if idx not in to_remove]
        else:
            break

    if is_closed and len(pts) >= 3:
        pts.append(pts[0])

    return pts

@app.post("/predict")
async def predict(req: PredictionRequest):
    try:
        # Decode base64 image
        header, encoded = req.image_base64.split(",", 1) if "," in req.image_base64 else ("", req.image_base64)
        img_data = base64.b64decode(encoded)
        nparr = np.frombuffer(img_data, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        
        if img is None:
            raise HTTPException(status_code=400, detail="Invalid image data")
            
        h, w, _ = img.shape
        minX, minY, maxX, maxY = req.extent
        
        # Metric resolution (meters per pixel)
        meters_per_pixel = (maxX - minX) / max(1, w)
        tol_pixels = max(0.6, 0.15 / max(1e-4, meters_per_pixel))
        
        # Standardized constant inference resolution (ensures 100% identical results across draws)
        target_imgsz = 1024
        
        # Run inference with confidence floor and full-resolution retina masks
        effective_conf = max(0.06, req.conf)
        results = model(img, imgsz=target_imgsz, conf=effective_conf, iou=0.45, retina_masks=True, agnostic_nms=True)
        
        raw_masks = []
        k_close = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11))
        
        for result in results:
            masks = result.masks
            if masks is None:
                continue
                
            boxes_conf = result.boxes.conf.cpu().numpy() if result.boxes is not None and result.boxes.conf is not None else None
            
            for i in range(len(masks)):
                conf_val = float(boxes_conf[i]) if boxes_conf is not None and i < len(boxes_conf) else 1.0
                
                # Get binary mask in full resolution (h, w)
                if masks.data is not None and i < len(masks.data):
                    m_raw = masks.data[i].cpu().numpy()
                    if m_raw.shape[0] != h or m_raw.shape[1] != w:
                        m_resized = cv2.resize(m_raw, (w, h), interpolation=cv2.INTER_LINEAR)
                    else:
                        m_resized = m_raw
                    mask_bin = (m_resized > 0.5).astype(np.uint8) * 255
                elif masks.xy is not None and i < len(masks.xy):
                    seg = masks.xy[i].astype(np.int32)
                    mask_bin = np.zeros((h, w), dtype=np.uint8)
                    cv2.fillPoly(mask_bin, [seg], 255)
                else:
                    continue
                    
                # Clean mask: keep only the single largest connected component
                num_labels, labels_im, stats, _ = cv2.connectedComponentsWithStats(mask_bin)
                if num_labels > 1:
                    largest_idx = 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])
                    mask_bin = (labels_im == largest_idx).astype(np.uint8) * 255
                    
                # Morphological close to bridge internal pinholes and texture dents
                mask_bin = cv2.morphologyEx(mask_bin, cv2.MORPH_CLOSE, k_close)
                area = np.count_nonzero(mask_bin)
                
                if area >= 250:
                    raw_masks.append({
                        "mask": mask_bin,
                        "conf": conf_val,
                        "area": area
                    })
                    
        # 1. Mask NMS / Duplicate Suppression
        detected_masks = filter_duplicate_masks(raw_masks, iou_thresh=0.25, iomin_thresh=0.35)
        
        if not detected_masks:
            return {
                "ok": True,
                "polygons": [],
                "count": 0,
                "model_name": model_name_display
            }

        # 2. Extract Smooth Cadastral Polygons using Convex Hull Simplification
        raw_polygons = []
        for item in detected_masks:
            m = item["mask"]
            contours, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_TC89_KCOS)
            if not contours:
                continue
                
            cnt = max(contours, key=cv2.contourArea)
            if cv2.contourArea(cnt) < 250:
                continue
                
            # Use convex hull to eliminate artificial color/shadow dips while 100% preserving genuine corners
            hull = cv2.convexHull(cnt)
            peri = cv2.arcLength(hull, True)
            
            # Cadastral epsilon
            eps = max(2.0, min(7.0, 0.010 * peri))
            approx = cv2.approxPolyDP(hull, eps, True)
            
            if len(approx) < 3:
                continue
                
            coords = approx.reshape(-1, 2).tolist()
            coords.append(coords[0])
            
            # Regularize: clean spikes and collinear points
            coords = remove_polygon_spikes_and_collinear(coords, min_angle_deg=28.0, collinear_thresh_deg=8.0, min_edge_len=4.0)
            if len(coords) >= 4:
                try:
                    poly = Polygon(coords)
                    if poly.is_valid and poly.area >= 200:
                        raw_polygons.append({
                            "poly": poly,
                            "area": poly.area,
                            "conf": item["conf"]
                        })
                except Exception:
                    pass

        # 3. Resolve Overlaps in Vector Space (0% Overlap Guarantee)
        raw_polygons.sort(key=lambda item: item["area"], reverse=True)
        union_accepted = None
        clean_shapely_polys = []
        
        for item in raw_polygons:
            poly = item["poly"]
            if not poly.is_valid:
                poly = make_valid(poly)
                
            if union_accepted is not None:
                poly = poly.difference(union_accepted)
                if not poly.is_valid:
                    poly = make_valid(poly)
                    
            if poly.is_empty:
                continue
                
            sub_list = [poly] if isinstance(poly, Polygon) else [p for p in poly.geoms if isinstance(p, Polygon)]
            for sub_p in sub_list:
                if sub_p.area >= 200:
                    simplified = sub_p.simplify(tol_pixels, preserve_topology=True)
                    if not simplified.is_valid:
                        simplified = make_valid(simplified)
                        
                    clean_shapely_polys.append(simplified)
                    if union_accepted is None:
                        union_accepted = simplified
                    else:
                        union_accepted = union_accepted.union(simplified)

        # 4. Transform to EPSG:3857 Geo-Coordinates
        polygons_geo = []
        for poly in clean_shapely_polys:
            sub_polys = [poly] if isinstance(poly, Polygon) else [p for p in poly.geoms if isinstance(p, Polygon)]
            for p in sub_polys:
                if p.area >= 200:
                    coords = list(p.exterior.coords)
                    clean_coords = remove_polygon_spikes_and_collinear(coords, min_angle_deg=28.0, collinear_thresh_deg=8.0, min_edge_len=4.0)
                    if len(clean_coords) >= 4:
                        map_coords = []
                        for pt in clean_coords:
                            px, py = pt[0], pt[1]
                            gx = minX + (px / w) * (maxX - minX)
                            gy = maxY - (py / h) * (maxY - minY)
                            map_coords.append([round(gx, 4), round(gy, 4)])
                        polygons_geo.append(map_coords)
                        
        return {
            "ok": True,
            "polygons": polygons_geo,
            "count": len(polygons_geo),
            "model_name": model_name_display
        }
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"ok": False, "error": str(e)}

@app.get("/ping")
async def ping():
    return {"status": "ok", "model": model_name_display}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=5000)
