/* =========================================================
   GeoTop | Visor de perfil topográfico (Leaflet + Open-Meteo Elevation API)

   Flujo: clic/entrada del usuario → validación → muestreo geodésico
   → fetch() POST a FastAPI → Open-Meteo → JSON → procesamiento → mapa + perfil + estadísticas.

   CONVENCIONES (se muestran también en la interfaz):
   · Coordenadas: latitud φ y longitud λ en grados decimales, WGS84 (EPSG:4326).
     φ positiva al Norte, λ positiva al Este. Rangos: φ ∈ [−90, 90], λ ∈ [−180, 180].
   · Distancias: metros, sobre esfera de radio medio R = 6 371 008.8 m (haversine).
   · Elevaciones: metros sobre el nivel del mar (DEM Copernicus GLO-90, ~90 m).
   · Azimut: grados desde el Norte, sentido horario, rango [0°, 360°).
   · Pendiente: % = Δz / distancia horizontal × 100; ángulo = atan(Δz/d) en grados,
     positivo = ascenso en el sentido del trazado.
   · Internamente todo ángulo trigonométrico se maneja en radianes.
   ========================================================= */
(() => {
  "use strict";

  /* Back-end FastAPI (main.py). Si la página la sirve FastAPI (localhost:8000, túnel público o hosting)
     se usa el mismo origen. Solo con file:// o con Live Server (localhost en otro puerto) se llama a
     http://127.0.0.1:8000 (CORS habilitado en el servidor). */
  const isLocalHost = ["localhost", "127.0.0.1", ""].includes(location.hostname);
  const API_BASE = location.protocol.startsWith("http") && !(isLocalHost && location.port !== "8000") ? "" : "http://127.0.0.1:8000";
  const API_URL = `${API_BASE}/api/elevacion`;
  const EARTH_RADIUS_M = 6371008.8;
  const DEG2RAD = Math.PI / 180, RAD2DEG = 180 / Math.PI;
  const MAX_API_POINTS = 100;          // límite de coordenadas por solicitud de la API
  const MAX_VERTICES = 10;
  const MAX_LENGTH_M = 200000;         // 200 km
  const MIN_LENGTH_M = 1;              // por debajo de 1 m la línea se considera degenerada
  const DEM_RESOLUTION_M = 90;
  const POLE_EPS_DEG = 1e-9;
  const REQUEST_TIMEOUT_MS = 15000;

  const el = id => document.getElementById(id);
  const mapEl = el("viewerMap");
  if (!mapEl) return;
  if (typeof L === "undefined") {   // Leaflet no cargó (sin Internet o CDN bloqueado)
    mapEl.innerHTML = "<p style='padding:24px'>No se pudo cargar Leaflet. Verifica tu conexión a Internet y recarga la página.</p>";
    return;
  }
  if (typeof L === "undefined") {   // Leaflet no cargó (sin Internet o bloqueado)
    mapEl.innerHTML = "<p style='padding:24px'>No se pudo cargar Leaflet desde unpkg.com. Verifica tu conexión a Internet y recarga la página.</p>";
    return;
  }

  /* ---------- Utilidades de formato y validación ---------- */
  const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "indefinido");
  const normLon = lon => ((((lon + 180) % 360) + 360) % 360) - 180;   // → [−180, 180)
  const normAz = deg => { let a = ((deg % 360) + 360) % 360; if (Number(a.toFixed(2)) >= 360) a = 0; return a + 0; };

  /* Lee un número de un campo de texto. Acepta coma decimal; rechaza "12abc", "", "NaN", "Infinity". */
  function parseCoord(text) {
    const t = String(text).trim().replace(",", ".");
    if (t === "" || !/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(t)) return null;
    const v = Number(t);
    return Number.isFinite(v) ? v : null;
  }
  function validateLatLon(lat, lon) {
    if (lat === null || lon === null) return "Latitud y longitud deben ser números válidos (grados decimales).";
    if (Math.abs(lat) > 90) {
      return Math.abs(lon) <= 90
        ? `Latitud ${lat}° fuera de [−90, 90]. ¿Intercambiaste latitud y longitud?`
        : `Latitud ${lat}° fuera del rango [−90, 90].`;
    }
    if (Math.abs(lon) > 180) return `Longitud ${lon}° fuera del rango [−180, 180].`;
    return null;
  }

  /* ---------- Geodesia esférica ---------- */
  const toVec = p => {
    const φ = p.lat * DEG2RAD, λ = p.lng * DEG2RAD;
    return [Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ)];
  };
  const fromVec = v => ({ lat: Math.asin(Math.max(-1, Math.min(1, v[2]))) * RAD2DEG, lng: normLon(Math.atan2(v[1], v[0]) * RAD2DEG) });

  /* Ángulo central entre dos puntos (rad), con haversine (estable para distancias cortas) */
  function centralAngle(a, b) {
    const φ1 = a.lat * DEG2RAD, φ2 = b.lat * DEG2RAD;
    const dφ = φ2 - φ1, dλ = (b.lng - a.lng) * DEG2RAD;
    const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
    return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  const distanceM = (a, b) => centralAngle(a, b) * EARTH_RADIUS_M;

  /* Punto a fracción f ∈ [0,1] del arco de círculo máximo a→b (slerp). Cruza el antimeridiano sin problema. */
  function interpolate(a, b, f) {
    const δ = centralAngle(a, b);
    if (δ < 1e-12) return { lat: a.lat, lng: a.lng };
    const va = toVec(a), vb = toVec(b);
    const k1 = Math.sin((1 - f) * δ) / Math.sin(δ), k2 = Math.sin(f * δ) / Math.sin(δ);
    return fromVec(va.map((x, i) => k1 * x + k2 * vb[i]));
  }

  /* Azimut inicial a→b (° desde el Norte, horario). Indefinido (null) si coinciden o si a es un polo. */
  function azimuthDeg(a, b) {
    if (Math.abs(a.lat) >= 90 - POLE_EPS_DEG) return null;       // en un polo todas las direcciones son "sur"/"norte"
    if (centralAngle(a, b) < 1e-12) return null;
    const φ1 = a.lat * DEG2RAD, φ2 = b.lat * DEG2RAD, dλ = (b.lng - a.lng) * DEG2RAD;
    const y = Math.sin(dλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
    if (Math.abs(x) < 1e-15 && Math.abs(y) < 1e-15) return null; // puntos antípodas: infinitas direcciones
    return normAz(Math.atan2(y, x) * RAD2DEG);
  }
  /* Azimut final: dirección de llegada = contra-azimut del azimut inicial b→a, + 180° */
  const finalAzimuthDeg = (a, b) => { const back = azimuthDeg(b, a); return back === null ? null : normAz(back + 180); };

  /* ---------- Estado ---------- */
  let vertices = [];            // [{lat, lng}]
  let markers = [];
  let busy = false;
  const state = { samples: [], layerGroup: null, hoverMarker: null };

  /* ---------- Mapa Leaflet ---------- */
  const map = L.map(mapEl, { center: [4.5339, -75.6811], zoom: 11, worldCopyJump: true });
  /* OpenStreetMap es la base por defecto. Su política de teselas exige cabecera Referer, por lo que
     requiere que la página se sirva por http(s) (p. ej. http://127.0.0.1:8000 con FastAPI o Live Server).
     Si se abre con file:// (doble clic), OSM responde 403 y se usa CARTO (datos OSM) como respaldo. */
  const isHttp = location.protocol.startsWith("http");
  const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, referrerPolicy: "origin",
    attribution: "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors"
  });
  const carto = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd", maxZoom: 19,
    attribution: "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> &copy; <a href='https://carto.com/attributions'>CARTO</a>"
  });
  const topo = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxZoom: 17, referrerPolicy: "origin",
    attribution: "&copy; OpenStreetMap, SRTM | estilo &copy; <a href='https://opentopomap.org'>OpenTopoMap</a> (CC-BY-SA)"
  });
  const sat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19, attribution: "Imágenes &copy; Esri, Maxar, Earthstar Geographics"
  });
  const bases = isHttp
    ? { "OpenStreetMap": osm, "OpenTopoMap": topo, "Satélite (Esri)": sat }
    : { "OpenStreetMap (requiere http)": osm, "Calles (CARTO)": carto, "Satélite (Esri)": sat };
  (isHttp ? osm : carto).addTo(map);
  L.control.layers(bases, null, { collapsed: true }).addTo(map);
  L.control.scale({ metric: true, imperial: false }).addTo(map);
  state.layerGroup = L.layerGroup().addTo(map);
  const lineLayer = L.polyline([], { color: "#19d38a", weight: 3, dashArray: "6 6" }).addTo(map);

  /* ---------- Interfaz ---------- */
  const statusEl = el("viewerStatus"), statsEl = el("viewerStats"), chartEl = el("profileChart"),
        vertexList = el("vertexList"), latInput = el("latInput"), lonInput = el("lonInput"),
        samplesInput = el("samplesInput"), calcBtn = el("profileButton");

  function setStatus(msg, kind = "info") {
    statusEl.textContent = msg;
    statusEl.className = "viewer-status " + kind;
  }

  function refreshVertices() {
    lineLayer.setLatLngs(vertices.map(v => [v.lat, v.lng]));
    markers.forEach(m => m.remove());
    markers = vertices.map((v, i) => {
      const m = L.marker([v.lat, v.lng], { draggable: true, title: `V${i + 1}` }).addTo(map);
      m.bindTooltip(`V${i + 1}`, { permanent: true, direction: "top", offset: [-15, -8] });
      m.on("dragend", () => {
        const ll = map.wrapLatLng(m.getLatLng());
        vertices[i] = { lat: ll.lat, lng: ll.lng };
        clearResults(); refreshVertices();
      });
      return m;
    });
    vertexList.innerHTML = vertices.length
      ? vertices.map((v, i) => `<li><span>V${i + 1}</span> φ ${v.lat.toFixed(5)}° · λ ${v.lng.toFixed(5)}°<button type="button" data-i="${i}" aria-label="Eliminar V${i + 1}">✕</button></li>`).join("")
      : "<li class='empty'>Sin vértices. Haz clic en el mapa o ingresa coordenadas.</li>";
  }

  function clearResults() {
    state.layerGroup.clearLayers();
    state.hoverMarker = null;
    state.samples = [];
    statsEl.innerHTML = "";
    chartEl.innerHTML = "";
  }

  /* Agrega un vértice validando entrada y límites */
  function addVertex(lat, lng) {
    const err = validateLatLon(lat, lng);
    if (err) { setStatus(err, "error"); return false; }
    if (vertices.length >= MAX_VERTICES) { setStatus(`Máximo ${MAX_VERTICES} vértices por perfil.`, "error"); return false; }
    const p = { lat, lng: normLon(lng) };
    const last = vertices[vertices.length - 1];
    if (last && distanceM(last, p) < MIN_LENGTH_M) {
      setStatus("Este vértice coincide con el anterior (< 1 m): se ignoró para no crear un tramo de longitud cero.", "error");
      return false;
    }
    vertices.push(p);
    clearResults(); refreshVertices();
    setStatus(vertices.length < 2 ? "Agrega al menos un vértice más." : "Listo: pulsa «Calcular perfil».", "info");
    return true;
  }

  map.on("click", e => { const ll = map.wrapLatLng(e.latlng); addVertex(ll.lat, ll.lng); });

  el("addVertexButton").addEventListener("click", () => {
    const lat = parseCoord(latInput.value), lon = parseCoord(lonInput.value);
    const missing = [];
    if (latInput.value.trim() === "") missing.push("latitud");
    if (lonInput.value.trim() === "") missing.push("longitud");
    if (missing.length) { setStatus(`Falta ${missing.join(" y ")}.`, "error"); return; }
    if (addVertex(lat, lon)) { latInput.value = ""; lonInput.value = ""; map.panTo([vertices[vertices.length - 1].lat, vertices[vertices.length - 1].lng]); }
  });
  vertexList.addEventListener("click", e => {
    const btn = e.target.closest("button[data-i]");
    if (!btn) return;
    vertices.splice(Number(btn.dataset.i), 1);
    clearResults(); refreshVertices(); setStatus("Vértice eliminado.", "info");
  });
  el("undoButton").addEventListener("click", () => { vertices.pop(); clearResults(); refreshVertices(); setStatus("Último vértice eliminado.", "info"); });
  el("clearButton").addEventListener("click", () => { vertices = []; clearResults(); refreshVertices(); setStatus("Mapa limpio. Define un nuevo trazado.", "info"); });
  el("fitButton").addEventListener("click", () => { if (vertices.length) map.fitBounds(L.latLngBounds(vertices.map(v => [v.lat, v.lng])).pad(0.2)); });

  /* ---------- Validación de la geometría completa ---------- */
  function validateGeometry() {
    if (vertices.length < 2) return { error: "Define al menos 2 vértices para trazar un perfil." };
    const nSamples = Number(samplesInput.value);
    if (samplesInput.value.trim() === "" || !Number.isInteger(nSamples)) return { error: "El número de puntos de muestreo debe ser un entero." };
    if (nSamples < vertices.length || nSamples > MAX_API_POINTS) {
      return { error: `Muestras: entero entre ${vertices.length} (un punto por vértice) y ${MAX_API_POINTS} (límite de la API).` };
    }
    const segLen = [];
    for (let i = 0; i < vertices.length - 1; i++) {
      const a = vertices[i], b = vertices[i + 1];
      const δ = centralAngle(a, b);
      if (δ * RAD2DEG > 179.999) return { error: `Los vértices V${i + 1} y V${i + 2} son antípodas: el círculo máximo entre ellos no es único.` };
      const d = δ * EARTH_RADIUS_M;
      if (!(d >= MIN_LENGTH_M)) return { error: `El tramo V${i + 1}–V${i + 2} mide menos de ${MIN_LENGTH_M} m (longitud cero): azimut y pendiente indefinidos.` };
      segLen.push(d);
    }
    const total = segLen.reduce((s, x) => s + x, 0);
    if (total > MAX_LENGTH_M) return { error: `Longitud total ${fmt(total / 1000, 1)} km excede el máximo de ${MAX_LENGTH_M / 1000} km.` };
    return { nSamples, segLen, total };
  }

  /* Reparte las muestras entre tramos (proporcional a su longitud) y genera los puntos */
  function buildSamples(geo) {
    const { nSamples, segLen, total } = geo;
    const nSeg = segLen.length;
    let counts = segLen.map(l => Math.max(1, Math.round((nSamples - 1) * l / total)));   // intervalos por tramo
    let sum = counts.reduce((s, c) => s + c, 0);
    while (sum > nSamples - 1) { const i = counts.indexOf(Math.max(...counts)); if (counts[i] <= 1) break; counts[i]--; sum--; }
    const pts = [];
    let acc = 0;
    for (let s = 0; s < nSeg; s++) {
      const a = vertices[s], b = vertices[s + 1];
      for (let k = (s === 0 ? 0 : 1); k <= counts[s]; k++) {
        const f = k / counts[s];
        const p = k === counts[s] ? { lat: b.lat, lng: b.lng } : (k === 0 ? { lat: a.lat, lng: a.lng } : interpolate(a, b, f));
        pts.push({ ...p, dist: acc + f * segLen[s], seg: s });
      }
      acc += segLen[s];
    }
    return pts;
  }

  /* ---------- Solicitud a la API ---------- */
  /* Vía principal: FastAPI  POST /api/elevacion  { puntos:[{lat,lng}] } → { elevaciones:[z|null,…] }.
     Respaldo: GET directo a Open-Meteo (https://api.open-meteo.com/v1/elevation) → { elevation:[…] }.
     El respaldo se usa en hosting estático (GitHub Pages) o si el servidor FastAPI no está accesible,
     de modo que la página funciona sin depender de ningún PC. */
  const OPEN_METEO_URL = "https://api.open-meteo.com/v1/elevation";
  const STATIC_HOST = location.hostname.endsWith(".github.io");   // sin servidor propio

  async function timedFetch(url, options) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try { return await fetch(url, { ...options, signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
  }
  async function readJson(response) { try { return await response.json(); } catch { return null; } }
  const cleanElevations = (arr, n) => {
    if (!Array.isArray(arr)) throw new Error("La respuesta del servicio no contiene elevaciones.");
    if (arr.length !== n) throw new Error(`El servicio devolvió ${arr.length} elevaciones para ${n} puntos.`);
    /* null, texto o NaN → dato faltante (null); nunca se convierte en 0 */
    return arr.map(z => (typeof z === "number" && Number.isFinite(z) ? z : null));
  };

  async function viaFastApi(points) {
    const body = JSON.stringify({ puntos: points.map(p => ({ lat: Number(p.lat.toFixed(6)), lng: Number(p.lng.toFixed(6)) })) });
    const response = await timedFetch(API_URL, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body });
    const data = await readJson(response);
    if (!response.ok) {
      let reason = "";
      if (data && typeof data.detail === "string") reason = data.detail;
      else if (data && Array.isArray(data.detail)) reason = "datos inválidos (" + data.detail.map(d => d.msg).join("; ") + ")";
      const e = new Error(response.status === 429 ? "Límite de solicitudes alcanzado; espera un minuto." : `Error ${response.status} del servidor${reason ? ": " + reason : "."}`);
      e.http = true; throw e;
    }
    return cleanElevations(data && data.elevaciones, points.length);
  }

  async function viaOpenMeteo(points) {
    const params = new URLSearchParams({
      latitude: points.map(p => p.lat.toFixed(6)).join(","),
      longitude: points.map(p => p.lng.toFixed(6)).join(",")
    });
    const response = await timedFetch(`${OPEN_METEO_URL}?${params}`, { headers: { Accept: "application/json" } });
    const data = await readJson(response);
    if (!response.ok) {
      const reason = data && data.reason ? ` Motivo: ${data.reason}` : "";
      throw new Error(response.status === 429 ? "Límite de solicitudes de Open-Meteo alcanzado; espera un minuto." : `Open-Meteo respondió HTTP ${response.status}.${reason}`);
    }
    return cleanElevations(data && data.elevation, points.length);
  }

  async function fetchElevations(points) {
    try {
      if (!STATIC_HOST) {
        try { const z = await viaFastApi(points); return { z, via: "FastAPI → Open-Meteo" }; }
        catch (err) {
          if (err.http || err.name === "AbortError") throw err;     // error del servidor: no se reintenta
          /* sin conexión con FastAPI → respaldo directo */
        }
      }
      return { z: await viaOpenMeteo(points), via: "Open-Meteo directo" };
    } catch (err) {
      if (err.name === "AbortError") throw new Error("El servicio no respondió a tiempo (15 s).");
      if (err instanceof TypeError) throw new Error("No hay conexión con el servicio de elevación. Verifica tu Internet.");
      throw err;
    }
  }

  /* ---------- Procesamiento ---------- */
  function slopeClass(pct) {
    if (pct === null) return { color: "#8d9a95", label: "indefinida" };
    const a = Math.abs(pct);
    if (a < 5) return { color: "#19d38a", label: "< 5 %" };
    if (a < 15) return { color: "#e6c229", label: "5–15 %" };
    if (a < 30) return { color: "#f08a24", label: "15–30 %" };
    return { color: "#e5484d", label: "> 30 %" };
  }

  function analyse(points, elev) {
    const pts = points.map((p, i) => ({ ...p, z: elev[i] }));
    const segs = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], run = b.dist - a.dist;
      const valid = a.z !== null && b.z !== null && run > 0;
      const rise = valid ? b.z - a.z : null;
      segs.push({
        a, b, run, rise,
        slopePct: valid ? (rise / run) * 100 : null,
        slopeDeg: valid ? Math.atan(rise / run) * RAD2DEG : null
      });
    }
    const valids = pts.filter(p => p.z !== null);
    const missing = pts.length - valids.length;
    const out = { pts, segs, missing, total: pts[pts.length - 1].dist };
    if (!valids.length) return out;
    const zs = valids.map(p => p.z);
    out.zMin = Math.min(...zs); out.zMax = Math.max(...zs);
    out.pMin = valids.find(p => p.z === out.zMin); out.pMax = valids.find(p => p.z === out.zMax);
    out.ascent = segs.reduce((s, g) => s + (g.rise > 0 ? g.rise : 0), 0);
    out.descent = segs.reduce((s, g) => s + (g.rise < 0 ? -g.rise : 0), 0);
    const first = pts[0], last = pts[pts.length - 1];
    out.netSlopePct = first.z !== null && last.z !== null && out.total > 0 ? ((last.z - first.z) / out.total) * 100 : null;
    out.netSlopeDeg = out.netSlopePct === null ? null : Math.atan(out.netSlopePct / 100) * RAD2DEG;
    const withSlope = segs.filter(g => g.slopePct !== null);
    if (withSlope.length) {
      out.maxUp = withSlope.reduce((m, g) => (g.slopePct > m.slopePct ? g : m));
      out.maxDown = withSlope.reduce((m, g) => (g.slopePct < m.slopePct ? g : m));
    }
    out.spacing = out.total / (pts.length - 1);
    return out;
  }

  /* ---------- Presentación ---------- */
  function render(res) {
    state.layerGroup.clearLayers();
    state.samples = res.pts;
    res.segs.forEach(g => {
      const c = slopeClass(g.slopePct);
      const poly = L.polyline([[g.a.lat, g.a.lng], [g.b.lat, g.b.lng]], { color: c.color, weight: 6, opacity: 0.95, dashArray: g.slopePct === null ? "4 6" : null });
      poly.bindPopup(g.slopePct === null
        ? "Pendiente <b>indefinida</b> (falta elevación en un extremo)."
        : `Pendiente: <b>${g.slopePct.toFixed(1)} %</b> (${g.slopeDeg.toFixed(1)}°)<br>Δz: ${g.rise.toFixed(1)} m en ${g.run.toFixed(0)} m`);
      poly.addTo(state.layerGroup);
    });
    if (res.pMax) L.circleMarker([res.pMax.lat, res.pMax.lng], { radius: 7, color: "#fff", fillColor: "#e5484d", fillOpacity: 1, weight: 2 }).bindTooltip(`Máx: ${res.zMax.toFixed(0)} m`).addTo(state.layerGroup);
    if (res.pMin) L.circleMarker([res.pMin.lat, res.pMin.lng], { radius: 7, color: "#fff", fillColor: "#3b82f6", fillOpacity: 1, weight: 2 }).bindTooltip(`Mín: ${res.zMin.toFixed(0)} m`).addTo(state.layerGroup);
    state.hoverMarker = L.circleMarker([res.pts[0].lat, res.pts[0].lng], { radius: 6, color: "#06100d", fillColor: "#fff", fillOpacity: 1, weight: 2 });
    map.fitBounds(L.latLngBounds(res.pts.map(p => [p.lat, p.lng])).pad(0.25));

    const first = vertices[0], last = vertices[vertices.length - 1];
    const azI = azimuthDeg(first, last), azF = finalAzimuthDeg(first, last);
    const azTxt = azI === null ? "indefinido (puntos coincidentes, antípodas o polo)" : `${azI.toFixed(2)}° → ${azF === null ? "indefinido" : azF.toFixed(2) + "°"}`;
    const rows = [
      ["Longitud del trazado", `${fmt(res.total / 1000, 3)} km (${fmt(res.total, 0)} m)`],
      ["Azimut cuerda V1→Vn (inicial → final)", azTxt],
      ["Elevación mín. / máx.", res.zMin === undefined ? "indefinida" : `${fmt(res.zMin, 1)} m / ${fmt(res.zMax, 1)} m s. n. m.`],
      ["Desnivel máx.−mín.", res.zMin === undefined ? "indefinido" : `${fmt(res.zMax - res.zMin, 1)} m`],
      ["Ascenso / descenso acumulado", res.zMin === undefined ? "indefinido" : `+${fmt(res.ascent, 1)} m / −${fmt(res.descent, 1)} m`],
      ["Pendiente neta (inicio→fin)", res.netSlopePct === null || res.netSlopePct === undefined ? "indefinida" : `${fmt(res.netSlopePct, 2)} % (${fmt(res.netSlopeDeg, 2)}°)`],
      ["Máx. pendiente de subida", res.maxUp ? `${fmt(res.maxUp.slopePct, 1)} % (${fmt(res.maxUp.slopeDeg, 1)}°)` : "indefinida"],
      ["Máx. pendiente de bajada", res.maxDown ? `${fmt(res.maxDown.slopePct, 1)} % (${fmt(res.maxDown.slopeDeg, 1)}°)` : "indefinida"],
      ["Espaciamiento entre muestras", `${fmt(res.spacing, 0)} m`]
    ];
    const warnings = [];
    if (res.spacing < DEM_RESOLUTION_M) warnings.push(`El espaciamiento (${fmt(res.spacing, 0)} m) es menor que la resolución del DEM (~${DEM_RESOLUTION_M} m): varias muestras comparten el mismo píxel y las pendientes locales pueden resultar 0 % o irreales.`);
    if (res.missing) warnings.push(`${res.missing} punto(s) sin elevación (zonas sin datos, p. ej. océano): se excluyeron de las estadísticas y sus tramos tienen pendiente indefinida.`);
    if (vertices.some(v => Math.abs(v.lat) >= 90 - POLE_EPS_DEG)) warnings.push("Un vértice está en un polo: la longitud no tiene significado allí y el azimut puede ser indefinido.");
    if (vertices.some((v, i) => i && Math.abs(v.lng - vertices[i - 1].lng) > 180)) warnings.push("El trazado cruza el antimeridiano (±180°); se calcula por círculo máximo, pero el mapa puede mostrar el tramo por el lado opuesto.");
    statsEl.innerHTML =
      `<table class="stats-table"><tbody>${rows.map(r => `<tr><th>${r[0]}</th><td>${r[1]}</td></tr>`).join("")}</tbody></table>` +
      `<div class="legend"><span><i style="background:#19d38a"></i>&lt; 5 %</span><span><i style="background:#e6c229"></i>5–15 %</span><span><i style="background:#f08a24"></i>15–30 %</span><span><i style="background:#e5484d"></i>&gt; 30 %</span><span><i style="background:#8d9a95"></i>indefinida</span></div>` +
      warnings.map(w => `<p class="viewer-warning">⚠ ${w}</p>`).join("");
    drawChart(res);
  }

  /* Perfil en SVG: x = distancia acumulada (km), y = elevación (m). Maneja perfil plano y datos faltantes. */
  function drawChart(res) {
    if (res.zMin === undefined) { chartEl.innerHTML = "<p class='viewer-warning'>Sin elevaciones válidas para dibujar el perfil.</p>"; return; }
    const W = 640, H = 240, m = { l: 56, r: 14, t: 14, b: 38 };
    let zLo = res.zMin, zHi = res.zMax;
    if (zHi - zLo < 1) { zLo -= 5; zHi += 5; }                         // perfil plano: evita división por cero
    const pad = (zHi - zLo) * 0.08; zLo -= pad; zHi += pad;
    const X = d => m.l + (d / res.total) * (W - m.l - m.r);
    const Y = z => H - m.b - ((z - zLo) / (zHi - zLo)) * (H - m.t - m.b);
    let path = "", pen = false;
    res.pts.forEach(p => { if (p.z === null) { pen = false; return; } path += `${pen ? "L" : "M"}${X(p.dist).toFixed(1)},${Y(p.z).toFixed(1)} `; pen = true; });
    const yTicks = [0, 1, 2, 3, 4].map(i => zLo + ((zHi - zLo) * i) / 4);
    const xTicks = [0, 1, 2, 3, 4].map(i => (res.total * i) / 4);
    const area = path && res.pts.every(p => p.z !== null) ? `${path}L${X(res.total).toFixed(1)},${Y(zLo)} L${X(0)},${Y(zLo)} Z` : "";
    chartEl.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Perfil de elevación" id="profileSvg">
        ${yTicks.map(t => `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(t)}" y2="${Y(t)}" class="grid"/><text x="${m.l - 6}" y="${Y(t) + 4}" text-anchor="end">${t.toFixed(0)}</text>`).join("")}
        ${xTicks.map(t => `<text x="${X(t)}" y="${H - m.b + 16}" text-anchor="middle">${(t / 1000).toFixed(res.total < 10000 ? 2 : 1)}</text>`).join("")}
        <text x="${(W + m.l) / 2}" y="${H - 4}" text-anchor="middle" class="axis">Distancia acumulada (km)</text>
        <text transform="translate(12 ${(H - m.b + m.t) / 2}) rotate(-90)" text-anchor="middle" class="axis">Elevación (m s. n. m.)</text>
        ${area ? `<path d="${area}" class="area"/>` : ""}
        <path d="${path}" class="line"/>
        <line id="cursorLine" y1="${m.t}" y2="${H - m.b}" class="cursor" style="display:none"/>
        <rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent" id="chartHit"/>
      </svg><div id="chartReadout" class="chart-readout">Pasa el cursor sobre el perfil para ubicar el punto en el mapa.</div>`;
    const svg = el("profileSvg"), hit = el("chartHit"), cur = el("cursorLine"), out = el("chartReadout");
    hit.addEventListener("mousemove", ev => {
      const r = svg.getBoundingClientRect();
      const x = ((ev.clientX - r.left) / r.width) * W;
      const d = Math.max(0, Math.min(res.total, ((x - m.l) / (W - m.l - m.r)) * res.total));
      const p = res.pts.reduce((best, q) => (Math.abs(q.dist - d) < Math.abs(best.dist - d) ? q : best));
      cur.setAttribute("x1", X(p.dist)); cur.setAttribute("x2", X(p.dist)); cur.style.display = "";
      state.hoverMarker.setLatLng([p.lat, p.lng]).addTo(map);
      out.textContent = `km ${(p.dist / 1000).toFixed(3)} · φ ${p.lat.toFixed(5)}° λ ${p.lng.toFixed(5)}° · z ${p.z === null ? "sin dato" : p.z.toFixed(1) + " m"}`;
    });
    hit.addEventListener("mouseleave", () => { cur.style.display = "none"; state.hoverMarker.remove(); });
  }

  /* ---------- Orquestación del botón principal ---------- */
  calcBtn.addEventListener("click", async () => {
    if (busy) return;
    const geo = validateGeometry();
    if (geo.error) { setStatus(geo.error, "error"); return; }
    busy = true; calcBtn.disabled = true; calcBtn.textContent = "Consultando API…";
    setStatus("Consultando elevaciones…", "info");
    try {
      const points = buildSamples(geo);
      const { z: elev, via } = await fetchElevations(points);
      if (elev.every(z => z === null)) throw new Error("La API no devolvió elevaciones válidas para este trazado (¿zona sin cobertura?).");
      render(analyse(points, elev));
      setStatus(`Perfil calculado con ${points.length} puntos (${via}).`, "ok");
    } catch (err) {
      console.error(err);
      setStatus(err.message || "Error inesperado al calcular el perfil.", "error");
    } finally {
      busy = false; calcBtn.disabled = false; calcBtn.textContent = "Calcular perfil";
    }
  });

  refreshVertices();
  setStatus(isHttp ? "Haz clic en el mapa para agregar vértices (mínimo 2)."
    : "Abierto con file://: OpenStreetMap bloquea este modo, se usa CARTO. Para ver OSM abre http://127.0.0.1:8000.", "info");
  /* Invalida el tamaño cuando cambia el diseño (menú móvil, tema) */
  window.addEventListener("resize", () => map.invalidateSize());
})();
