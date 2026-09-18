/* =========================================================
   lib/understat.js
   Estrae xG/xGA per squadra dalla pagina campionato di Understat.
   Understat embedda i dati come:
     var datesData = JSON.parse('...json con escape unicode...');
   Il parsing corretto gestisce \u0022 (apici doppi) — la V6 usava \' e \"
   che sbagliava.
========================================================= */

const UNDERSTAT_TIMEOUT = 12000;

/* =========================================================
   STAGIONE
========================================================= */

export function understatSeasonYear() {
  // Understat identifica la stagione con l'anno di inizio.
  // A settembre 2026 → stagione "2026" (2026/27).
  // Prima di giugno → stagione precedente.
  const now = new Date();
  return now.getUTCMonth() >= 5 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

/* =========================================================
   PARSING JSON EMBEDDATO
========================================================= */

/**
 * Estrae una variabile JSON.parse(...) da una pagina HTML.
 * Understat usa \u0022 per gli apici doppi dentro la stringa JSON.
 */
export function parseUnderstatJsonVar(html, varName) {
  // Match: var NOME = JSON.parse('...');
  // Il contenuto può contenere \' (apici singoli escapati) quindi usiamo [^']+? non greedy
  const re = new RegExp(
    `var\\s+${varName}\\s*=\\s*JSON\\.parse\\('([^']+)'\\)`,
    "s"
  );
  const m = html.match(re);
  if (!m) return null;

  try {
    // 1. \u0022 → " (apici doppi)
    // 2. \\' → ' (apici singoli letterali nel JSON)
    // 3. \\\\ → \\ (backslash letterali)
    const cleaned = m[1]
      .replace(/\\u0022/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, "\\");

    return JSON.parse(cleaned);
  } catch (e) {
    console.error(`parseUnderstatJsonVar(${varName}) failed:`, e.message);
    return null;
  }
}

/* =========================================================
   FETCH HTML (separato da fetchJson: Understat NON è JSON)
========================================================= */

async function fetchHtml(url, timeoutMs = UNDERSTAT_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent":
          "Mozilla/5.0 (compatible; SerieAPredictor/7.0; +https://serie-a-predictor-v7.vercel.app)"
      },
      signal: controller.signal
    });

    const html = await response.text();
    return { ok: response.ok, status: response.status, html };
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   AGGREGAZIONE STATISTICHE PER SQUADRA
========================================================= */

/**
 * Da datesData (oggetto { matchId: { h: { title }, a: { title }, goals, xG, datetime, ... } })
 * costruisce statistiche aggregate per squadra.
 *
 * Ritorna: { chiave_normalizzata: { team, played, xgForPerGame, xgAgainstPerGame, ... } }
 */
export function buildUnderstatStats(datesData, normalizeTeamName) {
  const stats = {};

  function ensure(teamRaw) {
    const key = normalizeTeamName(teamRaw);
    if (!key) return null;
    if (!stats[key]) {
      stats[key] = {
        team: String(teamRaw).trim(),
        played: 0,
        matchesWithXg: 0,
        xgFor: 0,
        xgAgainst: 0,
        scored: 0,
        conceded: 0,
        homePlayed: 0,
        homeXgFor: 0,
        homeXgAgainst: 0,
        awayPlayed: 0,
        awayXgFor: 0,
        awayXgAgainst: 0
      };
    }
    return stats[key];
  }

  const matches = Object.values(datesData || {});

  for (const m of matches) {
    const homeName = m?.h?.title ?? null;
    const awayName = m?.a?.title ?? null;
    const homeGoals = Number(m?.goals?.h);
    const awayGoals = Number(m?.goals?.a);
    const homeXG = Number(m?.xG?.h);
    const awayXG = Number(m?.xG?.a);

    if (!homeName || !awayName) continue;
    if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) continue;

    const home = ensure(homeName);
    const away = ensure(awayName);
    if (!home || !away) continue;

    home.played += 1;
    away.played += 1;
    home.scored += homeGoals;
    home.conceded += awayGoals;
    away.scored += awayGoals;
    away.conceded += homeGoals;
    home.homePlayed += 1;
    away.awayPlayed += 1;

    const hasXG = Number.isFinite(homeXG) && Number.isFinite(awayXG);

    if (hasXG) {
      home.matchesWithXg += 1;
      away.matchesWithXg += 1;
      home.xgFor += homeXG;
      home.xgAgainst += awayXG;
      away.xgFor += awayXG;
      away.xgAgainst += homeXG;
      home.homeXgFor += homeXG;
      home.homeXgAgainst += awayXG;
      away.awayXgFor += awayXG;
      away.awayXgAgainst += homeXG;
    }
  }

  // Calcola le medie per partita (chiavi consumate da predict.js)
  const result = {};

  for (const [key, t] of Object.entries(stats)) {
    if (t.played === 0) continue;

    result[key] = {
      team: t.team,
      played: t.played,
      matchesWithXg: t.matchesWithXg,

      // medie xG per partita (solo partite con xG disponibile)
      xgForPerGame:
        t.matchesWithXg > 0
          ? Number((t.xgFor / t.matchesWithXg).toFixed(3))
          : null,
      xgAgainstPerGame:
        t.matchesWithXg > 0
          ? Number((t.xgAgainst / t.matchesWithXg).toFixed(3))
          : null,

      // medie gol reali (fallback)
      scoredPerGame: Number((t.scored / t.played).toFixed(3)),
      concededPerGame: Number((t.conceded / t.played).toFixed(3)),

      // split casa/trasferta
      homeXgForPerGame:
        t.homePlayed > 0
          ? Number((t.homeXgFor / t.homePlayed).toFixed(3))
          : null,
      homeXgAgainstPerGame:
        t.homePlayed > 0
          ? Number((t.homeXgAgainst / t.homePlayed).toFixed(3))
          : null,
      awayXgForPerGame:
        t.awayPlayed > 0
          ? Number((t.awayXgFor / t.awayPlayed).toFixed(3))
          : null,
      awayXgAgainstPerGame:
        t.awayPlayed > 0
          ? Number((t.awayXgAgainst / t.awayPlayed).toFixed(3))
          : null
    };
  }

  return result;
}

/* =========================================================
   FETCH + PARSE COMPLETO
========================================================= */

/**
 * Scarica la pagina Understat della Serie A e restituisce
 * statistiche xG aggregate per squadra.
 */
export async function fetchUnderstatStats(normalizeTeamName) {
  const year = understatSeasonYear();
  const url = `https://understat.com/league/Serie_A/${year}`;

  try {
    const { ok, status, html } = await fetchHtml(url);

    if (!ok) {
      return { available: false, reason: `HTTP ${status}`, year, stats: {} };
    }

    if (!html || html.length < 1000) {
      return {
        available: false,
        reason: "HTML vuoto o troppo corto",
        year,
        stats: {}
      };
    }

    const datesData = parseUnderstatJsonVar(html, "datesData");

    if (!datesData) {
      return {
        available: false,
        reason: "datesData non trovato (Understat potrebbe aver cambiato layout)",
        year,
        stats: {}
      };
    }

    const stats = buildUnderstatStats(datesData, normalizeTeamName);

    return {
      available: Object.keys(stats).length > 0,
      year,
      teams: Object.keys(stats).length,
      stats
    };
  } catch (error) {
    return {
      available: false,
      reason:
        error?.name === "AbortError"
          ? "TIMEOUT"
          : String(error?.message || error),
      year,
      stats: {}
    };
  }
}
