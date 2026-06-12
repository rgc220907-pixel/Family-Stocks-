/* ============================================================
   Family Stocks · Lógica de negocio + UI
   ============================================================ */

import {
  getJugadores, getTareas, getHistorial,
  insertarMovimiento, suscribirHistorial
} from "./api.js";

// ------------------------------------------------------------
// Estado global
// ------------------------------------------------------------
const state = {
  jugadores: [],
  tareas: [],
  historial: [],
  fluctuaciones: {},     // { tarea_id: -1 | 0 | +1 }
  pinOk: false,
  seleccion: null,       // tarea o comodín pendiente de asignar jugador
  pinResolver: null,
};

const PIN_CORRECTO = "2026";

// ============================================================
//  EL MOTOR FINANCIERO
// ============================================================

// --- Fechas / periodos ---
const ahora = () => new Date();

function inicioSemana(d = ahora()) {
  // Semana lunes→domingo
  const x = new Date(d);
  const dow = (x.getDay() + 6) % 7; // 0 = lunes
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - dow);
  return x;
}

function inicioMes(d = ahora()) {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}

function esDomingo(d = ahora()) {
  return d.getDay() === 0;
}

// --- Sumatorio de puntos de un jugador en un rango ---
function puntosEntre(perfilId, desde) {
  return state.historial
    .filter(h => h.perfil_id === perfilId && new Date(h.fecha) >= desde)
    .reduce((acc, h) => acc + Number(h.puntos_finales), 0);
}

function puntosTotales(perfilId) {
  return state.historial
    .filter(h => h.perfil_id === perfilId)
    .reduce((acc, h) => acc + Number(h.puntos_finales), 0);
}

// --- Rankings ---
export function rankingSemanal() {
  const desde = inicioSemana();
  return state.jugadores
    .map(j => ({ ...j, puntos: puntosEntre(j.id, desde) }))
    .sort((a, b) => b.puntos - a.puntos);
}

export function rankingMensual() {
  // Se "resetea" visualmente el día 1: solo cuenta historial del mes actual.
  const desde = inicioMes();
  return state.jugadores
    .map(j => ({ ...j, puntos: puntosEntre(j.id, desde) }))
    .sort((a, b) => b.puntos - a.puntos);
}

export function rankingTotal() {
  return state.jugadores
    .map(j => ({ ...j, puntos: puntosTotales(j.id) }))
    .sort((a, b) => b.puntos - a.puntos);
}

// ============================================================
//  EFECTO BOLSA — fluctuación diaria determinista por día
// ============================================================

