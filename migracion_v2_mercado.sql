-- ============================================================================
--  FAMILY STOCKS · MIGRACIÓN v2 — "Simulador de Inversión Bursátil Doméstico"
-- ============================================================================
--  Reestructura por completo el modelo v1 (perfiles/tareas/historial) hacia
--  una economía dual:
--    · CASH GLOBAL  -> saldo líquido, estable, "caja fuerte" (no fluctúa).
--    · PATRIMONIO    -> valoración VIVA de la cartera al precio de HOY (fluctúa).
--
--  Zona horaria de negocio: Europe/Madrid (mercado abre 07:00 / cierra 21:00).
--  Seguridad: las operaciones de escritura son RPC (SECURITY DEFINER) que
--  exigen el PIN de padres; el cliente nunca escribe directo en las tablas.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 0. LIMPIEZA DEL MODELO ANTIGUO
-- ----------------------------------------------------------------------------
drop table if exists historial cascade;
drop table if exists tareas    cascade;
drop table if exists perfiles  cascade;

drop table if exists historial_transacciones cascade;
drop table if exists cartera_activos          cascade;
drop table if exists precios_historico         cascade;
drop table if exists acciones                  cascade;
drop table if exists usuarios                  cascade;
drop table if exists config                    cascade;

-- ============================================================================
-- 1. TABLAS
-- ============================================================================

-- 1.1 Configuración global (singleton, id=1) -------------------------------
create table config (
  id                       int primary key default 1 check (id = 1),
  pin_padres               text    not null default '2026',
  tz                       text    not null default 'Europe/Madrid',
  -- Parámetros del multiplicador horario (minutos desde medianoche local)
  apertura_min             int     not null default 420,   -- 07:00
  inicio_decay_min         int     not null default 1110,  -- 18:30
  cierre_min               int     not null default 1260,  -- 21:00
  mult_apertura            numeric not null default 1.5,
  mult_meseta              numeric not null default 1.0,    -- valor en inicio_decay
  mult_minimo              numeric not null default 0.5,    -- valor en cierre
  -- Suelo de precio para que un activo no llegue nunca a ~0
  suelo_precio_ratio       numeric not null default 0.25
);
insert into config (id) values (1);

-- 1.2 Usuarios (la doble economía vive aquí) -------------------------------
create table usuarios (
  id           uuid primary key default gen_random_uuid(),
  nombre       text not null,
  rol          text not null default 'hijo' check (rol in ('padre','hijo')),
  avatar       text,
  -- CASH GLOBAL: saldo líquido liquidado. Estable. Ranking Global.
  cash_global  numeric(12,2) not null default 0,
  -- NOTA: el PATRIMONIO no se almacena: se calcula en vista_patrimonio
  --       (cartera × precio_hoy) − penalizaciones de la semana.
  activo       boolean not null default true,
  creado_en    timestamptz not null default now()
);

-- 1.3 Acciones (activos = tareas, pasivos = multas) ------------------------
create table acciones (
  id              uuid primary key default gen_random_uuid(),
  nombre          text not null,
  tipo            text not null check (tipo in ('activo','pasivo')),  -- activo=tarea, pasivo=multa
  icono           text,
  precio_base     numeric(8,2) not null,           -- ancla; siempre positivo (magnitud)
  volatilidad     numeric(4,3) not null default 0  -- amplitud de oscilación diaria (0 = estable)
                  check (volatilidad >= 0 and volatilidad <= 1),
  precio_actual   numeric(8,2) not null default 0, -- "precio de HOY" (lo fija el cron 00:00)
  precio_anterior numeric(8,2) not null default 0, -- precio de AYER (para flecha verde/roja)
  paga_dividendo  boolean not null default false,  -- renta pasiva por holdear
  dividendo_monto numeric(8,2) not null default 0,  -- Cash por ACCIÓN en cada pago
  dividendo_frecuencia text not null default 'ninguna'
                  check (dividendo_frecuencia in ('ninguna','diaria','semanal','mensual')),
  activa          boolean not null default true,
  creado_en       timestamptz not null default now()
);

