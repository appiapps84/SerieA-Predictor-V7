/* =========================================================
   api/sync.js
   Orchestratore: chiama BBS + Understat + API-Football in parallelo,
   salva i risultati su Supabase, restituisce tutto al frontend.

   Endpoint: GET /api/sync
   Cache: 5 minuti (s-maxage=300)
   Cron: 05:00 UTC ogni giorno
========================================================= */

import { normalizeTeamName, h2hKey } from "../lib/teams.js";
import { getSupabase } from "../lib/supabase.js";
import { fetchUnderstatStats } from "../lib/understat.js";
import { fetchInjuries } from "../lib/injuries.js";

/* =========================================================
   COSTANTI
========================================================= */

const BBS_BASE = "https://api.bigballsdata.com";
const BBS_LEAGUE = "Serie%20A";          // BBS vuole "Serie A" con spazio URL-encoded
const BBS_SPORT = "football";
const BBS_LIMIT_STORED = 200;             // massimo consentito da BBS

const FETCH_TIMEOUT_MS = 10000;

/* =========================================================
   FETCH HELPERS
========================================================= */

function authHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "X-Api-Key": apiKey,
    Accept: "application/json"
  };
}

async function fetchJson(url, apiKey, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: apiKey ? authHeaders(apiKey) : { Accept: "application/json" },
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
   ESTRAZIONE DATI BBS (robusta a variazioni di formato)
========================================================= */

function extractMatches(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.matches)) return data.matches;
  if (Array.isArray(data?.fixtures)) return data.fixtures;
  return [];
}

function extractStandings(data) {
  // BBS potrebbe restituire: data.data.standings[0].rows
  const blocks = data?.data?.standings;
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (Array.isArray(block?.rows) && block.rows.length > 0) {
        return block.rows;
      }
    }
  }
  // fallback: data.standings (array diretto)
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.standings)) return data.standings;
  return [];
}

function getTeamName(match, side) {
  if (!match) return "";
  const obj =
    side === "home"
      ? match.home ?? match.homeTeam ?? match.home_team ?? match.teams?.home
      : match.away ?? match.awayTeam ?? match.away_team ?? match.teams?.away;

  if (typeof obj === "object" && obj !== null) {
    return String(obj.name ?? obj.title ?? "").trim();
  }
  return String(obj ?? "").trim();
}

function getTeamId(match, side) {
  if (!match) return null;
  const obj =
    side === "home"
      ? match.home ?? match.homeTeam ?? match.home_team ?? match.teams?.home
      : match.away ?? match.awayTeam ?? match.away_team ?? match.teams?.away;
  if (typeof obj === "object" && obj !== null) {
    return obj.id ?? null;
  }
  return null;
}

function getMatchDate(match) {
  return (
    match?.kickoff_utc ??
    match?.kickoffUtc ??
    match?.kickoff ??
    match?.date ??
    match?.start_time ??
    null
  );
}

function getScore(match) {
  const score = match?.score ?? match?.scores ?? null;
  if (!score) return null;

  const home = Number(
    score.home ?? score.home_score ?? score.homeScore ?? score.full_time?.home
  );
  const away = Number(
    score.away ?? score.away_score ?? score.awayScore ?? score.full_time?.away
  );

  if (!Number.isFinite(home) || !Number.isFinite(away)) return null;
  return { home, away };
}

function getMatchId(match) {
  return match?.id ?? match?.match_id ?? match?.fixture_id ?? null;
}

function isFinished(match) {
  const status = String(match?.status || "").toLowerCase();
  if (["finished", "final", "ft", "completed"].includes(status)) return true;
  return Boolean(getScore(match));
}

/* =========================================================
   FORMA + H2H dallo storico BBS
========================================================= */

