/* GeoTop | Interacciones, cálculos geomáticos y formulario */
"use strict";

const FORM_ENDPOINT = "https://formsubmit.co/ajax/juanestebangallegomesa7@gmail.com";
const $ = (selector) => document.querySelector(selector);

/* TEMA */
const themeButton = $("#themeButton");
const savedTheme = localStorage.getItem("geotop-theme");
if (savedTheme === "light") document.body.classList.add("light-mode");
function updateThemeButton(){const light=document.body.classList.contains("light-mode");themeButton.textContent=light?"☀":"☾";themeButton.setAttribute("aria-label",light?"Activar modo oscuro":"Activar modo claro");}
updateThemeButton();
themeButton.addEventListener("click",()=>{const light=document.body.classList.toggle("light-mode");localStorage.setItem("geotop-theme",light?"light":"dark");updateThemeButton();});

/* MENÚ */
const menuButton=$("#menuButton"), navbar=$("#navbar");
menuButton.addEventListener("click",()=>{const open=navbar.classList.toggle("open");menuButton.setAttribute("aria-expanded",String(open));menuButton.textContent=open?"✕":"☰";});
navbar.querySelectorAll("a").forEach(link=>link.addEventListener("click",()=>{navbar.classList.remove("open");menuButton.setAttribute("aria-expanded","false");menuButton.textContent="☰";}));

/* NAVEGACIÓN ACTIVA */
const sections=document.querySelectorAll("main section[id]"), navLinks=document.querySelectorAll(".navbar a");
if("IntersectionObserver" in window){const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting)navLinks.forEach(link=>link.classList.toggle("active",link.getAttribute("href")===`#${entry.target.id}`));}),{rootMargin:"-35% 0px -55% 0px"});sections.forEach(section=>observer.observe(section));}

/* =========================================================
   HERRAMIENTAS GEOMÁTICAS (calculadoras)
   Convenciones generales (explícitas también en la interfaz):
   · Coordenadas planas: Norte (N) y Este (E), en metros.
   · Azimut: grados sexagesimales decimales, medido desde el Norte
     en sentido horario, intervalo [0°, 360°).
   · Ángulo de inclinación: grados sobre la horizontal, positivo = ascenso.
   · Las funciones trigonométricas de JavaScript trabajan en radianes;
     toda conversión se hace con RAD2DEG / DEG2RAD.
   ========================================================= */
const RAD2DEG = 180 / Math.PI;

/* Lee un campo numérico. Devuelve null si está vacío o no es un número finito. */
function readNumber(input) {
  const raw = input.value.trim();
  if (raw === "") return null;
  const value = Number(raw.replace(",", "."));
  return Number.isFinite(value) ? value : null;
}
function showResult(box, html, isError = false) {
  box.innerHTML = html;
  box.classList.toggle("error", isError);
}
/* Normaliza un ángulo a [0, 360) evitando "-0" y el redondeo visual a 360.0000 */
function normalizeAzimuth(deg, decimals = 4) {
  let a = ((deg % 360) + 360) % 360;
  if (Number(a.toFixed(decimals)) >= 360) a = 0;
  return a + 0;
}

/* ---------- 01 · PENDIENTE ---------- */
const calculateButton = $("#calculateButton"), distanceInput = $("#distance"),
      elevationInput = $("#elevation"), result = $("#result");

function calculateSlope() {
  const distance = readNumber(distanceInput), elevation = readNumber(elevationInput);
  const missing = [];
  if (distance === null) missing.push("distancia horizontal");
  if (elevation === null) missing.push("desnivel");
  if (missing.length) {
    showResult(result, `Falta ${missing.join(" y ")} (número válido, en metros).`);
    return;
  }
  if (distance <= 0) {
    showResult(result, "La distancia horizontal debe ser mayor que cero: con distancia 0 la pendiente es indefinida.", true);
    return;
  }
  const ratio = elevation / distance;                // m/m, con signo
  if (!Number.isFinite(ratio)) {
    showResult(result, "Los valores son demasiado grandes o pequeños para calcular la pendiente.", true);
    return;
  }
  const slope = ratio * 100;                         // %
  const angle = Math.atan(ratio) * RAD2DEG;          // grados, (−90°, +90°)
  const sense = elevation > 0 ? "ascendente" : elevation < 0 ? "descendente" : "horizontal";
  const steep = Math.abs(angle) > 45 ? "<br><small>Inclinación mayor a 45°: verifica que la distancia sea horizontal, no inclinada.</small>" : "";
  showResult(result,
    `Pendiente: <strong>${slope.toFixed(2)} %</strong> (${sense})<br>` +
    `Ángulo de inclinación: <strong>${angle.toFixed(2)}°</strong><br>` +
    `<small>Pendiente % = desnivel / distancia horizontal × 100. Ángulo sobre la horizontal, positivo = ascenso.</small>${steep}`);
}
calculateButton.addEventListener("click", calculateSlope);
[distanceInput, elevationInput].forEach(i => i.addEventListener("input", calculateSlope));