-- 1.4 Cartera (inventario: cuántas acciones tiene cada niño) ----------------
--      cantidad es NUMÉRICO y fraccionario a propósito (ver fn_validar_tarea:
--      el multiplicador horario se traduce en MÁS o MENOS acciones por tarea).
create table cartera_activos (
  id          uuid primary key default gen_random_uuid(),
  usuario_id  uuid not null references usuarios(id) on delete cascade,
  accion_id   uuid not null references acciones(id) on delete cascade,
  cantidad    numeric(10,3) not null default 0 check (cantidad >= 0),
  actualizado timestamptz not null default now(),
  unique (usuario_id, accion_id)
);
create index idx_cartera_usuario on cartera_activos(usuario_id);

-- 1.5 Historial de transacciones (libro mayor / ledger) ---------------------
create table historial_transacciones (
  id              uuid primary key default gen_random_uuid(),
  usuario_id      uuid not null references usuarios(id) on delete cascade,
  accion_id       uuid references acciones(id) on delete set null,
  tipo            text not null check (tipo in (
                    'compra',               -- validar tarea -> suma acciones a cartera (afecta PATRIMONIO)
                    'penalizacion_mercado', -- multa L-S a precio de hoy, impacto fijo (afecta PATRIMONIO)
                    'venta_liquidacion',    -- domingo: vende acciones -> CASH
                    'dividendo',            -- renta pasiva mensual -> CASH
                    'recompensa_directa',   -- domingo: inyección limpia -> CASH
                    'penalizacion_directa'  -- domingo: descuento directo -> CASH
                  )),
  afecta          text not null check (afecta in ('patrimonio','cash')),
  cantidad        numeric(10,3),   -- nº de acciones implicadas (compra/venta)
  precio_unitario numeric(8,2),    -- precio_actual capturado en el momento
  multiplicador   numeric(4,3),    -- multiplicador horario capturado (solo compra)
  valor           numeric(12,2) not null, -- efecto neto con signo (+ suma, − resta)
  nota            text,
  creado_en       timestamptz not null default now()
);
create index idx_hist_usuario on historial_transacciones(usuario_id);
create index idx_hist_tipo_fecha on historial_transacciones(tipo, creado_en);

-- 1.6 Histórico de precios (auditoría del mercado) --------------------------
create table precios_historico (
  id         uuid primary key default gen_random_uuid(),
  accion_id  uuid not null references acciones(id) on delete cascade,
  fecha      date not null,
  precio     numeric(8,2) not null,
  unique (accion_id, fecha)
);

-- ============================================================================
-- 2. FUNCIONES DE TIEMPO / MERCADO (helpers)
-- ============================================================================

-- Minutos locales desde medianoche (Europe/Madrid)
create or replace function _min_local(p_t timestamptz)
returns int language sql stable as $$
  select (extract(hour   from (p_t at time zone (select tz from config where id=1)))::int) * 60
       +  extract(minute from (p_t at time zone (select tz from config where id=1)))::int;
$$;

create or replace function es_domingo(p_t timestamptz default now())
returns boolean language sql stable as $$
  select extract(dow from (p_t at time zone (select tz from config where id=1)))::int = 0;
$$;

-- ¿Mercado especulativo abierto? (L–S, dentro del horario)
create or replace function mercado_abierto(p_t timestamptz default now())
returns boolean language sql stable as $$
  select (not es_domingo(p_t))
     and _min_local(p_t) >= (select apertura_min from config where id=1)
     and _min_local(p_t) <= (select cierre_min   from config where id=1);
$$;

