/* ============================================================
   Family Stocks v2 · Lógica de aplicación
   ------------------------------------------------------------
   - Switch global Vista Niños (solo lectura) / Vista Padres (broker).
   - Mercado L–S: validar tareas (compra) y multas (impacto patrimonio).
   - Domingo: liquidación + recompensa/penalización directa al Cash.
   - CRUD de acciones (valor de salida, volatilidad, dividendos).
   ============================================================ */

import * as api from "./api.js";

// --------- Parámetros del multiplicador (espejo de la tabla config) ---------
const AP = 420, MID = 1110, CL = 1260; // 07:00 · 18:30 · 21:00 (min locales)

const state = {
  vista: "ninos",          // 'ninos' | 'padres'
  pin: null,               // PIN cacheado tras validar (se reenvía en cada RPC)
  paso: "hijos",           // padres: 'hijos' | 'operar' | 'liquidar' | 'acciones'
  hijo: null,              // hijo seleccionado
  hijos: [], pizarra: [], acciones: [], rankSemanal: [], rankGlobal: [],
};

let onPinOk = null;        // callback pendiente del modal PIN

/* ============================================================
   HELPERS DE TIEMPO / MERCADO (cálculo local para el reloj)
   ============================================================ */
const minutos = (d) => d.getHours() * 60 + d.getMinutes();
const esDomingo = (d = new Date()) => d.getDay() === 0;
const mercadoAbierto = (d = new Date()) =>
  !esDomingo(d) && minutos(d) >= AP && minutos(d) <= CL;

function multiplicadorHorario(d = new Date()) {
  const m = minutos(d);
  if (m <= AP) return 1.5;
  if (m <= MID) return 1.5 + (1.0 - 1.5) * (m - AP) / (MID - AP);
  if (m <= CL) return 1.0 + (0.5 - 1.0) * (m - MID) / (CL - MID);
  return 0.5;
}

/* ============================================================
   FORMATO
   ============================================================ */
const fmt = (n) => {
  const x = Number(n) || 0;
  return (x > 0 ? "+" : "") + x.toFixed(Math.abs(x) % 1 === 0 ? 0 : 1);
};
const eur = (n) => (Number(n) || 0).toFixed(2);
const flecha = (dir) => dir === "sube" ? "▲" : dir === "baja" ? "▼" : "▬";
const claseDir = (dir) => dir === "sube" ? "up" : dir === "baja" ? "down" : "flat";

/* ============================================================
   CARGA DE DATOS
   ============================================================ */
async function cargarTodo() {
  const [hijos, pizarra, acciones, rs, rg] = await Promise.all([
    api.getHijos(), api.getPizarra(), api.getAcciones(),
    api.getRankingSemanal(), api.getRankingGlobal(),
  ]);
  Object.assign(state, { hijos, pizarra, acciones, rankSemanal: rs, rankGlobal: rg });
}

/* ============================================================
   TOAST + MODALES
   ============================================================ */
function toast(msg, tipo = "up") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = `toast show ${tipo}`;
  clearTimeout(t._t);
  t._t = setTimeout(() => (t.className = "toast"), 2400);
}

function pedirPin(cb) {
  onPinOk = cb;
  pinBuffer = "";
  renderPinDots();
  document.getElementById("pin-error").classList.add("hidden");
  document.getElementById("modal-pin").classList.remove("hidden");
}
let pinBuffer = "";
function renderPinDots() {
  document.querySelectorAll("#modal-pin .pin-dot").forEach((d, i) =>
    d.classList.toggle("filled", i < pinBuffer.length));
}
async function pulsarPin(v) {
  document.getElementById("pin-error").classList.add("hidden");
  if (v === "del") pinBuffer = pinBuffer.slice(0, -1);
  else if (pinBuffer.length < 4) pinBuffer += v;
  renderPinDots();
  if (pinBuffer.length === 4) {
    const intento = pinBuffer;
    try {
      const valido = await api.validarPin(intento);
      if (valido) {
        state.pin = intento;
        document.getElementById("modal-pin").classList.add("hidden");
        const cb = onPinOk; onPinOk = null;
        if (cb) cb();
      } else throw new Error();
    } catch {
      document.getElementById("pin-error").classList.remove("hidden");
      pinBuffer = ""; renderPinDots();
    }
  }
}

