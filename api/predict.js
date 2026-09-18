/* =========================================================
   api/predict.js — V7
   Modello: Poisson + Dixon-Coles multi-fattore.
   Fattori: Understat xG (0.40) + Classifica (0.20) + Forma (0.20) + Base (0.20).
   Parametri (decay, rho, pesi) letti da Supabase (model_config).
========================================================= */

import { normalizeTeamName, h2hKey } from "../lib/teams.js";
import { getSupabase } from "../lib/supabase.js";

/* =========================================================
   COSTANTI
========================================================= */

const MAX_GOALS = 10;

// Medie di lega Serie A (fallback)
const LEAGUE_HOME_XG = 1.45;
const LEAGUE_AWAY_XG = 1.15;
const LEAGUE_AVG_XG = 1.30;

// Pesi di default (se model_config non risponde)
const DEFAULT_WEIGHTS = {
  understat: 0.40,
  standings: 0.20,function lambdaFromUnderstat(homeU, awayU) {
  if (!homeU || !awayU) return null;
  if (homeU.xgForPerGame == null || awayU.xgForPerGame == null) return null;

  // Regressione verso la media lega (Bayesian shrinkage)
  const K = 5;
  const shrink = (observed, played) => {
    const games = Math.max(1, played || 1);
    const w = games / (games + K);
    return w * observed + (1 - w) * LEAGUE_AVG_XG;
  };

  const homePlayed = homeU.matchesWithXg ?? homeU.played ?? 1;
  const awayPlayed = awayU.matchesWithXg ?? awayU.played ?? 1;

  const homeXgFor = shrink(homeU.xgForPerGame, homePlayed);
  const homeXgAgainst = shrink(homeU.xgAgainstPerGame ?? LEAGUE_AVG_XG, homePlayed);
  const awayXgFor = shrink(awayU.xgForPerGame, awayPlayed);
  const awayXgAgainst = shrink(awayU.xgAgainstPerGame ?? LEAGUE_AVG_XG, awayPlayed);

  const homeAttack = homeXgFor / LEAGUE_AVG_XG;
  const awayDefense = awayXgAgainst / LEAGUE_AVG_XG;
  const awayAttack = awayXgFor / LEAGUE_AVG_XG;
  const homeDefense = homeXgAgainst / LEAGUE_AVG_XG;

  return {
    home: LEAGUE_HOME_XG * homeAttack * awayDefense,
    away: LEAGUE_AWAY_XG * awayAttack * homeDefense
  };
}
  form: 0.20,
  base: 0.20
};

const DEFAULT_DECAY_HALF_LIFE_DAYS = 90;
const DEFAULT_DIXON_COLES_RHO = -0.08;

/* =========================================================
   MATH
========================================================= */