-- MULTIPLICADOR HORARIO (Impuesto a la Procrastinación)
--   07:00 -> 1.5x ; baja linealmente hasta 1.0x a las 18:30 ;
--   desde 18:30 cae linealmente hasta 0.5x a las 21:00.
create or replace function multiplicador_horario(p_t timestamptz default now())
returns numeric language plpgsql stable as $$
declare
  c   config%rowtype;
  m   int;
  val numeric;
begin
  select * into c from config where id = 1;
  m := _min_local(p_t);

  if m <= c.apertura_min then
    val := c.mult_apertura;                                   -- pre-apertura: clamp a 1.5
  elsif m <= c.inicio_decay_min then
    -- tramo 1: 1.5 -> 1.0 entre apertura y inicio_decay
    val := c.mult_apertura
         + (c.mult_meseta - c.mult_apertura)
         * (m - c.apertura_min)::numeric / (c.inicio_decay_min - c.apertura_min);
  elsif m <= c.cierre_min then
    -- tramo 2: 1.0 -> 0.5 entre inicio_decay y cierre
    val := c.mult_meseta
         + (c.mult_minimo - c.mult_meseta)
         * (m - c.inicio_decay_min)::numeric / (c.cierre_min - c.inicio_decay_min);
  else
    val := c.mult_minimo;                                     -- post-cierre: clamp a 0.5
  end if;

  return round(val, 3);
end;
$$;

-- Inicio de la "semana de mercado" (lunes 00:00 local) en timestamptz.
-- Sirve para que las penalizaciones de impacto solo afecten la semana en curso.
create or replace function inicio_semana_mercado(p_t timestamptz default now())
returns timestamptz language sql stable as $$
  select (date_trunc('week', (p_t at time zone (select tz from config where id=1))))
         at time zone (select tz from config where id=1);
$$;

create or replace function _check_pin(p_pin text)
returns void language plpgsql as $$
begin
  if p_pin is distinct from (select pin_padres from config where id = 1) then
    raise exception 'PIN incorrecto' using errcode = '28000';
  end if;
end;
$$;

-- Validación de PIN para abrir la Vista Padres (no expone el PIN al cliente)
create or replace function fn_validar_pin(p_pin text)
returns boolean language sql security definer as $$
  select p_pin = (select pin_padres from config where id = 1);
$$;

-- Estado del mercado en vivo (para la cabecera de la Vista Niños)
create or replace function fn_estado_mercado()
returns jsonb language sql stable security definer as $$
  select jsonb_build_object(
    'multiplicador', multiplicador_horario(),
    'abierto',       mercado_abierto(),
    'domingo',       es_domingo()
  );
$$;

-- ============================================================================
-- 3. VISTAS (lectura — la "Pizarra" y los rankings)
-- ============================================================================

-- 3.1 Pizarra de cotizaciones (precio de hoy + dirección vs ayer + dividendo)
create or replace view vista_pizarra as
select
  a.id, a.nombre, a.tipo, a.icono,
  a.precio_base, a.volatilidad,
  a.precio_actual, a.precio_anterior,
  case
    when a.precio_actual > a.precio_anterior then 'sube'
    when a.precio_actual < a.precio_anterior then 'baja'
    else 'igual'
  end as direccion,
  round(a.precio_actual - a.precio_anterior, 2) as variacion,
  a.paga_dividendo, a.dividendo_monto, a.dividendo_frecuencia
from acciones a
where a.activa
order by a.tipo, a.nombre;

-- 3.2 PATRIMONIO VIVO (Ranking Semanal):
--     (cartera de activos × precio de HOY)  +  penalizaciones de mercado de la
--     semana en curso (valor fijo negativo, no acumulable entre semanas).
create or replace view vista_patrimonio as
select
  u.id   as usuario_id,
  u.nombre, u.avatar,
  coalesce(hold.valor, 0) + coalesce(pen.impacto, 0) as patrimonio_vivo,
  coalesce(hold.valor, 0)  as valor_cartera,
  coalesce(pen.impacto, 0) as impacto_multas_semana
