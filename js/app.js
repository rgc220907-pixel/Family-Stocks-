/* ============================================================
   Family Stocks v2 · Lógica de aplicación
   ------------------------------------------------------------
   - Switch global Vista Niños (solo lectura) / Vista Padres (broker).
   - Mercado L–S: validar tareas (compra) y multas (impacto patrimonio).
   - Domingo: liquidación + recompensa/penalización directa al Cash.
   - CRUD de acciones (valor de salida, volatilidad, dividendos).

   El sistema visual es Tailwind inline (dark/zinc · brutalismo elegante).
   Los tokens de abajo evitan repetir cadenas de utilidades en el markup.
   ============================================================ */

import * as api from "./api.js";

// --------- Parámetros del multiplicador (espejo de la tabla config) ---------
const AP = 420, MID = 1110, CL = 1260; // 07:00 · 18:30 · 21:00 (min locales)

// --------- Tokens visuales (Tailwind) ---------
const UP = "text-emerald-400", DOWN = "text-red-500", MUTED = "text-zinc-500";
const NUM = "font-mono tabular-nums";
const TITLE = "text-[11px] font-semibold uppercase tracking-widest text-zinc-500";
const BTN = "border border-zinc-800 px-3 py-2 text-sm text-zinc-200 transition-colors hover:bg-zinc-800";
const PRIMARY = "w-full border border-emerald-500/50 px-3 py-2.5 text-sm font-semibold uppercase tracking-widest text-emerald-400 transition-colors hover:bg-emerald-500/10";
const ROW = "flex items-center justify-between gap-3 bg-zinc-900 px-3 py-3 text-left transition-colors hover:bg-zinc-800";

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
const flecha = (dir) => dir === "sube" ? "▲" : dir === "baja" ? "▼" : "—";
const colorDir = (dir) => dir === "sube" ? UP : dir === "baja" ? DOWN : MUTED;
const signo = (v) => (Number(v) >= 0 ? UP : DOWN);

// --------- Iconografía (Lucide) ---------
// Los emojis quedan reservados a avatares; el resto de la UI usa estos iconos.
const ic = (name, cls = "h-4 w-4") => `<i data-lucide="${name}" class="${cls}"></i>`;
const divIcon = `<span title="Paga dividendo">${ic("coins", "inline-block h-3.5 w-3.5 align-[-0.2em] text-zinc-500")}</span>`;
const pintarIconos = () => { if (window.lucide) window.lucide.createIcons(); };

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
  const c = tipo === "up" ? "border-emerald-500/50 text-emerald-400" : "border-red-500/50 text-red-500";
  t.className = `fixed left-1/2 bottom-6 z-[60] -translate-x-1/2 max-w-[90vw] border bg-zinc-900 px-4 py-2.5 text-xs tracking-wide ${NUM} ${c}`;
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.add("hidden"), 2600);
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
  pintarIconos();
}

/* ---------------------- VISTA NIÑOS ---------------------- */
function renderNinos() {
  renderReloj();
  renderPodio("podio-semanal", state.rankSemanal, "patrimonio_vivo");
  renderPodio("podio-global", state.rankGlobal, "cash_global");

  document.getElementById("pizarra-body").innerHTML = state.pizarra.map((a) => {
    const pasivo = a.tipo === "pasivo";
    return `<tr>
      <td class="py-2 pr-2 text-zinc-200">${a.nombre}${a.paga_dividendo ? ` ${divIcon}` : ""}</td>
      <td class="py-2 text-right ${NUM} ${pasivo ? DOWN : "text-zinc-100"}">${pasivo ? "−" : ""}${eur(a.precio_actual)}</td>
      <td class="py-2 text-right ${NUM} ${colorDir(a.direccion)}">${flecha(a.direccion)} ${Number(a.variacion) !== 0 ? fmt(a.variacion) : ""}</td>
    </tr>`;
  }).join("");
}

