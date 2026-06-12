/* ============================================================
   Family Stocks · Capa de acceso a datos (Supabase)
   ============================================================
   Configura tus credenciales abajo. La librería supabase-js se
   carga por CDN en index.html (window.supabase).
   ============================================================ */

const SUPABASE_URL  = "https://oeutgwxspyxhjklflnld.supabase.co";
const SUPABASE_ANON = "sb_publishable_NdaoQyxiPUpkRU55Er23Kw_33QiWbQN";

// Cliente único reutilizable
export const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

// ------------------------------------------------------------
// Lecturas
// ------------------------------------------------------------

export async function getPerfiles() {
  const { data, error } = await db
    .from("perfiles")
    .select("*")
    .order("rol", { ascending: true })
    .order("nombre", { ascending: true });
  if (error) throw error;
  return data;
}

export async function getJugadores() {
  const { data, error } = await db
    .from("perfiles")
    .select("*")
    .eq("rol", "jugador")
    .order("nombre");
  if (error) throw error;
  return data;
}

export async function getTareas() {
  const { data, error } = await db
    .from("tareas")
    .select("*")
    .order("tipo", { ascending: true })
    .order("puntos_base", { ascending: false });
  if (error) throw error;
  return data;
}

// Trae TODO el historial (la familia es pequeña; el ranking se
// calcula en cliente — el "motor financiero").
export async function getHistorial() {
  const { data, error } = await db
    .from("historial")
    .select("*")
    .order("fecha", { ascending: false });
  if (error) throw error;
  return data;
}

// ------------------------------------------------------------
// Escrituras
// ------------------------------------------------------------

export async function insertarMovimiento(mov) {
  // mov: { perfil_id, tarea_id|null, descripcion_custom|null, puntos_finales, fecha }
  const { data, error } = await db
    .from("historial")
    .insert(mov)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ------------------------------------------------------------
// Tiempo real (opcional) — el Dashboard del Mac escucha cambios
// ------------------------------------------------------------

export function suscribirHistorial(onChange) {
  return db
    .channel("historial-rt")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "historial" },
      (payload) => onChange(payload)
    )
    .subscribe();
}