from usuarios u
left join (
  select c.usuario_id, sum(c.cantidad * a.precio_actual) as valor
  from cartera_activos c
  join acciones a on a.id = c.accion_id and a.tipo = 'activo'
  group by c.usuario_id
) hold on hold.usuario_id = u.id
left join (
  select t.usuario_id, sum(t.valor) as impacto
  from historial_transacciones t
  where t.tipo = 'penalizacion_mercado'
    and t.creado_en >= inicio_semana_mercado()
  group by t.usuario_id
) pen on pen.usuario_id = u.id
where u.rol = 'hijo' and u.activo;

-- 3.3 Rankings
create or replace view vista_ranking_semanal as
  select usuario_id, nombre, avatar, patrimonio_vivo
  from vista_patrimonio
  order by patrimonio_vivo desc;

create or replace view vista_ranking_global as
  select id as usuario_id, nombre, avatar, cash_global
  from usuarios
  where rol = 'hijo' and activo
  order by cash_global desc;

-- 3.4 Cartera detallada de un niño (para la pantalla de liquidación del domingo)
create or replace view vista_cartera_detalle as
select
  c.usuario_id, c.accion_id, a.nombre, a.icono,
  c.cantidad,
  a.precio_actual,
  round(c.cantidad * a.precio_actual, 2) as valor_actual,
  a.paga_dividendo, a.dividendo_monto, a.dividendo_frecuencia
from cartera_activos c
join acciones a on a.id = c.accion_id and a.tipo = 'activo'
where c.cantidad > 0;

-- ============================================================================
-- 4. RPC DE ESCRITURA (todas exigen PIN; SECURITY DEFINER)
-- ============================================================================

-- 4.1 VALIDAR TAREA (compra de acciones, L–S)
--   El multiplicador horario se traduce en cantidad de acciones recibidas:
--   1 tarea = (1 × multiplicador) acciones. Validar a las 07:00 (×1.5) entrega
--   1.5 acciones; a las 21:00 (×0.5) sólo 0.5. Así el "impuesto a la
--   procrastinación" impacta el Patrimonio de forma permanente y se conserva
--   en la liquidación del domingo.
create or replace function fn_validar_tarea(p_usuario uuid, p_accion uuid, p_pin text)
returns jsonb language plpgsql security definer as $$
declare
  m numeric; precio numeric; cant numeric; a acciones%rowtype;
begin
  perform _check_pin(p_pin);
  if not mercado_abierto() then
    raise exception 'El mercado está cerrado (L–S 07:00–21:00).';
  end if;

  select * into a from acciones where id = p_accion and tipo = 'activo' and activa;
  if not found then raise exception 'Acción inexistente o no es un activo.'; end if;

  m      := multiplicador_horario();
  precio := a.precio_actual;
  cant   := m;  -- 1 tarea × multiplicador = acciones añadidas

  insert into cartera_activos (usuario_id, accion_id, cantidad)
  values (p_usuario, p_accion, cant)
  on conflict (usuario_id, accion_id)
  do update set cantidad = cartera_activos.cantidad + excluded.cantidad,
                actualizado = now();

  insert into historial_transacciones
    (usuario_id, accion_id, tipo, afecta, cantidad, precio_unitario, multiplicador, valor, nota)
  values
    (p_usuario, p_accion, 'compra', 'patrimonio', cant, precio, m, round(cant*precio,2),
     'Validación de tarea');

  return jsonb_build_object(
    'ok', true, 'acciones_anadidas', cant, 'precio_hoy', precio,
    'multiplicador', m, 'valor_operacion', round(cant*precio,2));
end;
$$;

