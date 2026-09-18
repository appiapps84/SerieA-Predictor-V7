-- ============================================================
-- SCHEMA V7 — Serie A Predictor
-- Esegui tutto in una volta nell'SQL Editor di Supabase
-- ============================================================

-- ---------- Risultati partite (popolato da /api/sync) ----------
create table if not exists results (
  match_id text primary key,
  home_team text not null,
  away_team text not null,
  home_team_id text,
  away_team_id text,
  result_1x2 text not null check (result_1x2 in ('1','X','2')),
  goals_home int not null,
  goals_away int not null,
  kickoff_utc timestamptz not null,
  round text,
  created_at timestamptz default now()
);

create index if not exists idx_results_kickoff on results (kickoff_utc desc);

-- ---------- Previsioni (popolate da /api/predict) ----------
create table if not exists predictions (
  id bigint generated always as identity primary key,
  match_id text not null,
  home_team text not null,
  away_team text not null,
  predicted_at timestamptz default now(),
  xg_home numeric,
  xg_away numeric,
  prediction_1x2 text check (prediction_1x2 in ('1','X','2')),
  probabilities jsonb,
  confidence numeric,
  model text,
  model_params jsonb
);

create index if not exists idx_predictions_match on predictions (match_id);
create index if not exists idx_predictions_date on predictions (predicted_at desc);

-- ---------- Configurazione modello (popolata da /api/optimize) ----------
create table if not exists model_config (
  id bigint generated always as identity primary key,
  updated_at timestamptz default now(),
  decay_half_life_days numeric,
  dixon_coles_rho numeric,
  weight_understat numeric,
  weight_standings numeric,
  weight_form numeric,
  weight_base numeric,
  brier_score numeric,
  rps numeric,
  sample_size int
);

-- ---------- Log delle sync (debug) ----------
create table if not exists sync_log (
  id bigint generated always as identity primary key,
  run_at timestamptz default now(),
  matches_count int,
  stored_count int,
  saved_results int,
  understat_ok boolean,
  injuries_count int,
  elapsed_ms int,
  error text
);

-- ============================================================
-- ROW LEVEL SECURITY — esplicita, altrimenti anon non scrive
-- ============================================================

alter table results enable row level security;
alter table predictions enable row level security;
alter table model_config enable row level security;
alter table sync_log enable row level security;

-- results: anon può leggere, inserire, aggiornare (per upsert)
drop policy if exists "anon read results" on results;
create policy "anon read results" on results
  for select to anon using (true);

drop policy if exists "anon write results" on results;
create policy "anon write results" on results
  for insert to anon with check (true);

drop policy if exists "anon update results" on results;
create policy "anon update results" on results
  for update to anon using (true) with check (true);

-- predictions: anon può leggere e inserire
drop policy if exists "anon read predictions" on predictions;
create policy "anon read predictions" on predictions
  for select to anon using (true);

drop policy if exists "anon write predictions" on predictions;
create policy "anon write predictions" on predictions
  for insert to anon with check (true);

-- model_config: anon legge, insert/update (per /api/optimize)
drop policy if exists "anon read model_config" on model_config;
create policy "anon read model_config" on model_config
  for select to anon using (true);

drop policy if exists "anon write model_config" on model_config;
create policy "anon write model_config" on model_config
  for insert to anon with check (true);

drop policy if exists "anon update model_config" on model_config;
create policy "anon update model_config" on model_config
  for update to anon using (true) with check (true);

-- sync_log: anon legge e inserisce
drop policy if exists "anon read sync_log" on sync_log;
create policy "anon read sync_log" on sync_log
  for select to anon using (true);

drop policy if exists "anon write sync_log" on sync_log;
create policy "anon write sync_log" on sync_log
  for insert to anon with check (true);

-- ============================================================
-- Valori di default per model_config (una riga sola)
-- ============================================================
insert into model_config (
  decay_half_life_days,
  dixon_coles_rho,
  weight_understat,
  weight_standings,
  weight_form,
  weight_base,
  sample_size
)
select 90, -0.08, 0.35, 0.25, 0.20, 0.20, 0
where not exists (select 1 from model_config);