function renderReloj() {
  const now = new Date();
  const m = multiplicadorHorario(now);
  const dom = esDomingo(now);
  const abierto = mercadoAbierto(now);
  const col = (dom || !abierto) ? MUTED : (m >= 1 ? UP : DOWN);
  let estado;
  if (dom) estado = "Domingo · cierre de mercado";
  else if (!abierto) estado = "Mercado cerrado · abre 07:00";
  else estado = "Multiplicador en vivo";

  document.getElementById("reloj-mercado").innerHTML = `
    <div class="flex items-baseline gap-4">
      <div class="${NUM} text-3xl font-semibold tracking-tight text-zinc-100">${now.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}</div>
      <div class="${TITLE} ${col}">${estado}</div>
      ${(!dom && abierto) ? `<div class="ml-auto ${NUM} text-2xl font-semibold ${col}">×${m.toFixed(2)}</div>` : ""}
    </div>`;
}

function renderPodio(id, ranking, campo) {
  document.getElementById(id).innerHTML = ranking.map((j, i) => {
    const v = Number(j[campo]) || 0;
    const accent = i === 0 ? "border-l-emerald-500" : "border-l-transparent";
    return `<div class="flex items-center gap-3 border-l-2 ${accent} bg-zinc-900 px-3 py-2.5">
      <span class="${NUM} w-5 text-xs text-zinc-600">${String(i + 1).padStart(2, "0")}</span>
      <span class="text-xl leading-none">${j.avatar || "·"}</span>
      <span class="flex-1 truncate text-sm font-medium text-zinc-100">${j.nombre}</span>
      <span class="${NUM} text-base font-semibold ${signo(v)}">${eur(v)}</span>
    </div>`;
  }).join("");
}

/* ---------------------- VISTA PADRES ---------------------- */
function renderPadres() {
  const dom = esDomingo();
  document.getElementById("padres-modo").textContent =
    dom ? "Modo liquidación · Domingo" : "Mercado abierto · Broker";

  const wrap = document.getElementById("padres-contenido");
  if (state.paso === "acciones") return renderEditorAcciones(wrap);
  if (!state.hijo)              return renderGridHijos(wrap, dom);
  if (dom)                     return renderLiquidacion(wrap);
  return renderOperar(wrap);
}

function botonVolver(label = "Volver") {
  return `<button id="btn-volver" class="mb-3 inline-flex items-center gap-1 text-[11px] uppercase tracking-widest text-zinc-500 transition-colors hover:text-zinc-200">${ic("arrow-left", "h-3.5 w-3.5")}${label}</button>`;
}
function bindVolver(fn) {
  const b = document.getElementById("btn-volver");
  if (b) b.onclick = fn;
}

function headerHijo(extra = "") {
  const h = state.hijo;
  return `<div class="mb-4 flex items-center gap-3 border border-zinc-800 bg-zinc-900 px-3 py-2.5">
    <span class="text-2xl leading-none">${h.avatar || "·"}</span>
    <div class="flex-1">
      <div class="text-sm font-semibold text-zinc-100">${h.nombre}</div>
      <div class="${TITLE}">${extra}</div>
    </div>
  </div>`;
}

// Grid de hijos
function renderGridHijos(wrap, dom) {
  wrap.innerHTML = `
    <div class="mb-3 flex justify-end">
      <button id="ir-acciones" class="${BTN} inline-flex items-center gap-1.5">${ic("settings", "h-4 w-4")}Gestionar acciones</button>
    </div>
    <h2 class="${TITLE} mb-3">${dom ? "Selecciona hijo · liquidación" : "Selecciona hijo"}</h2>
    <div class="grid grid-cols-2 gap-px border border-zinc-800 bg-zinc-800 sm:grid-cols-3 lg:grid-cols-4">
      ${state.hijos.map((h) => `
        <button class="hijo-card flex flex-col items-center gap-1 bg-zinc-900 px-3 py-4 transition-colors hover:bg-zinc-800" data-id="${h.id}">
          <span class="text-3xl leading-none">${h.avatar || "·"}</span>
          <span class="text-sm font-medium text-zinc-100">${h.nombre}</span>
          <span class="${NUM} text-[11px] ${MUTED}">${eur(h.cash_global)}</span>
        </button>`).join("")}
    </div>`;
  document.getElementById("ir-acciones").onclick = () => { state.paso = "acciones"; render(); };
  wrap.querySelectorAll(".hijo-card").forEach((b) =>
    b.onclick = () => { state.hijo = state.hijos.find((x) => x.id === b.dataset.id); render(); });
}