-- 4.2 PENALIZACIÓN DE MERCADO (multa L–S, impacto directo y fijo al Patrimonio)
create or replace function fn_penalizar_mercado(p_usuario uuid, p_accion uuid, p_pin text)
returns jsonb language plpgsql security definer as $$
declare a acciones%rowtype; precio numeric;
begin
  perform _check_pin(p_pin);
  if not mercado_abierto() then
    raise exception 'El mercado está cerrado; las multas de mercado solo aplican L–S.';
  end if;

  select * into a from acciones where id = p_accion and tipo = 'pasivo' and activa;
  if not found then raise exception 'Penalización inexistente.'; end if;

  precio := a.precio_actual;  -- magnitud positiva = cuánto cotiza HOY la multa

  -- Impacto fijo (no acumulable entre semanas): se resta del Patrimonio vivo.
  insert into historial_transacciones
    (usuario_id, accion_id, tipo, afecta, precio_unitario, valor, nota)
  values
    (p_usuario, p_accion, 'penalizacion_mercado', 'patrimonio', precio, -precio,
     'Multa a precio de hoy');

  return jsonb_build_object('ok', true, 'impacto', -precio, 'precio_hoy', precio);
end;
$$;

-- 4.3 LIQUIDACIÓN DEL DOMINGO (vender N acciones -> Cash Global)
--   p_ventas: jsonb array [{ "accion_id": "...", "cantidad": 2 }, ...]
create or replace function fn_liquidar(p_usuario uuid, p_ventas jsonb, p_pin text)
returns jsonb language plpgsql security definer as $$
declare
  item    jsonb;
  v_acc   uuid; v_cant numeric; v_prec numeric; v_disp numeric;
  total   numeric := 0; monto numeric;
begin
  perform _check_pin(p_pin);
  if not es_domingo() then
    raise exception 'La liquidación solo está disponible los domingos.';
  end if;

  for item in select * from jsonb_array_elements(p_ventas) loop
    v_acc  := (item->>'accion_id')::uuid;
    v_cant := (item->>'cantidad')::numeric;
    if v_cant is null or v_cant <= 0 then continue; end if;

    select cantidad into v_disp from cartera_activos
      where usuario_id = p_usuario and accion_id = v_acc;
    if coalesce(v_disp,0) < v_cant then
      raise exception 'Cantidad a vender (%) supera la cartera (%).', v_cant, coalesce(v_disp,0);
    end if;

    select precio_actual into v_prec from acciones where id = v_acc; -- precio de cierre de la semana
    monto := round(v_cant * v_prec, 2);
    total := total + monto;

    update cartera_activos
      set cantidad = cantidad - v_cant, actualizado = now()
      where usuario_id = p_usuario and accion_id = v_acc;

    insert into historial_transacciones
      (usuario_id, accion_id, tipo, afecta, cantidad, precio_unitario, valor, nota)
    values
      (p_usuario, v_acc, 'venta_liquidacion', 'cash', v_cant, v_prec, monto,
       'Liquidación de domingo');
  end loop;

  update usuarios set cash_global = cash_global + total where id = p_usuario;

  return jsonb_build_object('ok', true, 'cash_ingresado', total);
end;
$$;

-- 4.4 RECOMPENSA DIRECTA (domingo): inyecta Cash limpio (sin volatilidad)
create or replace function fn_recompensa_directa(p_usuario uuid, p_monto numeric, p_nota text, p_pin text)
returns jsonb language plpgsql security definer as $$
begin
  perform _check_pin(p_pin);
  if p_monto is null or p_monto <= 0 then raise exception 'Monto inválido.'; end if;

  update usuarios set cash_global = cash_global + p_monto where id = p_usuario;
  insert into historial_transacciones (usuario_id, tipo, afecta, valor, nota)
  values (p_usuario, 'recompensa_directa', 'cash', p_monto, coalesce(p_nota,'Recompensa directa'));

  return jsonb_build_object('ok', true, 'cash_sumado', p_monto);
end;
$$;