function poisson(k, lambda) {
  if (!Number.isFinite(lambda) || lambda <= 0) return k === 0 ? 1 : 0;
  let fact = 1;
  for (let i = 2; i <= k; i++) fact *= i;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / fact;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// Time decay: peso = 0.5 ^ (giorni / halfLife)
function timeDecay(matchDate, halfLifeDays) {
  if (!matchDate) return 1;
  const days = (Date.now() - new Date(matchDate).getTime()) / 86400000;
  if (!Number.isFinite(days) || days < 0) return 1;
  return Math.pow(0.5, days / halfLifeDays);
}

/* =========================================================
   LETTURA PARAMETRI DA SUPABASE
========================================================= */

async function loadModelConfig() {
  const defaults = {
    weights: { ...DEFAULT_WEIGHTS },
    decayHalfLifeDays: DEFAULT_DECAY_HALF_LIFE_DAYS,
    dixonColesRho: DEFAULT_DIXON_COLES_RHO,
    source: "defaults"
  };

  const supabase = getSupabase();
  if (!supabase) return defaults;

  try {
    const { data, error } = await supabase
      .from("model_config")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return defaults;

    return {
      weights: {
        understat: Number(data.weight_understat) || DEFAULT_WEIGHTS.understat,
        standings: Number(data.weight_standings) || DEFAULT_WEIGHTS.standings,
        form: Number(data.weight_form) || DEFAULT_WEIGHTS.form,
        base: Number(data.weight_base) || DEFAULT_WEIGHTS.base
      },
      decayHalfLifeDays:
        Number(data.decay_half_life_days) || DEFAULT_DECAY_HALF_LIFE_DAYS,
      dixonColesRho:
        Number.isFinite(Number(data.dixon_coles_rho))
          ? Number(data.dixon_coles_rho)
          : DEFAULT_DIXON_COLES_RHO,
      source: "supabase"
    };
  } catch {
    return defaults;
  }
}

/* =========================================================
   ESTRAZIONE FATTORI DAL PAYLOAD
========================================================= */

function getStandingRow(standings, teamName) {
  if (!Array.isArray(standings)) return null;
  const wanted = normalizeTeamName(teamName);
  if (!wanted) return null;

  return (
    standings.find((row) => {
      const candidates = [
        row?.team_name, row?.teamName, row?.name,
        row?.team?.name, row?.team?.title
      ];
      return candidates.some((v) => {
        const cur = normalizeTeamName(v);
        if (!cur || !wanted) return false;
        return (
          cur === wanted ||
          (cur.includes(wanted) && wanted.length >= 4) ||
          (wanted.includes(cur) && cur.length >= 4)
        );
      });
    }) || null
  );
}

function getStandingStats(row) {
  if (!row) return null;

  const games = num(
    row.games_played ?? row.played ?? row.games ?? row.matches_played
  );
  const gf = num(
    row.goals_for ?? row.gf ?? row.scored ??
    row.points_for ?? row.pointsFor          // ← BBS usa questo
  );
  const ga = num(
    row.goals_against ?? row.ga ?? row.conceded ??
    row.points_against ?? row.pointsAgainst  // ← BBS usa questo
  );

  if (games === null || games <= 0 || gf === null || ga === null) return null;

  return {
    goalsForPerGame: gf / games,
    goalsAgainstPerGame: ga / games,
    played: games
  };
}

function getUnderstatEntry(understat, teamName) {
  if (!understat || typeof understat !== "object") return null;
  const wanted = normalizeTeamName(teamName);
  if (!wanted) return null;
  if (understat[wanted]) return understat[wanted];
  for (const [k, v] of Object.entries(understat)) {
    if (normalizeTeamName(v?.team) === wanted) return v;
  }
  return null;
}

function getFormEntry(form, teamName) {
  if (!form || typeof form !== "object") return null;
  const wanted = normalizeTeamName(teamName);
  if (!wanted) return null;
  if (form[wanted]) return form[wanted];
  for (const [, v] of Object.entries(form)) {
    if (normalizeTeamName(v?.team) === wanted) return v;
  }
  return null;
}

function getH2HMatches(h2h, homeTeam, awayTeam) {
  if (!h2h || typeof h2h !== "object") return [];
  const key = h2hKey(homeTeam, awayTeam);
  const arr = h2h[key];
  return Array.isArray(arr) ? arr : [];
}

/* =========================================================
   SUB-MODELLI (λ per singola fonte)
========================================================= */

/**
 * Classifica: forza attacco/difesa rispetto alla media lega.
 * Formula corretta: attacco_home * difesa_away, non media pesata.
 */
function lambdaFromStandings(homeStats, awayStats) {
  if (!homeStats || !awayStats) return null;

  const homeAttack = homeStats.goalsForPerGame / LEAGUE_HOME_XG;
  const awayDefense = awayStats.goalsAgainstPerGame / LEAGUE_AWAY_XG;
  const awayAttack = awayStats.goalsForPerGame / LEAGUE_AWAY_XG;
  const homeDefense = homeStats.goalsAgainstPerGame / LEAGUE_HOME_XG;

  return {
    home: LEAGUE_HOME_XG * homeAttack * awayDefense,
    away: LEAGUE_AWAY_XG * awayAttack * homeDefense
  };
}

/**
 * Understat: xG fatti/subiti per partita, normalizzati sulla media lega.
 */
function lambdaFromUnderstat(homeU, awayU) {
  if (!homeU || !awayU) return null;
  if (homeU.xgForPerGame == null || awayU.xgForPerGame == null) return null;

  // Regressione verso la media lega (Bayesian shrinkage)
  const K = 5;
  const shrink = (observed, played) => {
    const games = Math.max(1, played || 1);
    const w = games / (games + K);
    return w * observed + (1 - w) * LEAGUE_AVG_XG;
  };

  const homePlayed = homeU.matchesWithXg ?? homeU.played ?? 1;
  const awayPlayed = awayU.matchesWithXg ?? awayU.played ?? 1;

  const homeXgFor = shrink(homeU.xgForPerGame, homePlayed);
  const homeXgAgainst = shrink(homeU.xgAgainstPerGame ?? LEAGUE_AVG_XG, homePlayed);
  const awayXgFor = shrink(awayU.xgForPerGame, awayPlayed);
  const awayXgAgainst = shrink(awayU.xgAgainstPerGame ?? LEAGUE_AVG_XG, awayPlayed);

  const homeAttack = homeXgFor / LEAGUE_AVG_XG;
  const awayDefense = awayXgAgainst / LEAGUE_AVG_XG;
  const awayAttack = awayXgFor / LEAGUE_AVG_XG;
  const homeDefense = homeXgAgainst / LEAGUE_AVG_XG;

  return {
    home: LEAGUE_HOME_XG * homeAttack * awayDefense,
    away: LEAGUE_AWAY_XG * awayAttack * homeDefense
  };
}

/**
 * Forma: gol fatti/subiti nelle ultime 5 partite, con fattore punti.
 */
function lambdaFromForm(homeForm, awayForm) {
  if (!homeForm || !awayForm) return null;

  const homeAttack = (homeForm.averageGoalsFor || 0) / LEAGUE_HOME_XG;
  const awayDefense = (awayForm.averageGoalsAgainst || 0) / LEAGUE_AWAY_XG;
  const awayAttack = (awayForm.averageGoalsFor || 0) / LEAGUE_AWAY_XG;
  const homeDefense = (homeForm.averageGoalsAgainst || 0) / LEAGUE_HOME_XG;

  const formFactor = (f) => {
    const m = (f.last5 || []).length || 1;
    const rate = (f.pointsLast5 || 0) / (m * 3);
    return clamp(0.88 + rate * 0.24, 0.88, 1.12);
  };

  return {
    home: LEAGUE_HOME_XG * homeAttack * awayDefense * formFactor(homeForm),
    away: LEAGUE_AWAY_XG * awayAttack * homeDefense * formFactor(awayForm)
  };
}

/* =========================================================
   EXPECTED GOALS FINALE
========================================================= */

function calculateExpectedGoals(body, config) {
  const homeTeam = body.homeTeam;
  const awayTeam = body.awayTeam;

  const homeStanding = getStandingStats(getStandingRow(body.standings, homeTeam));
  const awayStanding = getStandingStats(getStandingRow(body.standings, awayTeam));
  const homeForm = getFormEntry(body.form, homeTeam);
  const awayForm = getFormEntry(body.form, awayTeam);
  const homeU = getUnderstatEntry(body.understat, homeTeam);
  const awayU = getUnderstatEntry(body.understat, awayTeam);

  const sources = [];
  const factors = {
    understat: false, standings: false, form: false,
    homeAway: true, h2h: false
  };

  // --- Sotto-modelli ---
  const lamUS = lambdaFromUnderstat(homeU, awayU);
  if (lamUS) {
    sources.push({ key: "understat", ...lamUS });
    factors.understat = true;
  }

  const lamTable = lambdaFromStandings(homeStanding, awayStanding);
  if (lamTable) {
    sources.push({ key: "standings", ...lamTable });
    factors.standings = true;
  }

  const lamForm = lambdaFromForm(homeForm, awayForm);
  if (lamForm) {
    sources.push({ key: "form", ...lamForm });
    factors.form = true;
  }

  // Base: sempre disponibile
  sources.push({ key: "base", home: 1.35, away: 1.05 });

  // --- Media pesata ---
  let totalW = 0, homeXG = 0, awayXG = 0;
  for (const s of sources) {
    const w = config.weights[s.key] ?? 0.2;
    totalW += w;
    homeXG += s.home * w;
    awayXG += s.away * w;
  }
  homeXG /= totalW;
  awayXG /= totalW;

  // --- H2H: solo ultimi 3 anni, aggiustamento massimo ±5% ---
  const h2hMatches = getH2HMatches(body.h2h, homeTeam, awayTeam);
  const threeYearsAgo = Date.now() - 3 * 365 * 86400000;
  const recentH2H = h2hMatches.filter((m) => {
    const t = new Date(m.date || 0).getTime();
    return t >= threeYearsAgo;
  });

  let h2hInfo = { available: false };

  if (recentH2H.length >= 1) {
    const wanted = normalizeTeamName(homeTeam);
    let hg = 0, ag = 0, cnt = 0;

    for (const m of recentH2H.slice(0, 5)) {
      const h = num(m.homeGoals), a = num(m.awayGoals);
      if (h === null || a === null) continue;
      if (normalizeTeamName(m.homeTeam) === wanted) {
        hg += h; ag += a;
      } else {
        hg += a; ag += h;
      }
      cnt++;
    }

    if (cnt >= 2) {
      const avgH = hg / cnt;
      const avgA = ag / cnt;
      // Con 1 match l'aggiustamento è dimezzato (±2.5%), con 2+ è pieno (±5%)
      const h2hWeight = Math.min(1, cnt / 2);
      homeXG *= clamp(0.95 + (avgH / 1.45) * 0.05 * h2hWeight, 0.95, 1.05);
      awayXG *= clamp(0.95 + (avgA / 1.15) * 0.05 * h2hWeight, 0.95, 1.05);
      factors.h2h = true;
      h2hInfo = {
        available: true, matches: cnt,
        averageHomeGoals: Number(avgH.toFixed(2)),
        averageAwayGoals: Number(avgA.toFixed(2))
      };
    }
  }

  // --- Vantaggio casa (una volta sola) ---
  homeXG *= 1.06;

  // --- Clamp finale ---
  homeXG = clamp(homeXG, 0.15, 4.5);
  awayXG = clamp(awayXG, 0.10, 4.0);

  const used = sources.map((s) => s.key).filter((k) => k !== "base");
  if (factors.h2h) used.push("h2h");
  used.push("casa");

  return {
    home: Number(homeXG.toFixed(3)),
    away: Number(awayXG.toFixed(3)),
    source: `Modello: ${used.join(" + ")}`,
    factors,
    h2h: h2hInfo
  };
}

/* =========================================================
   DIXON-COLES + MERCATI
========================================================= */

function dixonColesAdjustment(h, a, lH, lA, rho) {
  if (h === 0 && a === 0) return 1 - lH * lA * rho;
  if (h === 0 && a === 1) return 1 + lH * rho;
  if (h === 1 && a === 0) return 1 + lA * rho;
  if (h === 1 && a === 1) return 1 - rho;
  return 1;
}

function buildMatrix(homeXG, awayXG, rho) {
  const matrix = [];
  let total = 0;

  for (let h = 0; h <= MAX_GOALS; h++) {
    matrix[h] = [];
    for (let a = 0; a <= MAX_GOALS; a++) {
      const base = poisson(h, homeXG) * poisson(a, awayXG) *
        dixonColesAdjustment(h, a, homeXG, awayXG, rho);
      const p = Math.max(0, base);
      matrix[h][a] = p;
      total += p;
    }
  }

  if (total > 0) {
    for (let h = 0; h <= MAX_GOALS; h++)
      for (let a = 0; a <= MAX_GOALS; a++)
        matrix[h][a] /= total;
  }

  return matrix;
}

function calculate1X2(matrix) {
  let home = 0, draw = 0, away = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = matrix[h][a] || 0;
      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;
    }
  }
  return { home, draw, away };
}