function buildFormAndH2H(storedMatches) {
  const history = {};
  const h2h = {};

  function ensure(team) {
    const key = normalizeTeamName(team);
    if (!key) return null;
    if (!history[key]) {
      history[key] = { team: String(team).trim(), matches: [] };
    }
    return history[key];
  }

  for (const match of storedMatches) {
    if (!isFinished(match)) continue;

    const homeName = getTeamName(match, "home");
    const awayName = getTeamName(match, "away");
    const score = getScore(match);

    if (!homeName || !awayName || !score) continue;

    const home = ensure(homeName);
    const away = ensure(awayName);
    if (!home || !away) continue;

    const date = getMatchDate(match);
    const matchId = getMatchId(match);

    home.matches.push({
      matchId,
      date,
      homeTeam: homeName,
      awayTeam: awayName,
      homeGoals: score.home,
      awayGoals: score.away,
      venue: "home"
    });

    away.matches.push({
      matchId,
      date,
      homeTeam: homeName,
      awayTeam: awayName,
      homeGoals: score.home,
      awayGoals: score.away,
      venue: "away"
    });

    const key = h2hKey(homeName, awayName);
    if (!h2h[key]) h2h[key] = [];
    h2h[key].push({
      matchId,
      date,
      homeTeam: homeName,
      awayTeam: awayName,
      homeGoals: score.home,
      awayGoals: score.away
    });
  }

  // FORMA: ultime 10, sintesi ultime 5
  const form = {};

  for (const [key, team] of Object.entries(history)) {
    team.matches.sort(
      (a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime()
    );

    const last10 = team.matches.slice(0, 10);
    const last5 = last10.slice(0, 5);

    const summarize = (list) => {
      let pts = 0,
        gf = 0,
        ga = 0;
      const results = [];

      for (const m of list) {
        let r;
        if (m.venue === "home") {
          r = m.homeGoals > m.awayGoals ? "W" : m.homeGoals < m.awayGoals ? "L" : "D";
          gf += m.homeGoals;
          ga += m.awayGoals;
        } else {
          r = m.awayGoals > m.homeGoals ? "W" : m.awayGoals < m.homeGoals ? "L" : "D";
          gf += m.awayGoals;
          ga += m.homeGoals;
        }
        results.push(r);
        pts += r === "W" ? 3 : r === "D" ? 1 : 0;
      }

      return {
        results,
        points: pts,
        goalsFor: gf,
        goalsAgainst: ga,
        averageGoalsFor: list.length ? Number((gf / list.length).toFixed(3)) : 0,
        averageGoalsAgainst: list.length ? Number((ga / list.length).toFixed(3)) : 0
      };
    };

    const s10 = summarize(last10);
    const s5 = summarize(last5);

    form[key] = {
      team: team.team,
      last5: s5.results,
      last10: s10.results,
      pointsLast5: s5.points,
      pointsLast10: s10.points,
      averageGoalsFor: s5.averageGoalsFor,
      averageGoalsAgainst: s5.averageGoalsAgainst,
      averageGoalsForLast10: s10.averageGoalsFor,
      averageGoalsAgainstLast10: s10.averageGoalsAgainst
    };
  }

  // H2H: max 5 incontri per coppia
  for (const key of Object.keys(h2h)) {
    h2h[key].sort(
      (a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime()
    );
    h2h[key] = h2h[key].slice(0, 5);
  }

  return { form, h2h };
}

/* =========================================================
   SALVATAGGIO RISULTATI SU SUPABASE (non bloccante)
========================================================= */

async function saveResultsToSupabase(storedMatches) {
  const supabase = getSupabase();
  if (!supabase) return { saved: 0, skipped: "no_supabase" };

  const rows = [];

  for (const match of storedMatches) {
    if (!isFinished(match)) continue;

    const matchId = getMatchId(match);
    const homeName = getTeamName(match, "home");
    const awayName = getTeamName(match, "away");
    const score = getScore(match);

    if (!matchId || !homeName || !awayName || !score) continue;

    const kickoff = getMatchDate(match);

    rows.push({
      match_id: String(matchId),
      home_team: homeName,
      away_team: awayName,
      home_team_id: getTeamId(match, "home"),
      away_team_id: getTeamId(match, "away"),
      result_1x2: score.home > score.away ? "1" : score.away > score.home ? "2" : "X",
      goals_home: score.home,
      goals_away: score.away,
      kickoff_utc: kickoff ?? new Date().toISOString(),
      round: match?.round ?? null
    });
  }

  if (rows.length === 0) return { saved: 0, skipped: "no_rows" };

  let saved = 0;

  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const { error } = await supabase
      .from("results")
      .upsert(chunk, { onConflict: "match_id" });

    if (error) return { saved, error: error.message };
    saved += chunk.length;
  }

  return { saved };
}

/* =========================================================
   HANDLER
========================================================= */

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  const apiKey = process.env.BBS_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      error: "MISSING_BBS_API_KEY",
      message: "BBS_API_KEY non configurata su Vercel."
    });
  }

  const startedAt = Date.now();

  /* =========================================================
     1. TUTTE LE FONTI IN PARALLELO
  ========================================================= */

  const matchesUrl = `${BBS_BASE}/v1/matches?sport=${BBS_SPORT}&league=${BBS_LEAGUE}`;
  const standingsUrl = `${BBS_BASE}/v1/standings?sport=${BBS_SPORT}&league=${BBS_LEAGUE}`;
  const storedUrl =
    `${BBS_BASE}/v1/stored/matches?sport=${BBS_SPORT}&league=${BBS_LEAGUE}` +
    `&status=finished&limit=${BBS_LIMIT_STORED}&sort=desc`;

  const [matchesRes, standingsRes, storedRes, understat, injuries] =
    await Promise.allSettled([
      fetchJson(matchesUrl, apiKey),
      fetchJson(standingsUrl, apiKey),
      fetchJson(storedUrl, apiKey),
      fetchUnderstatStats(normalizeTeamName),
      fetchInjuries(normalizeTeamName)
    ]);

  /* =========================================================
     2. PARTITE CORRENTI (bloccante: se fallisce, tutto fallisce)
  ========================================================= */

  if (matchesRes.status === "rejected" || !matchesRes.value?.ok) {
    const r = matchesRes.status === "rejected" ? null : matchesRes.value;
    return res.status(502).json({
      ok: false,
      error: r ? `BBS_${r.status}` : "BBS_NETWORK_ERROR",
      message: "Big Balls non risponde.",
      details: r?.data ?? String(matchesRes.reason)
    });
  }

  const matches = extractMatches(matchesRes.value.data);

  /* =========================================================
     3. CLASSIFICA E STORICO (opzionali)
  ========================================================= */

  const standings =
    standingsRes.status === "fulfilled" && standingsRes.value.ok
      ? extractStandings(standingsRes.value.data)
      : [];

  const storedMatches =
    storedRes.status === "fulfilled" && storedRes.value.ok
      ? extractMatches(storedRes.value.data)
      : [];

  /* =========================================================
     4. FORMA + H2H
  ========================================================= */

  const { form, h2h } = buildFormAndH2H(storedMatches);

  /* =========================================================
     5. UNDERSTAT (xG)
  ========================================================= */

  const under =
    understat.status === "fulfilled"
      ? understat.value
      : { available: false, stats: {}, reason: "promise rejected" };

  // teamXG: { chiave: xgForPerGame } per compatibilità frontend
  const teamXG = {};
  for (const [key, s] of Object.entries(under.stats || {})) {
    if (s.xgForPerGame !== null) teamXG[key] = s.xgForPerGame;
  }

  /* =========================================================
     6. INJURIES
  ========================================================= */

  const inj =
    injuries.status === "fulfilled"
      ? injuries.value
      : { available: false, injuries: [], grouped: {}, reason: "promise rejected" };

  /* =========================================================
     7. SALVATAGGIO RISULTATI (non bloccante)
  ========================================================= */

  let savedResults = { skipped: true };

  if (storedMatches.length > 0) {
    try {
      savedResults = await Promise.race([
        saveResultsToSupabase(storedMatches),
        new Promise((resolve) =>
          setTimeout(() => resolve({ saved: 0, skipped: "timeout" }), 6000)
        )
      ]);
    } catch (error) {
      savedResults = { saved: 0, error: String(error?.message || error) };
    }
  }

  /* =========================================================
     8. LOG SYNC (best-effort)
  ========================================================= */

  const elapsedMs = Date.now() - startedAt;

  try {
    const supabase = getSupabase();
    if (supabase) {
      await supabase.from("sync_log").insert({
        matches_count: matches.length,
        stored_count: storedMatches.length,
        saved_results: savedResults.saved ?? 0,
        understat_ok: Boolean(under.available),
        injuries_count: inj.count ?? 0,
        elapsed_ms: elapsedMs
      });
    }
  } catch {
    // ignore
  }

  /* =========================================================
     9. RISPOSTA
  ========================================================= */

  return res.status(200).json({
    ok: true,
    source: "Big Balls Sports Data + Understat + API-Football",
    league: "Serie A",
    generatedAt: new Date().toISOString(),

    coverage: {
      matches: matches.length,
      storedFinishedMatches: storedMatches.length,
      standings: standings.length,
      teamsWithForm: Object.keys(form).length,
      h2hPairs: Object.keys(h2h).length,
      understatTeams: Object.keys(under.stats || {}).length,
      understatAvailable: Boolean(under.available),
      injuriesCount: inj.count ?? 0,
      injuriesTeams: Object.keys(inj.grouped || {}).length
    },

    matches,
    storedMatches,
    standings,
    teamXG,
    understat: under.stats || {},
    form,
    h2h,
    injuries: inj.injuries || [],
    injuriesByTeam: inj.grouped || {},

    diagnostics: {
      matches: {
        status: matchesRes.value?.status ?? "FAILED",
        count: matches.length
      },
      standings: {
        status:
          standingsRes.status === "fulfilled"
            ? standingsRes.value?.status
            : "FAILED",
        available: standings.length > 0
      },
      stored: {
        status:
          storedRes.status === "fulfilled" ? storedRes.value?.status : "FAILED",
        count: storedMatches.length
      },
      understat: {
        available: Boolean(under.available),
        year: under.year ?? null,
        teams: under.teams ?? 0,
        note: under.available ? null : under.reason || "non disponibile"
      },
      injuries: {
        available: Boolean(inj.available),
        season: inj.season ?? null,
        count: inj.count ?? 0,
        note: inj.available ? null : inj.reason || "non disponibile"
      },
      supabase: savedResults,
      elapsedMs
    }
  });
}