/* ---------- 02 · DISTANCIA Y AZIMUT (plano N/E) ---------- */
const azimuthButton = $("#calculateAzimuth"), azimuthResult = $("#azimuthResult");
azimuthButton.addEventListener("click", () => {
  const fields = [["P1 Norte", "#p1n"], ["P1 Este", "#p1e"], ["P2 Norte", "#p2n"], ["P2 Este", "#p2e"]];
  const values = fields.map(([, sel]) => readNumber($(sel)));
  const missing = fields.filter((_, i) => values[i] === null).map(([name]) => name);
  if (missing.length) {
    showResult(azimuthResult, `Completa con números válidos: ${missing.join(", ")}.`, true);
    return;
  }
  const [n1, e1, n2, e2] = values;
  const dN = n2 - n1, dE = e2 - e1, d = Math.hypot(dN, dE);
  if (!Number.isFinite(d)) {
    showResult(azimuthResult, "Las coordenadas producen una distancia no representable.", true);
    return;
  }
  if (d === 0) {
    showResult(azimuthResult,
      `P1 y P2 coinciden: distancia = <strong>0.000 m</strong> y azimut <strong>indefinido</strong> (no existe dirección entre puntos idénticos).`, true);
    return;
  }
  const az = normalizeAzimuth(Math.atan2(dE, dN) * RAD2DEG);   // atan2(Este, Norte) → desde el Norte, horario
  const back = normalizeAzimuth(az + 180);
  showResult(azimuthResult,
    `ΔN: <strong>${dN.toFixed(3)} m</strong> · ΔE: <strong>${dE.toFixed(3)} m</strong><br>` +
    `Distancia horizontal: <strong>${d.toFixed(3)} m</strong><br>` +
    `Azimut P1→P2: <strong>${az.toFixed(4)}°</strong> · Contra-azimut: <strong>${back.toFixed(4)}°</strong><br>` +
    `<small>Azimut desde el Norte, sentido horario, rango [0°, 360°). 0° = Norte, 90° = Este.</small>`);
});

/* ---------- 03 · ÁREA Y PERÍMETRO ---------- */
const polygonRows = $("#polygonRows"), addPoint = $("#addPoint"),
      calculatePolygon = $("#calculatePolygon"), polygonResult = $("#polygonResult");
let pointCount = 0;
function addPolygonPoint(n = "", e = "") {
  pointCount++;
  const tr = document.createElement("tr");
  tr.dataset.point = String(pointCount);
  tr.innerHTML = `<td>P${pointCount}</td><td><input class="poly-n" type="number" step="any" value="${n}" placeholder="Norte"></td><td><input class="poly-e" type="number" step="any" value="${e}" placeholder="Este"></td><td><button type="button" class="remove-point" aria-label="Eliminar P${pointCount}">✕</button></td>`;
  tr.querySelector(".remove-point").addEventListener("click", () => { tr.remove(); renumberPoints(); });
  polygonRows.appendChild(tr);
}
function renumberPoints() {
  [...polygonRows.querySelectorAll("tr")].forEach((tr, i) => {
    tr.dataset.point = String(i + 1);
    tr.children[0].textContent = `P${i + 1}`;
    tr.querySelector(".remove-point").setAttribute("aria-label", `Eliminar P${i + 1}`);
  });
  pointCount = polygonRows.children.length;
}
addPoint.addEventListener("click", () => addPolygonPoint());
addPolygonPoint(1000, 500); addPolygonPoint(1080, 560); addPolygonPoint(1030, 680);

/* Orientación de c respecto al segmento a→b (producto cruz, x = Este, y = Norte) */
function orient(a, b, c) { return (b.e - a.e) * (c.n - a.n) - (b.n - a.n) * (c.e - a.e); }
function onSegment(a, b, c) {
  return Math.min(a.e, b.e) <= c.e && c.e <= Math.max(a.e, b.e) && Math.min(a.n, b.n) <= c.n && c.n <= Math.max(a.n, b.n);
}
function segmentsIntersect(a, b, c, d) {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  return (o1 === 0 && onSegment(a, b, c)) || (o2 === 0 && onSegment(a, b, d)) ||
         (o3 === 0 && onSegment(c, d, a)) || (o4 === 0 && onSegment(c, d, b));
}
/* Una poligonal es simple si ningún par de lados NO contiguos se cruza ni se toca */
function isSimplePolygon(pts) {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      if (adjacent) continue;
      if (segmentsIntersect(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return false;
    }
  }
  return true;
}

