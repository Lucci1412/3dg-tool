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
        
        # Run inference
        results = model(img, imgsz=640, conf=req.conf)
        
        raw_polygons = []
        
        for result in results:
            masks = result.masks
            if masks is None:
                continue
                
            for seg in masks.xy:
                if len(seg) < 4:
                    continue
                try:
                    poly = Polygon(seg)
                    if not poly.is_valid:
                        poly = make_valid(poly)
                    
                    # Extract individual polygons from MultiPolygon if any
                    sub_polys = []
                    if isinstance(poly, Polygon):
                        sub_polys = [poly]
                    elif isinstance(poly, MultiPolygon):
                        sub_polys = [p for p in poly.geoms if isinstance(p, Polygon)]
                        
                    for p in sub_polys:
                        if p.area >= 250:
                            raw_polygons.append(p)
                except Exception:
                    pass
                    
        # 1. Resolve overlaps between neighboring fields
        # Sort by area descending so dominant fields retain their boundaries
        raw_polygons.sort(key=lambda p: p.area, reverse=True)
        resolved_polygons = []
        
        for poly in raw_polygons:
            current_poly = poly
            for other in resolved_polygons:
                if current_poly.intersects(other):
                    try:
                        diff = current_poly.difference(other)
                        if isinstance(diff, Polygon) and diff.area >= 200:
                            current_poly = diff
                        elif isinstance(diff, MultiPolygon):
                            valid_parts = [part for part in diff.geoms if isinstance(part, Polygon) and part.area >= 200]
                            if valid_parts:
                                current_poly = max(valid_parts, key=lambda x: x.area)
                            else:
                                current_poly = None
                                break
                        else:
                            current_poly = None
                            break
                    except Exception:
                        pass
            if current_poly is not None and current_poly.area >= 200:
                resolved_polygons.append(current_poly)
                
        # 2. Topology-preserving simplification with fixed metric tolerance (~0.35m)
        polygons_geo = []
        meters_per_pixel = (maxX - minX) / max(1, w)
        tol_pixels = max(1.0, 0.35 / max(1e-4, meters_per_pixel))
        
        for poly in resolved_polygons:
            if not poly.is_valid:
                poly = make_valid(poly)
                if isinstance(poly, MultiPolygon):
                    valid_parts = [p for p in poly.geoms if isinstance(p, Polygon)]
                    if not valid_parts:
                        continue
                    poly = max(valid_parts, key=lambda x: x.area)
                elif not isinstance(poly, Polygon):
                    continue
                    
            simplified = poly.simplify(tol_pixels, preserve_topology=True)
            
            if not isinstance(simplified, Polygon) or simplified.area < 100:
                simplified = poly.simplify(1.0, preserve_topology=True)
                
            if isinstance(simplified, Polygon):
                coords = list(simplified.exterior.coords)
                if len(coords) >= 4:
                    # Convert to geographic coordinates
                    map_coords = []
                    for pt in coords:
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
