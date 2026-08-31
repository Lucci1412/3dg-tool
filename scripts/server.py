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

# Load Delineate Anything model (Try DelineateAnythingv2 first, fallback to DelineateAnything-S, then user's best.pt)
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
    conf: float = 0.05

def remove_polygon_spikes(coords, min_angle_deg=30.0):
    """
    Eliminates acute sawtooth / lightning / spike vertices from polygon boundary.
    Uses 30 deg threshold to remove noise while preserving natural sharp parcel corners.
    """
    if len(coords) < 4:
        return coords

    is_closed = (abs(coords[0][0] - coords[-1][0]) < 1e-4 and abs(coords[0][1] - coords[-1][1]) < 1e-4)
    pts = [list(c) for c in (coords[:-1] if is_closed else coords)]

    changed = True
    iterations = 0
    while changed and len(pts) > 3 and iterations < 6:
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

            cos_angle = np.dot(v1, v2) / (len1 * len2)
            cos_angle = np.clip(cos_angle, -1.0, 1.0)
            angle_deg = np.degrees(np.arccos(cos_angle))

            # Acute spike (hairpin zigzag artifact)
            if angle_deg < min_angle_deg:
                to_remove.add(i)
                changed = True

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
        tol_pixels = max(0.5, 0.15 / max(1e-4, meters_per_pixel))
        
        # Dynamic high-resolution inference (avoids downscale mask blurring)
        max_dim = max(h, w)
        target_imgsz = min(1280, max(640, int(np.ceil(max_dim / 32.0) * 32)))
        
        # Run inference with full-resolution retina masks
        results = model(img, imgsz=target_imgsz, conf=req.conf, retina_masks=True)
        
        detected_masks = []
        
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
                    
                area = np.count_nonzero(mask_bin)
                if area >= 150:
                    detected_masks.append({
                        "mask": mask_bin,
                        "conf": conf_val,
                        "area": area
                    })
                    
        if not detected_masks:
            return {
                "ok": True,
                "polygons": [],
                "count": 0,
                "model_name": model_name_display
            }

        # 1. Gradient-guided Watershed Expansion: Bridges inter-parcel dikes & snaps to dike centerline
        # Sort by confidence * sqrt(area)
        detected_masks.sort(key=lambda item: item["conf"] * np.sqrt(item["area"]), reverse=True)
        
        markers = np.zeros((h, w), dtype=np.int32)
        union_mask = np.zeros((h, w), dtype=np.uint8)
        
        for idx, item in enumerate(detected_masks):
            m = item["mask"]
            label_id = idx + 1
            # Clean interior pinholes
            m_clean = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)))
            # Erode seed slightly so overlapping seeds don't collide
            seed = cv2.erode(m_clean, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
            if np.count_nonzero(seed) < 50:
                seed = m_clean
            markers[(seed > 128) & (markers == 0)] = label_id
            union_mask = cv2.bitwise_or(union_mask, m_clean)
            
        # Dike expansion limit (~1.8m maximum bridge)
        dike_dilation_px = max(6, min(24, int(round(1.8 / max(1e-4, meters_per_pixel)))))
        k_expand = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (dike_dilation_px * 2 + 1, dike_dilation_px * 2 + 1))
        valid_expansion_zone = cv2.dilate(union_mask, k_expand)
        
        # Aerial photo gradient magnitude for watershed guidance
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)
        grad_x = cv2.Sobel(blurred, cv2.CV_32F, 1, 0, ksize=3)
        grad_y = cv2.Sobel(blurred, cv2.CV_32F, 0, 1, ksize=3)
        grad_mag = cv2.magnitude(grad_x, grad_y)
        grad_mag = cv2.normalize(grad_mag, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
        grad_bgr = cv2.cvtColor(grad_mag, cv2.COLOR_GRAY2BGR)
        
        ws_markers = markers.copy()
        cv2.watershed(grad_bgr, ws_markers)
        ws_markers[valid_expansion_zone == 0] = 0
        ws_markers[ws_markers == -1] = 0
        
        # 2. Extract smooth, corner-preserving polygon boundaries
        polygons_geo = []
        
        for idx in range(len(detected_masks)):
            label_id = idx + 1
            region = (ws_markers == label_id).astype(np.uint8) * 255
            if np.count_nonzero(region) < 150:
                continue
                
            # Bridge 1-px gaps without eroding corners
            region = cv2.morphologyEx(region, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)))
            
            contours, _ = cv2.findContours(region, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_TC89_KCOS)
            
            for cnt in contours:
                area = cv2.contourArea(cnt)
                if area < 150:
                    continue
                    
                peri = cv2.arcLength(cnt, True)
                # High-fidelity epsilon preserving exact rectangular / sharp corners
                eps = max(1.0, 0.0025 * peri)
                approx = cv2.approxPolyDP(cnt, eps, True)
                
                if len(approx) < 3:
                    continue
                    
                coords = approx.reshape(-1, 2).tolist()
                coords.append(coords[0])
                
                # Remove acute spikes (hairpin teeth)
                coords = remove_polygon_spikes(coords, min_angle_deg=30.0)
                if len(coords) < 4:
                    continue
                    
                try:
                    poly = Polygon(coords)
                    if not poly.is_valid:
                        poly = make_valid(poly)
                        
                    simplified = poly.simplify(tol_pixels, preserve_topology=False)
                    if not simplified.is_valid:
                        simplified = make_valid(simplified)
                        
                    sub_polys = []
                    if isinstance(simplified, Polygon):
                        sub_polys = [simplified]
                    elif isinstance(simplified, MultiPolygon):
                        sub_polys = [p for p in simplified.geoms if isinstance(p, Polygon)]
                        
                    for p in sub_polys:
                        if p.area >= 150:
                            clean_coords = remove_spikes_from_coords_helper(list(p.exterior.coords), min_angle_deg=30.0)
                            if len(clean_coords) >= 4:
                                map_coords = []
                                for pt in clean_coords:
                                    px, py = pt[0], pt[1]
                                    gx = minX + (px / w) * (maxX - minX)
                                    gy = maxY - (py / h) * (maxY - minY)
                                    map_coords.append([round(gx, 4), round(gy, 4)])
                                polygons_geo.append(map_coords)
                except Exception:
                    pass
                    
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

def remove_spikes_from_coords_helper(coords, min_angle_deg=30.0):
    return remove_polygon_spikes(coords, min_angle_deg=min_angle_deg)

@app.get("/ping")
async def ping():
    return {"status": "ok", "model": model_name_display}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=5000)