// Operar (L–S): validar tareas + penalizaciones + comodín de Cash
function renderOperar(wrap) {
  const activos = state.pizarra.filter((a) => a.tipo === "activo");
  const pasivos = state.pizarra.filter((a) => a.tipo === "pasivo");
  const m = multiplicadorHorario();
  const abierto = mercadoAbierto();

  wrap.innerHTML = `
    ${botonVolver()}
    ${headerHijo(`Multiplicador <span class="${NUM} ${m >= 1 ? UP : DOWN}">×${m.toFixed(2)}</span>`)}
    ${!abierto ? `<div class="mb-3 border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-400">Mercado cerrado. Las operaciones se rechazarán hasta las 07:00.</div>` : ""}

    <h3 class="${TITLE} mb-2">Mercado de tareas</h3>
    <div class="mb-5 divide-y divide-zinc-800 border border-zinc-800">${activos.map((a) => tarjetaOp(a, "compra", m)).join("")}</div>

    <h3 class="${TITLE} mb-2">Penalizaciones</h3>
    <div class="mb-5 divide-y divide-zinc-800 border border-zinc-800">${pasivos.map((a) => tarjetaOp(a, "multa", m)).join("")}</div>

    <h3 class="${TITLE} mb-2">Comodín · Cash Global</h3>
    <div class="grid grid-cols-2 gap-2">
      <button id="comodin-mas" class="${BTN} ${UP} inline-flex items-center justify-center gap-1.5">${ic("plus", "h-4 w-4")}Sumar Cash</button>
      <button id="comodin-menos" class="${BTN} ${DOWN} inline-flex items-center justify-center gap-1.5">${ic("minus", "h-4 w-4")}Restar Cash</button>
    </div>`;

  bindVolver(() => { state.hijo = null; render(); });
  wrap.querySelectorAll("[data-op]").forEach((b) => b.onclick = () => operar(b.dataset.op, b.dataset.id));
  document.getElementById("comodin-mas").onclick = () => directa("rec");
  document.getElementById("comodin-menos").onclick = () => directa("pen");
}

function tarjetaOp(a, op, m) {
  const esCompra = op === "compra";
  const valor = esCompra ? a.precio_actual * m : a.precio_actual;
  return `<button class="${ROW} w-full" data-op="${op}" data-id="${a.id}">
    <div class="min-w-0">
      <div class="truncate text-sm font-medium text-zinc-100">${a.nombre}${a.paga_dividendo ? ` ${divIcon}` : ""}</div>
      <div class="${TITLE} mt-0.5">Hoy <span class="${NUM} text-zinc-400">${eur(a.precio_actual)}</span>${esCompra ? ` · ×${m.toFixed(2)}` : ""}</div>
    </div>
    <div class="${NUM} text-base font-semibold ${esCompra ? UP : DOWN}">${esCompra ? "+" : "−"}${eur(valor)}</div>
  </button>`;
}

async function operar(op, accionId) {
  const accion = state.acciones.find((a) => a.id === accionId);
  try {
    const r = op === "compra"
      ? await api.validarTarea(state.hijo.id, accionId, state.pin)
      : await api.penalizarMercado(state.hijo.id, accionId, state.pin);
    if (op === "compra")
      toast(`OK ${accion.nombre}  +${r.acciones_anadidas} acc · +${eur(r.valor_operacion)}`, "up");
    else
      toast(`${accion.nombre}  ${eur(r.impacto)} patrimonio`, "down");
    await refrescar();
  } catch (e) { toast("ERROR · " + (e.message || "fallo"), "down"); }
}