-- 4.5 PENALIZACIÓN DIRECTA (domingo): descuenta directo del Cash Global
create or replace function fn_penalizacion_directa(p_usuario uuid, p_monto numeric, p_nota text, p_pin text)
returns jsonb language plpgsql security definer as $$
begin
  perform _check_pin(p_pin);
  if p_monto is null or p_monto <= 0 then raise exception 'Monto inválido.'; end if;

  update usuarios set cash_global = cash_global - p_monto where id = p_usuario;
  insert into historial_transacciones (usuario_id, tipo, afecta, valor, nota)
  values (p_usuario, 'penalizacion_directa', 'cash', -p_monto, coalesce(p_nota,'Penalización directa'));

  return jsonb_build_object('ok', true, 'cash_restado', p_monto);
end;
$$;

-- 4.6 CRUD DE ACCIONES (crear / editar desde la Vista Padres) ---------------
--   p_id = null  -> crea una acción nueva (precio_actual arranca en precio_base).
--   p_id = uuid  -> edita. NOTA: editar 'precio_base' (valor de salida) NO cambia
--   el precio de hoy al instante; el ancla se aplica en el recálculo de las 00:00.
create or replace function fn_guardar_accion(
  p_pin                 text,
  p_id                  uuid,
  p_nombre              text,
  p_tipo                text,
  p_icono               text,
  p_precio_base         numeric,
  p_volatilidad         numeric,
  p_paga_dividendo      boolean,
  p_dividendo_monto     numeric,
  p_dividendo_frecuencia text
) returns jsonb language plpgsql security definer as $$
declare v_id uuid;
begin
  perform _check_pin(p_pin);
  if p_tipo not in ('activo','pasivo') then raise exception 'Tipo inválido.'; end if;
  if coalesce(p_precio_base,0) <= 0 then raise exception 'El valor de salida debe ser > 0.'; end if;

  if p_id is null then
    insert into acciones
      (nombre, tipo, icono, precio_base, volatilidad,
       paga_dividendo, dividendo_monto, dividendo_frecuencia,
       precio_actual, precio_anterior)
    values
      (p_nombre, p_tipo, p_icono, p_precio_base, coalesce(p_volatilidad,0),
       coalesce(p_paga_dividendo,false), coalesce(p_dividendo_monto,0),
       coalesce(p_dividendo_frecuencia,'ninguna'),
       p_precio_base, p_precio_base)
    returning id into v_id;
  else
    update acciones set
      nombre               = p_nombre,
      tipo                 = p_tipo,
      icono                = p_icono,
      precio_base          = p_precio_base,
      volatilidad          = coalesce(p_volatilidad,0),
      paga_dividendo       = coalesce(p_paga_dividendo,false),
      dividendo_monto      = coalesce(p_dividendo_monto,0),
      dividendo_frecuencia = coalesce(p_dividendo_frecuencia,'ninguna')
    where id = p_id
    returning id into v_id;
    if v_id is null then raise exception 'Acción no encontrada.'; end if;
  end if;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

-- Baja lógica (conserva el historial)
create or replace function fn_eliminar_accion(p_pin text, p_id uuid)
returns jsonb language plpgsql security definer as $$
begin
  perform _check_pin(p_pin);
  update acciones set activa = false where id = p_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- ============================================================================
-- 5. JOBS PROGRAMADOS (los invoca el cron — ver sección de backend)
-- ============================================================================

-- 5.1 RECÁLCULO DIARIO DE PRECIOS (00:00). Congela el mercado los domingos.
create or replace function fn_recalcular_precios()
returns jsonb language plpgsql security definer as $$
declare a acciones%rowtype; nuevo numeric; suelo numeric; ratio numeric; n int := 0;
begin
  if es_domingo() then
    return jsonb_build_object('ok', true, 'congelado', true,
                              'motivo', 'Domingo: mercado congelado');
  end if;

  select suelo_precio_ratio into ratio from config where id = 1;

  for a in select * from acciones where activa loop
    -- oscilación uniforme en [−volatilidad, +volatilidad]
    nuevo := a.precio_base * (1 + (random() * 2 - 1) * a.volatilidad);
    suelo := a.precio_base * ratio;                 -- evita precios ~0
    nuevo := round(greatest(nuevo, suelo), 2);

    update acciones
      set precio_anterior = precio_actual,
          precio_actual   = nuevo
      where id = a.id;

    insert into precios_historico (accion_id, fecha, precio)
    values (a.id, (now() at time zone (select tz from config where id=1))::date, nuevo)
    on conflict (accion_id, fecha) do update set precio = excluded.precio;

    n := n + 1;
  end loop;

  return jsonb_build_object('ok', true, 'recalculadas', n);