calculatePolygon.addEventListener("click", () => {
  const rows = [...polygonRows.querySelectorAll("tr")];
  const pts = [], problems = [];
  let emptyRows = 0;
  rows.forEach((tr, i) => {
    const nInput = tr.querySelector(".poly-n"), eInput = tr.querySelector(".poly-e");
    const n = readNumber(nInput), e = readNumber(eInput);
    const nEmpty = nInput.value.trim() === "", eEmpty = eInput.value.trim() === "";
    if (nEmpty && eEmpty) { emptyRows++; return; }                 // fila vacía: se ignora
    if (n === null || e === null) { problems.push(`P${i + 1}`); return; } // incompleta o no numérica
    pts.push({ n, e });
  });
  if (problems.length) {
    showResult(polygonResult, `Coordenada incompleta o no numérica en: ${problems.join(", ")}.`, true);
    return;
  }
  /* Elimina vértices consecutivos repetidos y el cierre explícito (último = primero) */
  const clean = [];
  pts.forEach(p => { const last = clean[clean.length - 1]; if (!last || last.n !== p.n || last.e !== p.e) clean.push(p); });
  while (clean.length > 1 && clean[0].n === clean[clean.length - 1].n && clean[0].e === clean[clean.length - 1].e) clean.pop();
  const discarded = pts.length - clean.length;
  if (clean.length < 3) {
    showResult(polygonResult, `Se necesitan al menos 3 vértices distintos (hay ${clean.length}${discarded ? `; ${discarded} repetido(s) descartado(s)` : ""}).`, true);
    return;
  }
  /* Se restan las coordenadas del primer vértice: evita pérdida de precisión con N/E grandes */
  const o = clean[0];
  const loc = clean.map(p => ({ n: p.n - o.n, e: p.e - o.e }));
  if (!isSimplePolygon(loc)) {
    showResult(polygonResult, "La poligonal se cruza o se toca a sí misma (autointersección): el área por Shoelace no es confiable. Revisa el orden de los vértices.", true);
    return;
  }
  let twiceArea = 0, perimeter = 0;
  for (let i = 0; i < loc.length; i++) {
    const a = loc[i], b = loc[(i + 1) % loc.length];
    twiceArea += a.e * b.n - b.e * a.n;      // x = Este, y = Norte
    perimeter += Math.hypot(b.n - a.n, b.e - a.e);
  }
  const area = Math.abs(twiceArea) / 2;
  if (!Number.isFinite(area) || !Number.isFinite(perimeter)) {
    showResult(polygonResult, "Los valores producen un resultado no representable.", true);
    return;
  }
  if (area <= perimeter * perimeter * 1e-12) {
    showResult(polygonResult, `Los vértices son colineales: el polígono es degenerado (área = <strong>0 m²</strong>, perímetro de la poligonal cerrada = ${perimeter.toFixed(3)} m).`, true);
    return;
  }
  const sense = twiceArea > 0 ? "antihorario" : "horario";
  const notes = [];
  if (discarded) notes.push(`${discarded} vértice(s) repetido(s) descartado(s)`);
  if (emptyRows) notes.push(`${emptyRows} fila(s) vacía(s) ignorada(s)`);
  showResult(polygonResult,
    `Área: <strong>${area.toFixed(3)} m²</strong> (${(area / 10000).toFixed(4)} ha)<br>` +
    `Perímetro: <strong>${perimeter.toFixed(3)} m</strong><br>` +
    `Vértices: <strong>${clean.length}</strong> · Sentido: <strong>${sense}</strong> (planta, Norte arriba)` +
    (notes.length ? `<br><small>${notes.join("; ")}.</small>` : ""));
});

/* FORMULARIO — AJAX + respaldo nativo */
const contactForm=$("#contactForm"),formMessage=$("#formMessage"),submitButton=contactForm.querySelector('button[type="submit"]'),emailField=$("#email");
function showFormMessage(message,isError=false){formMessage.textContent=message;formMessage.classList.toggle("error",isError);}
contactForm.addEventListener("submit",async event=>{event.preventDefault();if(!contactForm.checkValidity()){contactForm.reportValidity();showFormMessage("Completa correctamente los campos requeridos.",true);return;}submitButton.disabled=true;submitButton.textContent="Enviando…";showFormMessage("Enviando tu solicitud a GeoTop…");const replyField=contactForm.querySelector('input[name="_replyto"]');if(replyField)replyField.value=emailField.value.trim();try{const response=await fetch(FORM_ENDPOINT,{method:"POST",headers:{Accept:"application/json"},body:new FormData(contactForm)});const data=await response.json().catch(()=>({}));if(!response.ok||data.success===false)throw new Error(data.message||"Error de FormSubmit");const name=$("#name").value.trim();contactForm.reset();showFormMessage(`✓ Gracias, ${name}. Tu solicitud fue enviada correctamente.`);}catch(error){console.error(error);showFormMessage("El envío automático no respondió. Abriendo el formulario seguro de respaldo…",true);contactForm.removeAttribute("novalidate");contactForm.submit();}finally{submitButton.disabled=false;submitButton.textContent="Enviar solicitud";}});

console.log("GeoTop iniciado correctamente.");
