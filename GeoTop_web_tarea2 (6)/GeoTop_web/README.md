# GeoTop — Tarea 2: visor Leaflet de perfil topográfico

## Propósito
Herramienta del servicio de **Topografía/Cartografía** de GeoTop: el usuario traza una línea (2–10 vértices) sobre un mapa Leaflet y obtiene su **perfil de elevación**, longitud, azimut, desniveles y pendientes por tramo (mapa coloreado por clase de pendiente + gráfico interactivo).

## Arquitectura
`Navegador (Leaflet + fetch) → FastAPI (main.py, /api/elevacion) → Open-Meteo Elevation → FastAPI → Navegador (procesamiento en JS)`

### Back-end propio: FastAPI (`main.py`)
- `POST /api/elevacion` — cuerpo: `{"puntos":[{"lat":4.5,"lng":-75.6}, …]}` (1–100 puntos; Pydantic valida lat ∈ [−90, 90], lng ∈ [−180, 180]). Respuesta: `{"elevaciones":[z|null,…],"n":N,"unidad":"m","fuente":"…"}`.
- `GET /api/salud` — comprobación de estado. Documentación interactiva automática: `/docs`.
- Errores: 422 (datos inválidos), 429/502 (fallo o límite del servicio externo), 504 (tiempo agotado).

## Servicio externo (back-end de datos)
**Open-Meteo Elevation API** — https://open-meteo.com/en/docs/elevation-api (gratuita, sin clave, CORS habilitado; datos Copernicus DEM GLO-90, CC BY 4.0, uso no comercial).

- **Solicitud** (hecha por FastAPI con `httpx`, GET): `https://api.open-meteo.com/v1/elevation?latitude=lat1,lat2,…&longitude=lon1,lon2,…` (máx. 100 coordenadas, grados decimales WGS84).
- **Respuesta** (JSON): `{ "elevation": [z1, z2, …] }` en metros sobre el nivel del mar, un valor por coordenada. En error: `{ "error": true, "reason": "…" }`.

## Procesamiento en JavaScript (`visor.js`)
1. Validación de entradas y geometría (ver abajo).
2. Muestreo: reparto de N puntos proporcional a la longitud de cada tramo; interpolación por **círculo máximo (slerp)**.
3. Solicitud a la API con tiempo límite de 15 s y comprobación de la respuesta (estructura, longitud del arreglo, valores nulos).
4. Cálculo de distancia acumulada (haversine), pendiente por tramo, ascenso/descenso acumulado, mínimo/máximo, pendiente neta, azimut inicial/final.
5. Representación: tramos coloreados en el mapa, marcadores de máx./mín., perfil SVG; al pasar el cursor por el perfil se ubica el punto en el mapa.

## Unidades y convenciones
- Coordenadas WGS84 (EPSG:4326), grados decimales; latitud ∈ [−90, 90] (Norte +), longitud ∈ [−180, 180] (Este +). Se acepta coma decimal.
- Distancias en metros, esfera de radio 6 371 008.8 m. Elevaciones en metros s. n. m.
- **Azimut**: desde el Norte, sentido horario, rango [0°, 360°) (0° N, 90° E, 180° S, 270° O).
- **Pendiente** (%) = Δz / distancia horizontal × 100; **ángulo** = arctan(Δz/d) en grados, positivo = ascenso en el sentido del trazado.
- Las funciones trigonométricas operan en radianes; la conversión es explícita en el código.
- Calculadoras (sección «Herramientas»): coordenadas planas Norte/Este en metros; área con orientación indicada (planta, Norte arriba).

## Validaciones y casos especiales
- Entradas incompletas o no numéricas (`12abc`, vacío): se indica qué campo falta; fuera de rango o latitud/longitud intercambiadas: mensaje específico.
- Menos de 2 vértices, más de 10, muestras no enteras o fuera de [vértices, 100], longitud > 200 km.
- Vértices consecutivos coincidentes (< 1 m) → rechazados; vértices antípodas → rechazados (círculo máximo no único).
- Polos: azimut **indefinido**. Antimeridiano: longitudes normalizadas y trazado por círculo máximo.
- Elevaciones nulas/NaN: se tratan como «sin dato», nunca como 0; pendiente del tramo **indefinida**; si todas faltan, error.
- Perfil plano (z máx = z mín): el gráfico no divide por cero. Aviso cuando el espaciamiento < resolución del DEM (~90 m).
- Errores de red, tiempo agotado, HTTP 4xx/5xx (incluido 429) y JSON inválido se informan al usuario.
- Calculadoras: campos faltantes nombrados, distancia 0 (pendiente indefinida), puntos coincidentes (azimut indefinido), azimut normalizado sin «−0» ni «360.0000», vértices repetidos, polígonos colineales (área 0) y autointersecantes rechazados, restas de origen para evitar pérdida de precisión.

## Publicar sin depender de ningún PC
**Opción recomendada: GitHub Pages (gratis, siempre activo, sin servidor ni suspensión).**
1. Sube el contenido de esta carpeta a la raíz de un repositorio público de GitHub (`index.html` en la raíz).
2. *Settings → Pages → Build and deployment → Deploy from a branch → `main` / `/ (root)` → Save*.
3. En 1–2 minutos queda en `https://TU-USUARIO.github.io/NOMBRE-REPO/`. Ese enlace se comparte y abre en cualquier dispositivo.
En este modo el visor consulta Open-Meteo directamente desde JavaScript (`fetch`); el resultado es el mismo.

**Opción con back-end FastAPI en la nube: Render (gratis).** *New → Blueprint* sobre el repositorio (usa `render.yaml`); entrega `https://geotop-xxxx.onrender.com`, donde la página y la API FastAPI corren juntas. En el plan gratuito se duerme tras ~15 min sin visitas y la primera carga tarda ~30–60 s.

El visor usa FastAPI cuando existe y, si no está accesible, pasa automáticamente a Open-Meteo directo (el panel de estado indica la vía usada). `main.py` limita a 30 solicitudes por minuto y por IP. No hay claves ni datos privados en el proyecto.

## Cómo ejecutar en local (opcional)
1. **Extraer** el comprimido completo (no abrir desde dentro del .zip/.rar).
2. En una terminal, dentro de la carpeta del proyecto: `pip install -r requirements.txt` y `uvicorn main:app --reload`.
3. Abrir **http://127.0.0.1:8000** (FastAPI sirve también la página). Alternativa: Live Server sobre `index.html` con FastAPI activo en el puerto 8000.
4. Requiere **Internet** (Leaflet vía unpkg, teselas de OpenStreetMap, Open-Meteo).
5. En la sección **Visor**, hacer clic en el mapa 2 o más veces y pulsar **Calcular perfil**.
- Mapa base por defecto: **OpenStreetMap**. Su política de teselas exige Referer, por lo que debe abrirse por http; con `file://` el visor usa CARTO como respaldo.

## Atribuciones
© OpenStreetMap contributors · CARTO · OpenTopoMap (CC-BY-SA) · Esri (Topo e Imagery) · Open-Meteo / Copernicus DEM (CC BY 4.0) · Leaflet.

## Estructura
`index.html`, `style.css`, `script.js` (Tarea 1 + calculadoras), `visor.js` (visor Leaflet), `main.py` + `requirements.txt` (FastAPI), `render.yaml` (despliegue), `recursos/imagenes/`.