function confirmar(texto) {
  return new Promise((resolve) => {
    const m = document.getElementById("modal-confirm");
    document.getElementById("confirm-text").textContent = texto;
    m.classList.remove("hidden");
    const cleanup = (val) => {
      m.classList.add("hidden");
      document.getElementById("confirm-si").onclick = null;
      document.getElementById("confirm-no").onclick = null;
      resolve(val);
    };
    document.getElementById("confirm-si").onclick = () => cleanup(true);
    document.getElementById("confirm-no").onclick = () => cleanup(false);
  });
}

/* ============================================================
   RENDER PRINCIPAL
   ============================================================ */
function render() {
  document.getElementById("view-ninos").classList.toggle("hidden", state.vista !== "ninos");
  document.getElementById("view-padres").classList.toggle("hidden", state.vista !== "padres");
  document.querySelectorAll(".switch-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.vista === state.vista));
  if (state.vista === "ninos") renderNinos();
  else renderPadres();
}

/* ---------------------- VISTA NIÑOS ---------------------- */
function renderNinos() {
  renderReloj();
  // Podios
  renderPodio("podio-semanal", state.rankSemanal, "patrimonio_vivo", "Patrimonio Vivo");
  renderPodio("podio-global", state.rankGlobal, "cash_global", "Cash Global");
  // Pizarra
  const tBody = document.getElementById("pizarra-body");
  tBody.innerHTML = state.pizarra.map((a) => `
    <tr class="${a.tipo === 'pasivo' ? 'fila-pasivo' : ''}">
      <td class="py-2">${a.icono || ''} ${a.nombre}
        ${a.paga_dividendo ? `<span title="Paga dividendo ${a.dividendo_frecuencia}">🪙</span>` : ''}</td>
      <td class="py-2 mono text-right">${a.tipo === 'pasivo' ? '−' : ''}${eur(a.precio_actual)}</td>
      <td class="py-2 text-right ${claseDir(a.direccion)} font-bold">
        ${flecha(a.direccion)} ${Number(a.variacion) !== 0 ? fmt(a.variacion) : ''}</td>
    </tr>`).join("");
}

function renderReloj() {
  const now = new Date();
  const m = multiplicadorHorario(now);
  const dom = esDomingo(now);
  const abierto = mercadoAbierto(now);
  const cont = document.getElementById("reloj-mercado");
  let estado, cls;
  if (dom) { estado = "🔔 DOMINGO · Mercado cerrado (día de liquidación)"; cls = "flat"; }
  else if (!abierto) { estado = "🌙 Mercado cerrado (abre 07:00)"; cls = "flat"; }
  else { estado = `Multiplicador ahora`; cls = m >= 1 ? "up" : "down"; }
  cont.innerHTML = `
    <div class="hora mono">${now.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}</div>
    <div class="estado ${cls}">${estado}</div>
    ${(!dom && abierto) ? `<div class="mult mono ${cls}">×${m.toFixed(2)}</div>` : ""}`;
}

function renderPodio(id, ranking, campo, etiqueta) {
  const medalla = (i) => ["🥇", "🥈", "🥉"][i] || `${i + 1}.`;
  document.getElementById(id).innerHTML = ranking.map((j, i) => {
    const v = Number(j[campo]) || 0;
    const cls = i === 0 ? "podium-1" : i === 1 ? "podium-2" : i === 2 ? "podium-3" : "";
    return `<div class="card ${cls} podio-row">
      <span class="medalla">${medalla(i)}</span>
      <span class="avatar">${j.avatar || "👤"}</span>
      <span class="nombre">${j.nombre}</span>
      <span class="valor mono ${v >= 0 ? "up" : "down"}">${eur(v)}</span>
    </div>`;
  }).join("") + `<p class="podio-etiqueta flat">${etiqueta}</p>`;
}

/* ---------------------- VISTA PADRES ---------------------- */
function renderPadres() {
  const dom = esDomingo();
  document.getElementById("padres-modo").textContent =
    dom ? "🔔 Modo Liquidación (Domingo)" : "📈 Mercado abierto · Broker";

  // Navegación interna
  const wrap = document.getElementById("padres-contenido");
  if (state.paso === "acciones") return renderEditorAcciones(wrap);
  if (!state.hijo)              return renderGridHijos(wrap, dom);
  if (dom)                     return renderLiquidacion(wrap);
  return renderOperar(wrap);
}

function botonVolver(label = "← Volver") {
  return `<button class="btn-volver" id="btn-volver">${label}</button>`;
}
function bindVolver(fn) {
  const b = document.getElementById("btn-volver");
  if (b) b.onclick = fn;
}

// Grid de hijos
function renderGridHijos(wrap, dom) {
  wrap.innerHTML = `
    <div class="barra-acciones">
      <button class="btn-sec" id="ir-acciones">⚙️ Gestionar acciones</button>
    </div>
    <h2 class="titulo-sec">${dom ? "Elige un hijo para liquidar" : "Elige un hijo"}</h2>
    <div class="grid-hijos">${state.hijos.map((h) => `
      <button class="card hijo-card" data-id="${h.id}">
        <span class="text-4xl">${h.avatar || "👤"}</span>
        <span class="font-semibold mt-1">${h.nombre}</span>
        <span class="text-xs flat mono mt-1">Cash ${eur(h.cash_global)}</span>
      </button>`).join("")}</div>`;
  document.getElementById("ir-acciones").onclick = () => { state.paso = "acciones"; render(); };
  wrap.querySelectorAll(".hijo-card").forEach((b) =>
    b.onclick = () => { state.hijo = state.hijos.find((x) => x.id === b.dataset.id); render(); });
}

// Operar (L–S): validar tareas + penalizaciones
function renderOperar(wrap) {
  const h = state.hijo;
  const activos = state.pizarra.filter((a) => a.tipo === "activo");
  const pasivos = state.pizarra.filter((a) => a.tipo === "pasivo");
  const m = multiplicadorHorario();
  const abierto = mercadoAbierto();

  wrap.innerHTML = `
    ${botonVolver()}
    <div class="op-header">
      <span class="text-3xl">${h.avatar || "👤"}</span>
      <div><div class="font-bold text-lg">${h.nombre}</div>
        <div class="text-xs flat">Multiplicador ahora: <b class="${m >= 1 ? "up" : "down"}">×${m.toFixed(2)}</b></div></div>
    </div>
    ${!abierto ? `<div class="aviso">🌙 Mercado cerrado. Las operaciones se rechazarán hasta las 07:00.</div>` : ""}
    <h3 class="titulo-sec up">📈 Mercado de tareas</h3>
    <div class="lista-op">${activos.map((a) => tarjetaOp(a, "compra", m)).join("")}</div>
    <h3 class="titulo-sec down mt-4">📉 Penalizaciones</h3>
    <div class="lista-op">${pasivos.map((a) => tarjetaOp(a, "multa", m)).join("")}</div>
    <h3 class="titulo-sec mt-4">🃏 Comodín de Cash Global (puntos manuales · caja fuerte)</h3>
    <div class="semana-directo">
      <button class="btn-sec up" id="comodin-mas">➕ Sumar Cash</button>
      <button class="btn-sec down" id="comodin-menos">➖ Restar Cash</button>
    </div>`;

  bindVolver(() => { state.hijo = null; render(); });
  wrap.querySelectorAll("[data-op]").forEach((b) => b.onclick = () => operar(b.dataset.op, b.dataset.id));
  document.getElementById("comodin-mas").onclick = () => directa("rec");
  document.getElementById("comodin-menos").onclick = () => directa("pen");
}

function tarjetaOp(a, op, m) {
  const esCompra = op === "compra";
  const valor = esCompra ? a.precio_actual * m : a.precio_actual;
  return `<button class="task-btn ${esCompra ? "pos" : "neg"}" data-op="${op}" data-id="${a.id}">
    <div class="flex-1 min-w-0">
      <div class="font-semibold truncate">${a.icono || ""} ${a.nombre}
        ${a.paga_dividendo ? "🪙" : ""}</div>
      <div class="text-xs flat">Hoy ${eur(a.precio_actual)} ${esCompra ? `· ×${m.toFixed(2)}` : ""}</div>
    </div>
    <div class="mono text-xl font-bold ${esCompra ? "up" : "down"}">
      ${esCompra ? "+" : "−"}${eur(valor)}</div>
  </button>`;
}

async function operar(op, accionId) {
  const accion = state.acciones.find((a) => a.id === accionId);
  try {
    const r = op === "compra"
      ? await api.validarTarea(state.hijo.id, accionId, state.pin)
      : await api.penalizarMercado(state.hijo.id, accionId, state.pin);
    if (op === "compra")
      toast(`✅ ${accion.nombre}: +${r.acciones_anadidas} acc · valor +${eur(r.valor_operacion)}`, "up");
    else
      toast(`⚠️ ${accion.nombre}: ${eur(r.impacto)} al patrimonio`, "down");
    await refrescar();
  } catch (e) { toast("❌ " + (e.message || "Error"), "down"); }
}

// Liquidación de domingo
async function renderLiquidacion(wrap) {
  const h = state.hijo;
  wrap.innerHTML = `${botonVolver()}<div class="op-header">
    <span class="text-3xl">${h.avatar || "👤"}</span>
    <div><div class="font-bold text-lg">${h.nombre}</div>
      <div class="text-xs flat">Cash Global actual: <b class="mono">${eur(h.cash_global)}</b></div></div>
    </div><div id="cartera-zona" class="flat">Cargando cartera…</div>
    <div class="domingo-directo">
      <button class="btn-sec down" id="pen-directa">➖ Penalización directa</button>
      <button class="btn-sec up" id="rec-directa">➕ Recompensa directa</button>
    </div>`;
  bindVolver(() => { state.hijo = null; render(); });
  document.getElementById("pen-directa").onclick = () => directa("pen");
  document.getElementById("rec-directa").onclick = () => directa("rec");

  const cartera = await api.getCarteraDetalle(h.id);
  const zona = document.getElementById("cartera-zona");
  if (!cartera.length) { zona.innerHTML = `<p class="aviso">Cartera vacía. Nada que liquidar.</p>`; return; }

  zona.innerHTML = `
    <h3 class="titulo-sec">Cartera de ${h.nombre} (precio de cierre)</h3>
    <div class="liq-lista">${cartera.map((c) => `
      <div class="card liq-row" data-accion="${c.accion_id}" data-precio="${c.precio_actual}" data-max="${c.cantidad}">
        <div class="liq-info">
          <div class="font-semibold">${c.icono || ""} ${c.nombre} ${c.paga_dividendo ? "🪙" : ""}</div>
          <div class="text-xs flat mono">Tienes ${(+c.cantidad).toFixed(2)} acc · cierre ${eur(c.precio_actual)} → ${eur(c.valor_actual)}</div>
        </div>
        <div class="liq-inputs">
          <label>Vender<input type="number" class="inp-vender" min="0" max="${c.cantidad}" step="0.01" value="0"></label>
          <span class="conservar mono flat">Conserva ${(+c.cantidad).toFixed(2)}</span>
        </div>
      </div>`).join("")}</div>
    <div class="liq-total">Total a Cash: <b class="mono up" id="liq-total">0.00</b></div>
    <button class="btn-primary" id="btn-liquidar">💰 Confirmar liquidación</button>`;

  // Cálculo en vivo del total + "conserva"
  zona.querySelectorAll(".inp-vender").forEach((inp) => inp.oninput = () => {
    let total = 0;
    zona.querySelectorAll(".liq-row").forEach((row) => {
      const precio = +row.dataset.precio, max = +row.dataset.max;
      const i = row.querySelector(".inp-vender");
      let v = Math.min(Math.max(+i.value || 0, 0), max);
      row.querySelector(".conservar").textContent = `Conserva ${(max - v).toFixed(2)}`;
      total += v * precio;
    });
    document.getElementById("liq-total").textContent = eur(total);
  });

  document.getElementById("btn-liquidar").onclick = async () => {
    const ventas = [];
    zona.querySelectorAll(".liq-row").forEach((row) => {
      const v = Math.min(Math.max(+row.querySelector(".inp-vender").value || 0, 0), +row.dataset.max);
      if (v > 0) ventas.push({ accion_id: row.dataset.accion, cantidad: v });
    });
    if (!ventas.length) return toast("Indica alguna cantidad a vender", "down");
    if (!await confirmar("¿Confirmar liquidación? Esta acción es IRREVERSIBLE.")) return;
    try {
      const r = await api.liquidar(h.id, ventas, state.pin);
      toast(`💰 Liquidado: +${eur(r.cash_ingresado)} a Cash Global`, "up");
      await refrescar();
      state.hijo = state.hijos.find((x) => x.id === h.id); // refresca cash mostrado
      render();
    } catch (e) { toast("❌ " + (e.message || "Error"), "down"); }
  };
}

async function directa(tipo) {
  const h = state.hijo;
  const monto = parseFloat(prompt(`${tipo === "rec" ? "Recompensa" : "Penalización"} directa a Cash Global para ${h.nombre}\nPuntos:`, "1"));
  if (!monto || monto <= 0) return;
  const nota = prompt("Motivo (opcional):", "") || null;
  try {
    const r = tipo === "rec"
      ? await api.recompensaDirecta(h.id, monto, nota, state.pin)
      : await api.penalizacionDirecta(h.id, monto, nota, state.pin);
    toast(tipo === "rec" ? `➕ +${eur(r.cash_sumado)} a Cash` : `➖ −${eur(r.cash_restado)} de Cash`,
          tipo === "rec" ? "up" : "down");
    await refrescar();
    state.hijo = state.hijos.find((x) => x.id === h.id);
    render();
  } catch (e) { toast("❌ " + (e.message || "Error"), "down"); }
}

/* ---------------------- EDITOR DE ACCIONES (CRUD) ---------------------- */
function renderEditorAcciones(wrap) {
  wrap.innerHTML = `
    ${botonVolver()}
    <div class="barra-acciones">
      <h2 class="titulo-sec">⚙️ Acciones del mercado</h2>
      <button class="btn-primary" id="nueva-accion">＋ Nueva acción</button>
    </div>
    <div class="grid-acciones">${state.acciones.map(filaAccion).join("")}</div>`;
  bindVolver(() => { state.paso = "hijos"; render(); });
  document.getElementById("nueva-accion").onclick = () => abrirFormAccion(null);
  wrap.querySelectorAll("[data-edit]").forEach((b) =>
    b.onclick = () => abrirFormAccion(state.acciones.find((a) => a.id === b.dataset.edit)));
  wrap.querySelectorAll("[data-del]").forEach((b) =>
    b.onclick = () => eliminarAccion(state.acciones.find((a) => a.id === b.dataset.del)));
}

function filaAccion(a) {
  return `<div class="card accion-row">
    <div class="flex-1 min-w-0">
      <div class="font-semibold">${a.icono || ""} ${a.nombre}
        <span class="badge ${a.tipo === "activo" ? "up" : "down"}">${a.tipo}</span></div>
      <div class="text-xs flat mono">Salida ${eur(a.precio_base)} · vol ${(+a.volatilidad).toFixed(2)}
        ${a.paga_dividendo ? ` · 🪙 ${eur(a.dividendo_monto)}/${a.dividendo_frecuencia}` : ""}</div>
    </div>
    <button class="icon-btn" data-edit="${a.id}">✏️</button>
    <button class="icon-btn" data-del="${a.id}">🗑️</button>
  </div>`;
}

function abrirFormAccion(a) {
  const esNueva = !a;
  const f = document.getElementById("form-accion");
  f.reset();
  f.elements["id"].value = a?.id || "";
  f.elements["nombre"].value = a?.nombre || "";
  f.elements["tipo"].value = a?.tipo || "activo";
  f.elements["icono"].value = a?.icono || "";
  f.elements["precio_base"].value = a?.precio_base ?? 1;
  f.elements["volatilidad"].value = a?.volatilidad ?? 0;
  f.elements["paga_dividendo"].checked = a?.paga_dividendo || false;
  f.elements["dividendo_monto"].value = a?.dividendo_monto ?? 0;
  f.elements["dividendo_frecuencia"].value = a?.dividendo_frecuencia || "ninguna";
  document.getElementById("form-accion-titulo").textContent = esNueva ? "Nueva acción" : "Editar acción";
  toggleDivFields();
  document.getElementById("modal-accion").classList.remove("hidden");
}
function toggleDivFields() {
  const on = document.getElementById("form-accion").elements["paga_dividendo"].checked;
  document.getElementById("div-fields").classList.toggle("hidden", !on);
}

async function guardarAccionForm(e) {
  e.preventDefault();
  const f = e.target;
  const accion = {
    id: f.elements["id"].value || null,
    nombre: f.elements["nombre"].value.trim(),
    tipo: f.elements["tipo"].value,
    icono: f.elements["icono"].value.trim() || null,
    precio_base: parseFloat(f.elements["precio_base"].value),
    volatilidad: parseFloat(f.elements["volatilidad"].value) || 0,
    paga_dividendo: f.elements["paga_dividendo"].checked,
    dividendo_monto: parseFloat(f.elements["dividendo_monto"].value) || 0,
    dividendo_frecuencia: f.elements["dividendo_frecuencia"].value,
  };
  if (!accion.nombre || isNaN(accion.precio_base) || accion.precio_base <= 0)
    return toast("Nombre y valor de salida (>0) obligatorios", "down");
  try {
    await api.guardarAccion(state.pin, accion);
    document.getElementById("modal-accion").classList.add("hidden");
    toast("✅ Acción guardada", "up");
    await refrescar();
  } catch (e) { toast("❌ " + (e.message || "Error"), "down"); }
}

async function eliminarAccion(a) {
  if (!await confirmar(`¿Eliminar "${a.nombre}"? Se ocultará del mercado.`)) return;
  try {
    await api.eliminarAccion(state.pin, a.id);
    toast("🗑️ Acción eliminada", "down");
    await refrescar();
  } catch (e) { toast("❌ " + (e.message || "Error"), "down"); }
}

/* ============================================================
   REFRESCO
   ============================================================ */
async function refrescar() {
  await cargarTodo();
  render();
}

/* ============================================================
   CAMBIO DE VISTA
   ============================================================ */
function cambiarVista(v) {
  if (v === "padres" && !state.pin) {
    pedirPin(() => { state.vista = "padres"; state.paso = "hijos"; state.hijo = null; render(); });
    return;
  }
  state.vista = v;
  if (v === "padres") { state.paso = "hijos"; state.hijo = null; }
  render();
}

/* ============================================================
   INIT
   ============================================================ */
async function init() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});

  // Switch de vista
  document.querySelectorAll(".switch-btn").forEach((b) =>
    b.onclick = () => cambiarVista(b.dataset.vista));

  // PIN
  document.querySelectorAll("[data-pin]").forEach((b) =>
    b.onclick = () => pulsarPin(b.dataset.pin));
  document.getElementById("pin-cancel").onclick = () =>
    document.getElementById("modal-pin").classList.add("hidden");

  // Form acción
  document.getElementById("form-accion").onsubmit = guardarAccionForm;
  document.getElementById("form-accion").elements["paga_dividendo"].onchange = toggleDivFields;
  document.getElementById("accion-cancel").onclick = () =>
    document.getElementById("modal-accion").classList.add("hidden");

  try { await cargarTodo(); }
  catch (e) { toast("Error de conexión a Supabase (revisa api.js)", "down"); console.error(e); }

  render();
  setInterval(renderReloj, 1000 * 30); // reloj/mercado en vivo (Vista Niños)

  // Tiempo real: el Mac se actualiza solo
  try { api.suscribirCambios(async () => { await cargarTodo(); render(); }); } catch {}
}

document.addEventListener("DOMContentLoaded", init);