end;
$$;

-- 5.2 PAGO DE DIVIDENDOS por frecuencia. Cash por holdear acciones.
--   Se llama una vez por frecuencia desde su propio cron (diaria/semanal/mensual).
create or replace function fn_pagar_dividendos(p_frecuencia text default 'mensual')
returns jsonb language plpgsql security definer as $$
declare r record; total numeric := 0; monto numeric;
begin
  for r in
    select c.usuario_id, c.accion_id, c.cantidad, a.dividendo_monto
    from cartera_activos c
    join acciones a on a.id = c.accion_id
    where a.paga_dividendo and a.dividendo_monto > 0 and c.cantidad > 0
      and a.dividendo_frecuencia = p_frecuencia
  loop
    monto := round(r.cantidad * r.dividendo_monto, 2);
    update usuarios set cash_global = cash_global + monto where id = r.usuario_id;

    insert into historial_transacciones
      (usuario_id, accion_id, tipo, afecta, cantidad, valor, nota)
    values
      (r.usuario_id, r.accion_id, 'dividendo', 'cash', r.cantidad, monto,
       'Dividendo ' || p_frecuencia);

    total := total + monto;
  end loop;

  return jsonb_build_object('ok', true, 'frecuencia', p_frecuencia, 'dividendos_pagados', total);
end;
$$;

-- ============================================================================
-- 6. RLS — abierto para uso doméstico; la seguridad real es el PIN en los RPC
-- ============================================================================
alter table usuarios                enable row level security;
alter table acciones                enable row level security;
alter table cartera_activos         enable row level security;
alter table historial_transacciones enable row level security;
alter table precios_historico       enable row level security;
alter table config                  enable row level security;

create policy lec_usuarios   on usuarios                for select using (true);
create policy lec_acciones   on acciones                for select using (true);
create policy lec_cartera    on cartera_activos         for select using (true);
create policy lec_historial  on historial_transacciones for select using (true);
create policy lec_precios    on precios_historico       for select using (true);
-- config NO se expone a select (contiene el PIN). Se lee vía RPC si hace falta.

-- ============================================================================
-- 6.1 GRANTS explícitos (no dependemos de los privilegios por defecto)
--      · anon/authenticated: solo LECTURA de vistas y tablas no sensibles.
--      · EXECUTE solo en los RPC de la app; los jobs de cron NO se exponen.
-- ============================================================================
grant usage on schema public to anon, authenticated;

grant select on
  vista_pizarra, vista_patrimonio, vista_ranking_semanal,
  vista_ranking_global, vista_cartera_detalle,
  usuarios, acciones, cartera_activos, historial_transacciones, precios_historico
to anon, authenticated;

grant execute on function
  fn_validar_pin(text),
  fn_estado_mercado(),
  fn_validar_tarea(uuid, uuid, text),
  fn_penalizar_mercado(uuid, uuid, text),
  fn_liquidar(uuid, jsonb, text),
  fn_recompensa_directa(uuid, numeric, text, text),
  fn_penalizacion_directa(uuid, numeric, text, text),
  fn_guardar_accion(text, uuid, text, text, text, numeric, numeric, boolean, numeric, text),
  fn_eliminar_accion(text, uuid)
to anon, authenticated;

