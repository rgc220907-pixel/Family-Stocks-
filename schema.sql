-- ============================================================
-- Family Stocks · Esquema de Base de Datos (Supabase / Postgres)
-- ============================================================

-- Limpieza previa (orden por dependencias)
drop table if exists historial cascade;
drop table if exists tareas cascade;
drop table if exists perfiles cascade;

-- ------------------------------------------------------------
-- Tabla: perfiles
-- ------------------------------------------------------------
create table perfiles (
  id        uuid primary key default gen_random_uuid(),
  nombre    text not null,
  rol       text not null default 'jugador' check (rol in ('padre', 'jugador')),
  avatar    text,
  creado_en timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Tabla: tareas
-- ------------------------------------------------------------
create table tareas (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null,
  puntos_base numeric(5,2) not null,
  tipo        text not null check (tipo in ('positiva', 'negativa')),
  creado_en   timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Tabla: historial (el "libro de órdenes" del mercado)
-- ------------------------------------------------------------
create table historial (
  id                uuid primary key default gen_random_uuid(),
  perfil_id         uuid not null references perfiles(id) on delete cascade,
  tarea_id          uuid references tareas(id) on delete set null,
  descripcion_custom text,
  puntos_finales    numeric(6,2) not null,
  fecha             timestamptz not null default now()
);

create index idx_historial_perfil on historial(perfil_id);
create index idx_historial_fecha  on historial(fecha);

-- ------------------------------------------------------------
-- Seguridad a nivel de fila (RLS) — abierto para uso doméstico.
-- El control de acceso real lo aplica el PIN '2026' en el cliente.
-- ------------------------------------------------------------
alter table perfiles  enable row level security;
alter table tareas    enable row level security;
alter table historial enable row level security;

create policy "acceso_total_perfiles"  on perfiles  for all using (true) with check (true);
create policy "acceso_total_tareas"    on tareas    for all using (true) with check (true);
create policy "acceso_total_historial" on historial for all using (true) with check (true);

-- ============================================================
-- INSERTS OBLIGATORIOS
-- ============================================================

-- ---- Tareas POSITIVAS ----
insert into tareas (nombre, puntos_base, tipo) values
  ('Recoger cocina',          2.0, 'positiva'),
  ('Extra: salón',            0.5, 'positiva'),
  ('Extra: encimera',         0.5, 'positiva'),
  ('Extra: suelo',            0.5, 'positiva'),
  ('Recoger habitación',      1.0, 'positiva'),
  ('Hacer cama al despertar', 1.0, 'positiva'),
  ('Comer todo del plato',    0.5, 'positiva'),
  ('Rezar por la noche',      1.0, 'positiva');

-- ---- Tareas NEGATIVAS ----
insert into tareas (nombre, puntos_base, tipo) values
  ('Pelearse/discutir',          -3.0, 'negativa'),
  ('Insulto/palabrota',          -4.0, 'negativa'),
  ('Desorden intencionado',      -2.0, 'negativa'),
  ('Mal comportamiento en mesa', -3.0, 'negativa');

-- ---- Perfiles de la familia ----
insert into perfiles (nombre, rol, avatar) values
  ('Papá', 'padre', '👨'),
  ('Mamá', 'padre', '👩'),
  ('Raúl', 'jugador', '👑'),
  ('Izan', 'jugador', '👦'),
  ('Martín', 'jugador', '🦁'),
  ('María', 'jugador', '🦄'),
  ('Loreto', 'jugador', '👧'),
  ('Gabriel', 'jugador', '🚀'),
  ('Magdalena', 'jugador', '🦋');