// Liquidación de domingo
async function renderLiquidacion(wrap) {
  const h = state.hijo;
  wrap.innerHTML = `
    ${botonVolver()}
    ${headerHijo(`Cash Global <span class="${NUM} text-zinc-300">${eur(h.cash_global)}</span>`)}
    <div id="cartera-zona" class="text-sm text-zinc-500">Cargando cartera…</div>
    <h3 class="${TITLE} mb-2 mt-5">Operación directa al Cash</h3>
    <div class="grid grid-cols-2 gap-2">
      <button id="rec-directa" class="${BTN} ${UP} inline-flex items-center justify-center gap-1.5">${ic("plus", "h-4 w-4")}Recompensa</button>
      <button id="pen-directa" class="${BTN} ${DOWN} inline-flex items-center justify-center gap-1.5">${ic("minus", "h-4 w-4")}Penalización</button>
    </div>`;
  bindVolver(() => { state.hijo = null; render(); });
  document.getElementById("pen-directa").onclick = () => directa("pen");
  document.getElementById("rec-directa").onclick = () => directa("rec");

  const cartera = await api.getCarteraDetalle(h.id);
  const zona = document.getElementById("cartera-zona");
  if (!cartera.length) {
    zona.innerHTML = `<div class="border border-zinc-800 bg-zinc-900 px-3 py-3 text-xs ${MUTED}">Cartera vacía · nada que liquidar.</div>`;
    return;
  }

  zona.innerHTML = `
    <h3 class="${TITLE} mb-2">Cartera · precio de cierre</h3>
    <div class="mb-3 divide-y divide-zinc-800 border border-zinc-800">${cartera.map((c) => `
      <div class="liq-row flex items-center justify-between gap-3 bg-zinc-900 px-3 py-3" data-accion="${c.accion_id}" data-precio="${c.precio_actual}" data-max="${c.cantidad}">
        <div class="min-w-0">
          <div class="text-sm font-medium text-zinc-100">${c.nombre}${c.paga_dividendo ? ` ${divIcon}` : ""}</div>
          <div class="${TITLE} mt-0.5"><span class="${NUM} text-zinc-400">${(+c.cantidad).toFixed(2)}</span> acc · cierre <span class="${NUM} text-zinc-400">${eur(c.precio_actual)}</span> → <span class="${NUM} text-zinc-300">${eur(c.valor_actual)}</span></div>
        </div>
        <div class="flex flex-col items-end gap-1">
          <label class="flex items-center gap-2 ${TITLE}">Vender
            <input type="number" class="inp-vender w-20 border border-zinc-800 bg-zinc-950 px-2 py-1 text-right text-zinc-100 ${NUM}" min="0" max="${c.cantidad}" step="0.01" value="0" />
          </label>
          <span class="conservar ${NUM} w-full text-right text-[11px] ${MUTED}">Conserva ${(+c.cantidad).toFixed(2)}</span>
        </div>
      </div>`).join("")}</div>
    <div class="mb-3 flex items-center justify-between border border-zinc-800 bg-zinc-900 px-3 py-2.5">
      <span class="${TITLE}">Total a Cash</span>
      <span id="liq-total" class="${NUM} text-lg font-semibold ${UP}">0.00</span>
    </div>
    <button id="btn-liquidar" class="${PRIMARY}">Confirmar liquidación</button>`;
  pintarIconos(); // la cartera se inyecta async; redibuja sus iconos

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
      toast(`Liquidado · +${eur(r.cash_ingresado)} a Cash`, "up");
      await refrescar();
      state.hijo = state.hijos.find((x) => x.id === h.id); // refresca cash mostrado
      render();
    } catch (e) { toast("ERROR · " + (e.message || "fallo"), "down"); }
  };
}

async function directa(tipo) {
  const h = state.hijo;
  const monto = parseFloat(prompt(`${tipo === "rec" ? "Recompensa" : "Penalización"} directa a Cash Global · ${h.nombre}\nPuntos:`, "1"));
  if (!monto || monto <= 0) return;
  const nota = prompt("Motivo (opcional):", "") || null;
  try {
    const r = tipo === "rec"
      ? await api.recompensaDirecta(h.id, monto, nota, state.pin)
      : await api.penalizacionDirecta(h.id, monto, nota, state.pin);
    toast(tipo === "rec" ? `+${eur(r.cash_sumado)} a Cash` : `−${eur(r.cash_restado)} de Cash`,
          tipo === "rec" ? "up" : "down");
    await refrescar();
    state.hijo = state.hijos.find((x) => x.id === h.id);
    render();
  } catch (e) { toast("ERROR · " + (e.message || "fallo"), "down"); }
}