// Hash estable: mismo día + misma tarea => misma fluctuación todo el día.
function semillaDiaria(tareaId) {
  const hoy = ahora();
  const clave = `${hoy.getFullYear()}-${hoy.getMonth()}-${hoy.getDate()}-${tareaId}`;
  let h = 0;
  for (let i = 0; i < clave.length; i++) {
    h = (h * 31 + clave.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function calcularFluctuaciones() {
  const flux = {};
  for (const t of state.tareas) {
    const base = Math.abs(Number(t.puntos_base));
    // Protegidas: 0.5 y 1 no fluctúan (se mantienen estables).
    if (base === 0.5 || base === 1) {
      flux[t.id] = 0;
      continue;
    }
    const r = semillaDiaria(t.id) % 3; // 0,1,2
    flux[t.id] = r === 0 ? -1 : r === 1 ? 0 : 1;
  }
  state.fluctuaciones = flux;
}

// Valor de cotización HOY de una tarea (base + fluctuación, signo conservado)
function cotizacionHoy(tarea) {
  const base = Number(tarea.puntos_base);
  const f = state.fluctuaciones[tarea.id] || 0;
  if (f === 0) return base;
  // Sumamos en la dirección de la magnitud: positivas suben/bajan,
  // negativas se hacen más/menos severas conservando el signo.
  return base >= 0 ? base + f : base - f;
}

// ============================================================
//  DOMINGO PRIME DAY — multiplicador x3
// ============================================================
function multiplicadorDelDia() {
  return esDomingo() ? 3 : 1;
}

// Puntos finales a insertar = cotización de hoy * multiplicador
function puntosFinales(tarea) {
  return Number((cotizacionHoy(tarea) * multiplicadorDelDia()).toFixed(2));
}

// ============================================================
//  CARGA DE DATOS
// ============================================================
async function cargarTodo() {
  const [jugadores, tareas, historial] = await Promise.all([
    getJugadores(), getTareas(), getHistorial()
  ]);
  state.jugadores = jugadores;
  state.tareas = tareas;
  state.historial = historial;
  calcularFluctuaciones();
}

// ============================================================
//  DETECCIÓN DE VISTA (móvil PWA vs dashboard Mac)
// ============================================================
function detectarVista() {
  const landscape = window.innerWidth > window.innerHeight;
  const ancho = window.innerWidth >= 1024;
  const esDashboard = landscape && ancho;
  document.body.classList.toggle("is-dashboard", esDashboard);
  return esDashboard;
}

// ============================================================
//  SEGURIDAD · PIN
// ============================================================
function pedirPin() {
  // Si ya validó en esta sesión, no repetimos.
  if (state.pinOk) return Promise.resolve(true);
  return new Promise(resolve => {
    state.pinResolver = resolve;
    abrirModalPin();
  });
}

let pinBuffer = "";
function abrirModalPin() {
  pinBuffer = "";
  renderPinDots();
  document.getElementById("modal-pin").classList.remove("hidden");
}
function cerrarModalPin() {
  document.getElementById("modal-pin").classList.add("hidden");
}
function renderPinDots() {
  document.querySelectorAll(".pin-dot").forEach((d, i) => {
    d.classList.toggle("filled", i < pinBuffer.length);
  });
}
function pulsarPin(val) {
  const err = document.getElementById("pin-error");
  err.classList.add("hidden");
  if (val === "del") {
    pinBuffer = pinBuffer.slice(0, -1);
  } else if (pinBuffer.length < 4) {
    pinBuffer += val;
  }
  renderPinDots();
  if (pinBuffer.length === 4) {
    setTimeout(() => {
      if (pinBuffer === PIN_CORRECTO) {
        state.pinOk = true;
        cerrarModalPin();
        const r = state.pinResolver; state.pinResolver = null;
        if (r) r(true);
      } else {
        err.classList.remove("hidden");
        pinBuffer = "";
        renderPinDots();
      }
    }, 120);
  }
}

// ============================================================
//  INSERCIÓN DE MOVIMIENTOS
// ============================================================
async function ejecutarMovimiento({ tarea = null, descripcion = null, puntos }) {
  // 1) Elegir jugador
  const jugador = await elegirJugador();
  if (!jugador) return;

  // 2) PIN obligatorio en cada envío a BD
  const ok = await pedirPin();
  if (!ok) return;

  // 3) Insertar
  const mov = {
    perfil_id: jugador.id,
    tarea_id: tarea ? tarea.id : null,
    descripcion_custom: descripcion,
    puntos_finales: puntos,
    fecha: new Date().toISOString(),
  };
  try {
    const fila = await insertarMovimiento(mov);
    state.historial.unshift(fila);
    toast(`${jugador.avatar || "👤"} ${jugador.nombre}: ${puntos > 0 ? "+" : ""}${puntos} pts`,
          puntos >= 0 ? "up" : "down");
    refrescarUI();
  } catch (e) {
    toast("Error al guardar: " + e.message, "down");
  }
}

// Selector de jugador (hoja inferior)
function elegirJugador() {
  return new Promise(resolve => {
    const cont = document.getElementById("sheet-jugadores-list");
    cont.innerHTML = "";
    state.jugadores.forEach(j => {
      const b = document.createElement("button");
      b.className = "card p-4 flex flex-col items-center gap-1 active:scale-95 transition";
      b.innerHTML = `<span class="text-4xl">${j.avatar || "👤"}</span>
                     <span class="font-semibold">${j.nombre}</span>`;
      b.onclick = () => { cerrarSheet(); resolve(j); };
      cont.appendChild(b);
    });
    const sheet = document.getElementById("sheet-jugadores");
    sheet.classList.remove("hidden");
    sheet.dataset.cancel = "1";
    sheet._resolve = resolve;
  });
}
function cerrarSheet() {
  const sheet = document.getElementById("sheet-jugadores");
  sheet.classList.add("hidden");
  if (sheet._resolve && sheet.dataset.cancel === "1") {
    const r = sheet._resolve; sheet._resolve = null;
    // no resolvemos null aquí si ya se eligió; se controla por flujo
  }
}

// ============================================================
//  RENDER · MÓVIL
// ============================================================
function flechaFlux(f) {
  if (f > 0) return `<span class="flux up">▲ +1</span>`;
  if (f < 0) return `<span class="flux down">▼ −1</span>`;
  return `<span class="flux flat">▬ 0</span>`;
}

function fmt(n) {
  const s = Number(n);
  return (s > 0 ? "+" : "") + s.toFixed(s % 1 === 0 ? 0 : 1);
}

function renderMercado() {
  const cont = document.getElementById("lista-positivas");
  cont.innerHTML = "";
  state.tareas.filter(t => t.tipo === "positiva").forEach(t => {
    cont.appendChild(tarjetaTarea(t, "pos"));
  });
}

function renderPenalizaciones() {
  const cont = document.getElementById("lista-negativas");
  cont.innerHTML = "";
  state.tareas.filter(t => t.tipo === "negativa").forEach(t => {
    cont.appendChild(tarjetaTarea(t, "neg"));
  });
}

function tarjetaTarea(t, clase) {
  const f = state.fluctuaciones[t.id] || 0;
  const final = puntosFinales(t);
  const prime = esDomingo();
  const el = document.createElement("button");
  el.className = `task-btn ${clase} p-4 w-full flex items-center justify-between text-left`;
  el.innerHTML = `
    <div class="flex-1 min-w-0">
      <div class="font-semibold truncate">${t.nombre}</div>
      <div class="text-xs flat mt-1 flex items-center gap-2">
        Base ${fmt(t.puntos_base)} ${flechaFlux(f)}
      </div>
    </div>
    <div class="text-right ml-3">
      <div class="mono text-2xl font-bold ${final >= 0 ? "up" : "down"}">${fmt(final)}</div>
      ${prime ? `<div class="text-[10px] font-bold" style="color:#f107a3">PRIME ×3</div>` : ""}
    </div>`;
  el.onclick = () => ejecutarMovimiento({ tarea: t, puntos: final });
  return el;
}

function renderComodin() {
  // listeners en init
}

// ============================================================
//  RENDER · DASHBOARD (Mac)
// ============================================================
function medalla(i) { return ["🥇", "🥈", "🥉"][i] || `${i + 1}.`; }

function renderPodio(contId, ranking) {
  const cont = document.getElementById(contId);
  cont.innerHTML = "";
  ranking.forEach((j, i) => {
    const cls = i === 0 ? "podium-1" : i === 1 ? "podium-2" : i === 2 ? "podium-3" : "";
    const row = document.createElement("div");
    row.className = `card ${cls} p-4 flex items-center gap-4 fade-in`;
    row.innerHTML = `
      <div class="text-3xl w-10 text-center">${medalla(i)}</div>
      <div class="text-4xl">${j.avatar || "👤"}</div>
      <div class="flex-1">
        <div class="text-xl font-bold">${j.nombre}</div>
        <div class="text-xs flat">posición ${i + 1}</div>
      </div>
      <div class="mono text-3xl font-bold ${j.puntos >= 0 ? "up" : "down"}">${fmt(j.puntos)}</div>`;
    cont.appendChild(row);
  });
}

function renderTicker() {
  // Cinta deslizante: cada tarea con su cotización y flecha del día.
  const items = state.tareas.map(t => {
    const f = state.fluctuaciones[t.id] || 0;
    const final = cotizacionHoy(t);
    const sym = t.nombre.toUpperCase().slice(0, 12).replace(/\s+/g, "·");
    const arrow = f > 0 ? "▲" : f < 0 ? "▼" : "▬";
    const cls = f > 0 ? "up" : f < 0 ? "down" : "flat";
    return `<span class="ticker-item">
              <span class="mono">${sym}</span>
              <span class="mono ${final >= 0 ? "up" : "down"}">${fmt(final)}</span>
              <span class="${cls}">${arrow}</span>
            </span>`;
  }).join("");
  // Duplicamos para loop continuo
  document.getElementById("ticker-track").innerHTML = items + items;
}

function renderTablaCotizaciones() {
  const tbody = document.getElementById("tabla-cotizaciones");
  tbody.innerHTML = "";
  state.tareas.forEach(t => {
    const f = state.fluctuaciones[t.id] || 0;
    const base = Number(t.puntos_base);
    const final = cotizacionHoy(t);
    const arrow = f > 0 ? "▲ +1" : f < 0 ? "▼ −1" : "▬ 0";
    const cls = f > 0 ? "up" : f < 0 ? "down" : "flat";
    const tr = document.createElement("tr");
    tr.className = "border-b border-[#28304a]";
    tr.innerHTML = `
      <td class="py-2 pr-2">${t.nombre}</td>
      <td class="py-2 mono text-right flat">${fmt(base)}</td>
      <td class="py-2 mono text-right font-bold ${final >= 0 ? "up" : "down"}">${fmt(final)}</td>
      <td class="py-2 text-right ${cls} font-semibold">${arrow}</td>`;
    tbody.appendChild(tr);
  });
}

function renderDashboard() {
  renderPodio("podio-mensual", rankingMensual());
  renderPodio("podio-semanal", rankingSemanal());
  renderTicker();
  renderTablaCotizaciones();
  document.getElementById("dash-fecha").textContent =
    ahora().toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
}

// ============================================================
//  REFRESCO GLOBAL
// ============================================================
function refrescarUI() {
  if (detectarVista()) {
    renderDashboard();
  } else {
    renderMercado();
    renderPenalizaciones();
  }
  // Banner Prime Day
  document.querySelectorAll(".prime-flag").forEach(el => {
    el.classList.toggle("hidden", !esDomingo());
  });
}

// ============================================================
//  PESTAÑAS (móvil)
// ============================================================
function cambiarTab(nombre) {
  document.querySelectorAll(".tab-panel").forEach(p =>
    p.classList.toggle("hidden", p.dataset.panel !== nombre));
  document.querySelectorAll(".tab").forEach(t =>
    t.classList.toggle("active", t.dataset.tab === nombre));
}

// ============================================================
//  TOASTS
// ============================================================
function toast(msg, tipo = "up") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = `fixed left-1/2 -translate-x-1/2 bottom-24 px-5 py-3 rounded-xl font-semibold z-50 fade-in ${
    tipo === "up" ? "bg-up up" : "bg-down down"}`;
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 2200);
}

// ============================================================
//  INIT
// ============================================================
async function init() {
  // Service worker para PWA (registro best-effort)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  detectarVista();
  window.addEventListener("resize", () => { detectarVista(); refrescarUI(); });

  // PIN numpad
  document.querySelectorAll("[data-pin]").forEach(b =>
    b.addEventListener("click", () => pulsarPin(b.dataset.pin)));

  // Tabs
  document.querySelectorAll(".tab").forEach(t =>
    t.addEventListener("click", () => cambiarTab(t.dataset.tab)));

  // Cancelar selector de jugador
  document.getElementById("sheet-cancel").addEventListener("click", () => {
    const sheet = document.getElementById("sheet-jugadores");
    sheet.classList.add("hidden");
    if (sheet._resolve) { const r = sheet._resolve; sheet._resolve = null; r(null); }
  });

  // Comodín
  document.getElementById("comodin-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const desc = document.getElementById("comodin-desc").value.trim();
    const pts = parseFloat(document.getElementById("comodin-pts").value);
    if (!desc || isNaN(pts)) { toast("Completa descripción y puntos", "down"); return; }
    const final = Number((pts * multiplicadorDelDia()).toFixed(2));
    ejecutarMovimiento({ descripcion: desc, puntos: final });
    e.target.reset();
  });

  try {
    await cargarTodo();
  } catch (e) {
    toast("Error de conexión a Supabase. Revisa api.js", "down");
    console.error(e);
  }

  refrescarUI();

  // Tiempo real (el Mac se actualiza solo cuando el móvil inserta)
  try {
    suscribirHistorial(async () => {
      state.historial = await getHistorial();
      refrescarUI();
    });
  } catch (_) { /* sin RT, no pasa nada */ }
}

document.addEventListener("DOMContentLoaded", init);