function calculateDoubleChance(p) {
  return {
    "1X": p.home + p.draw,
    "X2": p.draw + p.away,
    "12": p.home + p.away
  };
}

function calculateOverUnder(matrix) {
  const r = {
    over15: 0, under15: 0,
    over25: 0, under25: 0,
    over35: 0, under35: 0
  };
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = matrix[h][a] || 0;
      const g = h + a;
      if (g > 1.5) r.over15 += p; else r.under15 += p;
      if (g > 2.5) r.over25 += p; else r.under25 += p;
      if (g > 3.5) r.over35 += p; else r.under35 += p;
    }
  }
  return r;
}

function calculateBTTS(matrix) {
  let yes = 0, no = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = matrix[h][a] || 0;
      if (h > 0 && a > 0) yes += p; else no += p;
    }
  }
  return { yes, no };
}

function calculateExactScores(matrix) {
  const rows = [];
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      rows.push({
        score: `${h}-${a}`,
        home: h, away: a,
        probability: matrix[h][a] || 0
      });
    }
  }
  rows.sort((x, y) => y.probability - x.probability);
  return rows.slice(0, 10);
}

function calculateHandicap(matrix) {
  let homeMinus1 = 0, homePlus1 = 0, awayPlus1 = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = matrix[h][a] || 0;
      if (h - a > 1) homeMinus1 += p;
      if (h + 1 > a) homePlus1 += p;
      if (a + 1 > h) awayPlus1 += p;
    }
  }
  return { homeMinus1, homePlus1, awayPlus1 };
}

