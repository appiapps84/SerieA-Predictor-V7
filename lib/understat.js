/* lib/understat.js — V7.2 (solo AJAX, niente fallback HTML) */

const TIMEOUT = 6000;

function seasonYear() {
  const now = new Date();
  return now.getUTCMonth() >= 5 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

export function buildUnderstatStats(datesData, normalizeTeamName) {
  const stats = {};

  function ensure(teamRaw) {
    const key = normalizeTeamName(teamRaw);
    if (!key) return null;
    if (!stats[key]) {
      stats[key] = {
        team: String(teamRaw).trim(), played: 0, matchesWithXg: 0,
        xgFor: 0, xgAgainst: 0, scored: 0, conceded: 0,
        homePlayed: 0, awayPlayed: 0
      };
    }
    return stats[key];
  }

  for (const m of Object.values(datesData || {})) {
    const homeName = m?.h?.title;
    const awayName = m?.a?.title;
    const homeGoals = Number(m?.goals?.h);
    const awayGoals = Number(m?.goals?.a);
    const homeXG = Number(m?.xG?.h);
    const awayXG = Number(m?.xG?.a);

    if (!homeName || !awayName) continue;
    if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) continue;

    const home = ensure(homeName);
    const away = ensure(awayName);
    if (!home || !away) continue;

    home.played += 1; away.played += 1;
    home.scored += homeGoals; home.conceded += awayGoals;
    away.scored += awayGoals; away.conceded += homeGoals;
    home.homePlayed += 1; away.awayPlayed += 1;

    if (Number.isFinite(homeXG) && Number.isFinite(awayXG)) {
      home.matchesWithXg += 1; away.matchesWithXg += 1;
      home.xgFor += homeXG; home.xgAgainst += awayXG;
      away.xgFor += awayXG; away.xgAgainst += homeXG;
    }
  }

  const result = {};
  for (const [key, t] of Object.entries(stats)) {
    if (t.played === 0) continue;
    result[key] = {
      team: t.team, played: t.played, matchesWithXg: t.matchesWithXg,
      xgForPerGame: t.matchesWithXg > 0 ? Number((t.xgFor / t.matchesWithXg).toFixed(3)) : null,
      xgAgainstPerGame: t.matchesWithXg > 0 ? Number((t.xgAgainst / t.matchesWithXg).toFixed(3)) : null,
      scoredPerGame: Number((t.scored / t.played).toFixed(3)),
      concededPerGame: Number((t.conceded / t.played).toFixed(3))
    };
  }
  return result;
}

export async function fetchUnderstatStats(normalizeTeamName) {
  const year = seasonYear();
  const url = `https://understat.com/getLeagueData/Serie_A/${year}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    // 1. Prima visita la pagina per cookie
    await fetch(`https://understat.com/league/Serie_A/${year}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0",
        Accept: "text/html"
      },
      signal: controller.signal
    });

    // 2. Poi chiama l'endpoint AJAX
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0",
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json, text/javascript, */*; q=0.01",
        Referer: `https://understat.com/league/Serie_A/${year}`
      },
      signal: controller.signal
    });

    if (!response.ok) {
      return { available: false, year, reason: `AJAX HTTP ${response.status}`, stats: {} };
    }

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { available: false, year, reason: `JSON parse: ${e.message}`, stats: {} };
    }

    // La risposta può avere { dates: [...] } o { datesData: {...} }
    const datesData = data.datesData || data.dates || data;
    const stats = buildUnderstatStats(datesData, normalizeTeamName);

    return {
      available: Object.keys(stats).length > 0,
      year,
      teams: Object.keys(stats).length,
      stats,
      reason: Object.keys(stats).length > 0 ? null : "stats vuote"
    };
  } catch (error) {
    return {
      available: false, year,
      reason: error?.name === "AbortError" ? "TIMEOUT" : String(error?.message || error),
      stats: {}
    };
  } finally {
    clearTimeout(timer);
  }
}
