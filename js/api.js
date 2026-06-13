/* ============================================================
   Family Stocks v2 · Capa de acceso a datos (Supabase)
   ------------------------------------------------------------
   Toda escritura pasa por RPC con PIN. El cliente solo LEE
   tablas/vistas y llama funciones rpc(). supabase-js se carga
   por CDN en index.html (window.supabase).
   ============================================================ */

const SUPABASE_URL  = "https://oeutgwxspyxhjklflnld.supabase.co";
const SUPABASE_ANON = "sb_publishable_NdaoQyxiPUpkRU55Er23Kw_33QiWbQN";

export const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

const ok = ({ data, error }) => { if (error) throw error; return data; };

/* ----------------------- LECTURAS ----------------------- */

export const getHijos = () =>
  db.from("usuarios").select("*").eq("rol", "hijo").eq("activo", true)
    .order("nombre").then(ok);

export const getPizarra = () =>
  db.from("vista_pizarra").select("*").then(ok);

// Catálogo completo de acciones (para el editor de la Vista Padres)
export const getAcciones = () =>
  db.from("acciones").select("*").eq("activa", true)
    .order("tipo").order("nombre").then(ok);

export const getRankingSemanal = () =>
  db.from("vista_ranking_semanal").select("*").then(ok);

export const getRankingGlobal = () =>
  db.from("vista_ranking_global").select("*").then(ok);

export const getCarteraDetalle = (usuarioId) =>
  db.from("vista_cartera_detalle").select("*")
    .eq("usuario_id", usuarioId).order("nombre").then(ok);

export const getEstadoMercado = () =>
  db.rpc("fn_estado_mercado").then(ok);

/* ----------------------- ESCRITURAS (RPC) ----------------------- */

export const validarPin = (pin) =>
  db.rpc("fn_validar_pin", { p_pin: pin }).then(ok);

export const validarTarea = (usuarioId, accionId, pin) =>
  db.rpc("fn_validar_tarea",
    { p_usuario: usuarioId, p_accion: accionId, p_pin: pin }).then(ok);

export const penalizarMercado = (usuarioId, accionId, pin) =>
  db.rpc("fn_penalizar_mercado",
    { p_usuario: usuarioId, p_accion: accionId, p_pin: pin }).then(ok);

export const liquidar = (usuarioId, ventas, pin) =>
  db.rpc("fn_liquidar",
    { p_usuario: usuarioId, p_ventas: ventas, p_pin: pin }).then(ok);

export const recompensaDirecta = (usuarioId, monto, nota, pin) =>
  db.rpc("fn_recompensa_directa",
    { p_usuario: usuarioId, p_monto: monto, p_nota: nota, p_pin: pin }).then(ok);

export const penalizacionDirecta = (usuarioId, monto, nota, pin) =>
  db.rpc("fn_penalizacion_directa",
    { p_usuario: usuarioId, p_monto: monto, p_nota: nota, p_pin: pin }).then(ok);

export const guardarAccion = (pin, accion) =>
  db.rpc("fn_guardar_accion", {
    p_pin: pin,
    p_id: accion.id ?? null,
    p_nombre: accion.nombre,
    p_tipo: accion.tipo,
    p_icono: accion.icono,
    p_precio_base: accion.precio_base,
    p_volatilidad: accion.volatilidad,
    p_paga_dividendo: accion.paga_dividendo,
    p_dividendo_monto: accion.dividendo_monto,
    p_dividendo_frecuencia: accion.dividendo_frecuencia,
  }).then(ok);

export const eliminarAccion = (pin, id) =>
  db.rpc("fn_eliminar_accion", { p_pin: pin, p_id: id }).then(ok);

/* ----------------------- TIEMPO REAL ----------------------- */
// El Dashboard del Mac se refresca solo ante cualquier operación.
export function suscribirCambios(onChange) {
  return db
    .channel("familystocks-rt")
    .on("postgres_changes", { event: "*", schema: "public", table: "historial_transacciones" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "acciones" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "cartera_activos" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "usuarios" }, onChange)
    .subscribe();
}