function fairOdd(p) {
  if (!Number.isFinite(p) || p <= 0) return null;
  return Number((1 / p).toFixed(2));
}

function calculateFairOdds(p, ou, btts) {
  return {
    home: fairOdd(p.home),
    draw: fairOdd(p.draw),
    away: fairOdd(p.away),
    over25: fairOdd(ou.over25),
    under25: fairOdd(ou.under25),
    bttsYes: fairOdd(btts.yes)
  };
}

function calculateConfidence(expected) {
  const f = expected.factors || {};
  let c = 48;
  if (f.standings) c += 8;
  if (f.form) c += 8;
  if (f.h2h) c += 4;
  if (f.understat) c += 12;
  return Math.round(clamp(c, 30, 95));
}

/* =========================================================
   TRACKING SUPABASE (non bloccante)
========================================================= */

async function trackPrediction(body, expected, probabilities, config) {
  const supabase = getSupabase();
  if (!supabase) return;

  const matchId = body?.match?.id;

  // FIX: se non c'è un UUID BBS, non salviamo
  // (evita match_id orfani che non combaceranno mai con results)
  if (!matchId || typeof matchId !== "string" || !matchId.includes("-")) {
    console.warn("trackPrediction: match_id non valido, salto il salvataggio");
    return;
  }

  const pick =
    probabilities.home >= probabilities.draw && probabilities.home >= probabilities.away
      ? "1"
      : probabilities.away >= probabilities.draw
        ? "2"
        : "X";

  try {
    const { error } = await supabase.from("predictions").insert({
      match_id: String(matchId),
      home_team: body.homeTeam,
      away_team: body.awayTeam,
      predicted_at: new Date().toISOString(),
      xg_home: expected.home,
      xg_away: expected.away,
      prediction_1x2: pick,
      probabilities: {
        home: Number(probabilities.home.toFixed(4)),
        draw: Number(probabilities.draw.toFixed(4)),
        away: Number(probabilities.away.toFixed(4))
      },
      confidence: calculateConfidence(expected),
      model: "v7-poisson-dc-multifactor",
      model_params: config
    });
    if (error) console.error("trackPrediction insert error:", error.message);
  } catch (e) {
    console.error("trackPrediction exception:", e?.message || e);
  }
}

