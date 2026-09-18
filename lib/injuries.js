/* =========================================================
   lib/injuries.js
   Recupera infortuni e squalifiche dalla API-Football (free).
   100 richieste/giorno gratuite — sufficienti per 1-2 sync/giorno.

   Endpoint usato:
     GET https://v3.football.api-sports.io/injuries?league=135&season=2026
   league=135 è la Serie A nella codifica API-Football.
========================================================= */

const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";
const SERIE_A_LEAGUE_ID = 135;
const TIMEOUT_MS = 10000;

/* =========================================================
   FETCH
========================================================= */

async function fetchApiFootball(path, apiKey, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${API_FOOTBALL_BASE}${path}`, {
      method: "GET",
      headers: {
        "x-apisports-key": apiKey,
        Accept: "application/json"
      },
      signal: controller.signal
    });

    const text = await response.text();

    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 300) };
    }

    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   STAGIONE (per API-Football)
========================================================= */

function apiFootballSeason() {
  // API-Football identifica la stagione con l'anno di inizio.
  const now = new Date();
  return now.getUTCMonth() >= 5
    ? now.getUTCFullYear()
    : now.getUTCFullYear() - 1;
}

/* =========================================================
   PARSING
========================================================= */

/**
 * Normalizza la risposta injuries di API-Football.
 * Ritorna un array di oggetti { player, team, type, reason, fixtureId, date }
 */
function parseInjuries(data) {
  const rows = Array.isArray(data?.response) ? data.response : [];
  const out = [];

  for (const row of rows) {
    const player = row?.player?.name ?? null;
    const team = row?.team?.name ?? null;
    const type = row?.type ?? null; // "Missing Fixture" | "Questionable"
    const reason = row?.reason ?? null;
    const fixtureId = row?.fixture?.id ?? null;
    const date = row?.fixture?.date ?? null;

    if (!player || !team) continue;

    out.push({
      player,
      team,
      type,
      reason,
      fixtureId,
      date
    });
  }

  return out;
}

/**
 * Aggrega gli infortuni per squadra (chiave normalizzata).
 * Ritorna: { chiave_squadra: [ { player, type, reason, date }, ... ] }
 */
function groupByTeam(injuries, normalizeTeamName) {
  const grouped = {};

  for (const inj of injuries) {
    const key = normalizeTeamName(inj.team);
    if (!key) continue;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push({
      player: inj.player,
      type: inj.type,
      reason: inj.reason,
      date: inj.date
    });
  }

  return grouped;
}

/* =========================================================
   ENTRY POINT
========================================================= */

/**
 * Scarica infortuni/squalifiche Serie A dalla API-Football.
 * Fallisce silenziosamente se la chiave manca o l'API non risponde.
 */
export async function fetchInjuries(normalizeTeamName) {
  const apiKey = process.env.API_FOOTBALL_KEY;

  if (!apiKey) {
    return {
      available: false,
      reason: "API_FOOTBALL_KEY non configurata",
      injuries: [],
      grouped: {}
    };
  }

  const season = apiFootballSeason();
  const path = `/injuries?league=${SERIE_A_LEAGUE_ID}&season=${season}`;

  try {
    const { ok, status, data } = await fetchApiFootball(path, apiKey);

    if (!ok) {
      return {
        available: false,
        reason: `HTTP ${status}`,
        season,
        injuries: [],
        grouped: {}
      };
    }

    // API-Football ritorna { errors: [...] } anche con 200 in caso di problemi
    const errors = data?.errors;
    if (errors && !Array.isArray(errors) && Object.keys(errors).length > 0) {
      return {
        available: false,
        reason: `API errors: ${JSON.stringify(errors).slice(0, 200)}`,
        season,
        injuries: [],
        grouped: {}
      };
    }

    const injuries = parseInjuries(data);
    const grouped = groupByTeam(injuries, normalizeTeamName);

    return {
      available: true,
      season,
      count: injuries.length,
      teams: Object.keys(grouped).length,
      injuries,
      grouped
    };
  } catch (error) {
    return {
      available: false,
      reason:
        error?.name === "AbortError"
          ? "TIMEOUT"
          : String(error?.message || error),
      season,
      injuries: [],
      grouped: {}
    };
  }
}