-- Los jobs de mantenimiento quedan reservados (los ejecuta el cron como owner):
revoke execute on function fn_recalcular_precios()        from anon, authenticated;
revoke execute on function fn_pagar_dividendos(text)      from anon, authenticated;

-- ============================================================================
-- 7. SEED — familia + catálogo de acciones
-- ============================================================================
insert into usuarios (nombre, rol, avatar) values
  ('Papá',      'padre', '👨'),
  ('Mamá',      'padre', '👩'),
  ('Raúl',      'hijo',  '👑'),
  ('Izan',      'hijo',  '👦'),
  ('Martín',    'hijo',  '🤖'),
  ('María',     'hijo',  '🦄'),
  ('Loreto',    'hijo',  '👧'),
  ('Gabriel',   'hijo',  '🚀'),
  ('Magdalena', 'hijo',  '🦋');

-- ACTIVOS (tareas). precio_actual/anterior arrancan en precio_base.
insert into acciones (nombre, tipo, icono, precio_base, volatilidad, paga_dividendo, dividendo_monto, dividendo_frecuencia, precio_actual, precio_anterior) values
  ('Recoger cocina',          'activo', '🍳', 2.0, 0.300, false, 0,   'ninguna', 2.0, 2.0),
  ('Extra: salón',            'activo', '🛋️', 0.5, 0.000, false, 0,   'ninguna', 0.5, 0.5),
  ('Extra: encimera',         'activo', '🧽', 0.5, 0.000, false, 0,   'ninguna', 0.5, 0.5),
  ('Extra: suelo',            'activo', '🧹', 0.5, 0.000, false, 0,   'ninguna', 0.5, 0.5),
  ('Recoger habitación',      'activo', '🛏️', 1.0, 0.150, false, 0,   'ninguna', 1.0, 1.0),
  ('Hacer cama al despertar', 'activo', '☀️', 1.0, 0.100, true,  0.3, 'semanal', 1.0, 1.0),
  ('Comer todo del plato',    'activo', '🍽️', 0.5, 0.000, false, 0,   'ninguna', 0.5, 0.5),
  ('Rezar por la noche',      'activo', '🙏', 1.0, 0.000, true,  0.5, 'mensual', 1.0, 1.0);

-- PASIVOS (multas). precio_base = magnitud que se resta del Patrimonio.
insert into acciones (nombre, tipo, icono, precio_base, volatilidad, precio_actual, precio_anterior) values
  ('Pelearse/discutir',          'pasivo', '🥊', 3.0, 0.200, 3.0, 3.0),
  ('Insulto/palabrota',          'pasivo', '🤬', 4.0, 0.250, 4.0, 4.0),
  ('Desorden intencionado',      'pasivo', '🌪️', 2.0, 0.200, 2.0, 2.0),
  ('Mal comportamiento en mesa', 'pasivo', '🍝', 3.0, 0.200, 3.0, 3.0);

commit;

-- ======================================================================
-- 8. PROGRAMACIÓN (ejecutar tras instalar la extensión pg_cron)
-- ----------------------------------------------------------------------
-- create extension if not exists pg_cron;
-- -- Recálculo de precios cada día a las 00:00 Europe/Madrid (= 22:00/23:00 UTC
-- --   según horario de verano; ajusta o usa una Edge Function con TZ, ver doc).
select cron.schedule('recalculo-precios', '0 0 * * *', $$ select fn_recalcular_precios(); $$);

-- -- Dividendos por frecuencia:
select cron.schedule('div-diario',  '5 0 * * *', $$ select fn_pagar_dividendos('diaria');  $$); -- cada día 00:05
select cron.schedule('div-semanal', '5 0 * * 1', $$ select fn_pagar_dividendos('semanal'); $$); -- lunes 00:05
select cron.schedule('div-mensual', '5 0 1 * *', $$ select fn_pagar_dividendos('mensual'); $$); -- día 1 00:05
-- ======================================================================