/* =========================================================
   HANDLER
========================================================= */

async function parseBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return {};
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  try {
    const body = await parseBody(req);

    const homeTeam = String(body.homeTeam || "").trim();
    const awayTeam = String(body.awayTeam || "").trim();
    const competition = String(body.competition || "seriea").trim();

    if (!homeTeam || !awayTeam) {
      return res.status(400).json({
        ok: false, error: "MISSING_TEAMS",
        message: "homeTeam e awayTeam sono obbligatori."
      });
    }

    if (normalizeTeamName(homeTeam) === normalizeTeamName(awayTeam)) {
      return res.status(400).json({
        ok: false, error: "SAME_TEAM",
        message: "Le due squadre devono essere diverse."
      });
    }

    // Carica parametri da Supabase
    const config = await loadModelConfig();

    // Calcola xG
    const expected = calculateExpectedGoals(body, config);

    // Matrice Poisson + Dixon-Coles
    const matrix = buildMatrix(expected.home, expected.away, config.dixonColesRho);

    // Mercati
    const probabilities = calculate1X2(matrix);
    const doubleChance = calculateDoubleChance(probabilities);
    const overUnder = calculateOverUnder(matrix);
    const btts = calculateBTTS(matrix);
    const exactScores = calculateExactScores(matrix);
    const handicap = calculateHandicap(matrix);
    const fairOdds = calculateFairOdds(probabilities, overUnder, btts);
    const confidence = calculateConfidence(expected);

    // Tracking (non bloccante)
    try {
      await Promise.race([
        trackPrediction(body, expected, probabilities, config),
        new Promise((r) => setTimeout(r, 2500))
      ]);
    } catch {}

    return res.status(200).json({
      ok: true,
      competition,
      homeTeam,
      awayTeam,
      model: "V7 Poisson + Dixon-Coles multi-fattore",
      modelConfig: {
        source: config.source,
        weights: config.weights,
        decayHalfLifeDays: config.decayHalfLifeDays,
        dixonColesRho: config.dixonColesRho
      },
      xgSource: expected.source,
dataQuality: {
  homeTeam: (() => {
    const d = body.understat?.[normalizeTeamName(homeTeam)];
    return {
      matches: d?.matchesWithXg ?? 0,
      played: d?.played ?? 0,
      xgForPerGame: d?.xgForPerGame ?? null,
      xgAgainstPerGame: d?.xgAgainstPerGame ?? null
    };
  })(),
  awayTeam: (() => {
    const d = body.understat?.[normalizeTeamName(awayTeam)];
    return {
      matches: d?.matchesWithXg ?? 0,
      played: d?.played ?? 0,
      xgForPerGame: d?.xgForPerGame ?? null,
      xgAgainstPerGame: d?.xgAgainstPerGame ?? null
    };
  })()
},
factorsUsed: expected.factors,
      h2h: expected.h2h,
      probabilities,
      doubleChance,
      overUnder,
      btts,
      handicap,
      exactScores,
      fairOdds,
      confidence
    });

  } catch (error) {
    console.error("PREDICT ERROR:", error);
    return res.status(500).json({
      ok: false, error: "PREDICTION_ERROR",
      message: error?.message || "Errore interno nel modello."
    });
  }
}