/* ---------------------- EDITOR DE ACCIONES (CRUD) ---------------------- */
function renderEditorAcciones(wrap) {
  wrap.innerHTML = `
    ${botonVolver()}
    <div class="mb-3 flex items-center justify-between">
      <h2 class="${TITLE}">Acciones del mercado</h2>
      <button id="nueva-accion" class="${BTN} ${UP} inline-flex items-center gap-1.5">${ic("plus", "h-4 w-4")}Nueva</button>
    </div>
    <div class="divide-y divide-zinc-800 border border-zinc-800">${state.acciones.map(filaAccion).join("")}</div>`;
  bindVolver(() => { state.paso = "hijos"; render(); });
  document.getElementById("nueva-accion").onclick = () => abrirFormAccion(null);
  wrap.querySelectorAll("[data-edit]").forEach((b) =>
    b.onclick = () => abrirFormAccion(state.acciones.find((a) => a.id === b.dataset.edit)));
  wrap.querySelectorAll("[data-del]").forEach((b) =>
    b.onclick = () => eliminarAccion(state.acciones.find((a) => a.id === b.dataset.del)));
}

function filaAccion(a) {
  const esActivo = a.tipo === "activo";
  const badge = esActivo ? "border-emerald-500/40 text-emerald-400" : "border-red-500/40 text-red-500";
  return `<div class="flex items-center gap-2 bg-zinc-900 px-3 py-2.5">
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2 text-sm font-medium text-zinc-100">
        <span class="truncate">${a.nombre}</span>
        <span class="border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${badge}">${a.tipo}</span>
      </div>
      <div class="${TITLE} mt-0.5">salida <span class="${NUM} text-zinc-400">${eur(a.precio_base)}</span> · vol <span class="${NUM} text-zinc-400">${(+a.volatilidad).toFixed(2)}</span>${a.paga_dividendo ? ` · ${divIcon} <span class="${NUM} text-zinc-400">${eur(a.dividendo_monto)}</span>/${a.dividendo_frecuencia}` : ""}</div>
    </div>
    <button class="px-1 text-zinc-500 transition-colors hover:text-zinc-100" data-edit="${a.id}">${ic("square-pen", "h-4 w-4")}</button>
    <button class="px-1 text-zinc-500 transition-colors hover:text-red-500" data-del="${a.id}">${ic("trash-2", "h-4 w-4")}</button>
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
    toast("Acción guardada", "up");
    await refrescar();
  } catch (e) { toast("ERROR · " + (e.message || "fallo"), "down"); }
}

async function eliminarAccion(a) {
  if (!await confirmar(`¿Eliminar "${a.nombre}"? Se ocultará del mercado.`)) return;
  try {
    await api.eliminarAccion(state.pin, a.id);
    toast("Acción eliminada", "down");
    await refrescar();
  } catch (e) { toast("ERROR · " + (e.message || "fallo"), "down"); }
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

  document.querySelectorAll(".switch-btn").forEach((b) =>
    b.onclick = () => cambiarVista(b.dataset.vista));

  document.querySelectorAll("[data-pin]").forEach((b) =>
    b.onclick = () => pulsarPin(b.dataset.pin));
  document.getElementById("pin-cancel").onclick = () =>
    document.getElementById("modal-pin").classList.add("hidden");

  document.getElementById("form-accion").onsubmit = guardarAccionForm;
  document.getElementById("form-accion").elements["paga_dividendo"].onchange = toggleDivFields;
  document.getElementById("accion-cancel").onclick = () =>
    document.getElementById("modal-accion").classList.add("hidden");

  try { await cargarTodo(); }
  catch (e) { toast("Error de conexión a Supabase (revisa api.js)", "down"); console.error(e); }

  render();
  setInterval(renderReloj, 1000 * 30); // reloj/mercado en vivo (Vista Niños)

  try { api.suscribirCambios(async () => { await cargarTodo(); render(); }); } catch {}
}

document.addEventListener("DOMContentLoaded", init);
