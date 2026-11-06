"""
GeoTop | Back-end FastAPI del visor de perfil topográfico.

Flujo:  navegador (fetch) → FastAPI (/api/elevacion) → Open-Meteo Elevation API → FastAPI → navegador

Ejecutar (desde esta carpeta):
    pip install -r requirements.txt
    uvicorn main:app --reload
y abrir http://127.0.0.1:8000   (documentación interactiva de la API: http://127.0.0.1:8000/docs)

Convenciones: latitud/longitud en grados decimales WGS84 (EPSG:4326),
lat ∈ [−90, 90] (Norte +), lng ∈ [−180, 180] (Este +). Elevaciones en metros s. n. m.
"""
import math
import time
from collections import defaultdict, deque
from pathlib import Path
from typing import List, Optional

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
OPEN_METEO_URL = "https://api.open-meteo.com/v1/elevation"
MAX_PUNTOS = 100          # límite de coordenadas por solicitud de Open-Meteo
TIMEOUT_S = 12.0
VENTANA_S = 60            # ventana del limitador (segundos)
MAX_SOLICITUDES = 30      # solicitudes por IP y por ventana (protege el servicio público y la cuota de Open-Meteo)
_historial = defaultdict(deque)

app = FastAPI(
    title="GeoTop · API de elevación",
    description="Intermediario FastAPI entre el visor Leaflet y Open-Meteo Elevation (Copernicus DEM GLO-90).",
    version="1.0.0",
)

# CORS: permite abrir el front-end con Live Server (otro puerto) o desde file://
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"], allow_headers=["*"])


class Punto(BaseModel):
    lat: float = Field(..., ge=-90, le=90, description="Latitud en grados decimales (Norte +)")
    lng: float = Field(..., ge=-180, le=180, description="Longitud en grados decimales (Este +)")


class SolicitudElevacion(BaseModel):
    puntos: List[Punto] = Field(..., min_length=1, max_length=MAX_PUNTOS)


class RespuestaElevacion(BaseModel):
    elevaciones: List[Optional[float]]   # metros s. n. m.; null = sin dato
    n: int
    unidad: str = "m"
    fuente: str = "Open-Meteo Elevation API (Copernicus DEM GLO-90)"


def _ip_cliente(request: Request) -> str:
    """IP real del visitante (detrás de un túnel/proxy llega en cabeceras)."""
    fwd = request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    return fwd or (request.client.host if request.client else "desconocida")


def limitar(request: Request) -> None:
    ahora, ip = time.monotonic(), _ip_cliente(request)
    h = _historial[ip]
    while h and ahora - h[0] > VENTANA_S:
        h.popleft()
    if len(h) >= MAX_SOLICITUDES:
        raise HTTPException(429, f"Demasiadas solicitudes: máximo {MAX_SOLICITUDES} por minuto. Espera un momento.")
    h.append(ahora)


@app.get("/api/salud")
def salud():
    """Comprobación rápida de que el servidor está activo."""
    return {"estado": "ok"}


@app.post("/api/elevacion", response_model=RespuestaElevacion)
async def elevacion(solicitud: SolicitudElevacion, request: Request):
    """Recibe puntos (lat, lng) y devuelve la elevación de cada uno, en el mismo orden."""
    limitar(request)
    puntos = solicitud.puntos
    params = {
        "latitude": ",".join(f"{p.lat:.6f}" for p in puntos),
        "longitude": ",".join(f"{p.lng:.6f}" for p in puntos),
    }
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            r = await client.get(OPEN_METEO_URL, params=params)
    except httpx.TimeoutException:
        raise HTTPException(504, "El servicio externo Open-Meteo no respondió a tiempo.")
    except httpx.HTTPError:
        raise HTTPException(502, "No se pudo contactar con Open-Meteo desde el servidor.")

    try:
        data = r.json()
    except ValueError:
        data = None
    if r.status_code != 200:
        motivo = data.get("reason") if isinstance(data, dict) else None
        codigo = 429 if r.status_code == 429 else 502
        raise HTTPException(codigo, f"Open-Meteo respondió HTTP {r.status_code}" + (f": {motivo}" if motivo else "."))

    elev = data.get("elevation") if isinstance(data, dict) else None
    if not isinstance(elev, list) or len(elev) != len(puntos):
        raise HTTPException(502, "Respuesta inesperada de Open-Meteo (campo «elevation» ausente o de tamaño incorrecto).")

    # null, texto, NaN o infinito → None (dato faltante; nunca se convierte en 0)
    limpias = [float(z) if isinstance(z, (int, float)) and not isinstance(z, bool) and math.isfinite(z) else None for z in elev]
    return RespuestaElevacion(elevaciones=limpias, n=len(limpias))


# ---------- Archivos del front-end (mismo origen → las teselas OSM reciben Referer) ----------
@app.get("/", include_in_schema=False)
def inicio():
    return FileResponse(BASE_DIR / "index.html")


for nombre in ("style.css", "script.js", "visor.js"):
    app.add_api_route(f"/{nombre}", (lambda n=nombre: FileResponse(BASE_DIR / n)), methods=["GET"], include_in_schema=False)

app.mount("/recursos", StaticFiles(directory=BASE_DIR / "recursos"), name="recursos")
