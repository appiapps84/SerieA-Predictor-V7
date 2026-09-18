/* =========================================================
   api/backtest.js — V7
   Misura l'accuratezza REALE del modello confrontando le
   previsioni salvate (predictions) con i risultati (results).

   Endpoint: GET /api/backtest
========================================================= */

import { getSupabase } from "../lib/supabase.js";

/* =========================================================
   METRICHE
========================================================= */

/**
 * Brier score per 1X2.
 * Formula: (1/N) * Σ Σ (p_i - o_i)²  per i = {1, X, 2}
 * Range: 0 (perfetto) - 2 (pessimo). Sotto 0.6 è buono.
 */
function brierScore(matches) {
  if (matches.length === 0) return null;

  let sum = 0;
  for (const m of matches) {
    const p = m.prediction.probabilities || {};
    const ph = Number(p.home) || 0;
    const pd = Number(p.draw) || 0;
    const pa = Number(p.away) || 0;

    const r = m.result.result_1x2;
    const oh = r === "1" ? 1 : 0;
    const od = r === "X" ? 1 : 0;
    const oa = r === "2" ? 1 : 0;

    sum += Math.pow(ph - oh, 2) + Math.pow(pd - od, 2) + Math.pow(pa - oa, 2);
  }

  return sum / matches.length;
}

/**
 * Ranked Probability Score (RPS).
 * Standard accademico per il calcio: penalizza gli errori "vicini" meno
 * di quelli "lontani". Range 0 (perfetto) - 1 (pessimo).
 * Sotto 0.20 è buono, sotto 0.15 è ottimo.
 */
function rankedProbabilityScore(matches) {
  if (matches.length === 0) return null;

  let sum = 0;
  for (const m of matches) {
    const p = m.prediction.probabilities || {};
    const ph = Number(p.home) || 0;
    const pd = Number(p.draw) || 0;
    const pa = Number(p.away) || 0;

    const r = m.result.result_1x2;
    const oh = r === "1" ? 1 : 0;
    const od = r === "X" ? 1 : 0;
    const oa = r === "2" ? 1 : 0;

    // Cumulative probabilities e outcomes
    const cpH = ph;
    const cpD = ph + pd;
    const coH = oh;
    const coD = oh + od;

    sum += Math.pow(cpH - coH, 2) + Math.pow(cpD - coD, 2);
  }

  // Dividi per (numero di classi - 1) = 2
  return sum / (matches.length * 2);
}

/**
 * MAE (Mean Absolute Error) sui gol totali previsti vs reali.
 */
function meanAbsoluteError(matches) {
  if (matches.length === 0) return null;

  let sum = 0;
  for (const m of matches) {
    const predGoals =
      (Number(m.prediction.xg_home) || 0) + (Number(m.prediction.xg_away) || 0);
    const realGoals =
      (Number(m.result.goals_home) || 0) + (Number(m.result.goals_away) || 0);
    sum += Math.abs(predGoals - realGoals);
  }
  return sum / matches.length;
}

/**
 * Calibrazione: raggruppa le previsioni per fascia di probabilità
 * e confronta con la frequenza reale dell'esito scelto.
 * Ritorna un array di bucket { range, predicted, actual, count }.
 */
function calibration(matches) {
  const buckets = [
    { min: 0.0, max: 0.2, label: "0-20%" },
    { min: 0.2, max: 0.4, label: "20-40%" },
    { min: 0.4, max: 0.6, label: "40-60%" },
    { min: 0.6, max: 0.8, label: "60-80%" },
    { min: 0.8, max: 1.0, label: "80-100%" }
  ];

  const result = buckets.map((b) => ({
    ...b,
    predicted: 0,   // probabilità media prevista nel bucket
    actual: 0,      // frequenza reale dell'esito
    count: 0
  }));

  for (const m of matches) {
    const p = m.prediction.probabilities || {};
    const ph = Number(p.home) || 0;
    const pd = Number(p.draw) || 0;
    const pa = Number(p.away) || 0;

    const pick = m.prediction.prediction_1x2;
    let pickedProb = 0;
    if (pick === "1") pickedProb = ph;
    else if (pick === "X") pickedProb = pd;
    else if (pick === "2") pickedProb = pa;

    const hit = m.prediction.prediction_1x2 === m.result.result_1x2;

    const bucket = result.find((b) => pickedProb >= b.min && pickedProb < b.max) ||
                   result[result.length - 1];
    bucket.predicted += pickedProb;
    bucket.actual += hit ? 1 : 0;
    bucket.count += 1;
  }

  // Normalizza
  for (const b of result) {
    if (b.count > 0) {
      b.predicted = Number((b.predicted / b.count).toFixed(3));
      b.actual = Number((b.actual / b.count).toFixed(3));
    } else {
      b.predicted = null;
      b.actual = null;
    }
  }

  return result.filter((b) => b.count > 0);
}

/* =========================================================
   HANDLER
========================================================= */

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  const supabase = getSupabase();

  if (!supabase) {
    return res.status(200).json({
      ok: true,
      stats: null,
      message:
        "Supabase non configurato: il backtest richiede SUPABASE_URL e SUPABASE_ANON_KEY."
    });
  }

  try {
    const [{ data: predictions, error: pErr }, { data: results, error: rErr }] =
      await Promise.all([
        supabase
          .from("predictions")
          .select("*")
          .order("predicted_at", { ascending: false })
          .limit(500),
        supabase.from("results").select("*")
      ]);

    if (pErr) throw pErr;
    if (rErr) throw rErr;

    if (!predictions || predictions.length === 0) {
      return res.status(200).json({
        ok: true,
        stats: null,
        message:
          "Nessuna previsione salvata ancora. Calcola qualche previsione e aspetta i risultati."
      });
    }

    // Join su match_id
    const resultsById = new Map();
    for (const r of results || []) {
      resultsById.set(String(r.match_id), r);
    }

    const matched = [];
    const unmatched = [];

    for (const p of predictions) {
      const result = resultsById.get(String(p.match_id));
      if (result) matched.push({ prediction: p, result });
      else unmatched.push(p);
    }

    if (matched.length === 0) {
      return res.status(200).json({
        ok: true,
        stats: null,
        message:
          `${predictions.length} previsioni salvate ma nessuna partita ancora conclusa. ` +
          `Riprova dopo i prossimi risultati.`,
        pending: predictions.length
      });
    }

    // --- Metriche principali ---
    const correct = matched.filter(
      (m) => m.prediction.prediction_1x2 === m.result.result_1x2
    ).length;

    const accuracy1X2 = Number(((correct / matched.length) * 100).toFixed(1));

    // --- Ultime 20 ---
    const recent20 = matched.slice(0, 20);
    const recentCorrect = recent20.filter(
      (m) => m.prediction.prediction_1x2 === m.result.result_1x2
    ).length;
    const recentAccuracy = Number(
      ((recentCorrect / Math.max(1, recent20.length)) * 100).toFixed(1)
    );

    // --- Metriche avanzate ---
    const brier = brierScore(matched);
    const rps = rankedProbabilityScore(matched);
    const mae = meanAbsoluteError(matched);
    const calib = calibration(matched);

    // --- Distribuzione scelte vs risultati ---
    const pickCounts = { "1": 0, "X": 0, "2": 0 };
    const resultCounts = { "1": 0, "X": 0, "2": 0 };

    for (const m of matched) {
      const pk = m.prediction.prediction_1x2;
      const rk = m.result.result_1x2;
      if (pickCounts[pk] !== undefined) pickCounts[pk] += 1;
      if (resultCounts[rk] !== undefined) resultCounts[rk] += 1;
    }

    // --- Accuracy per esito (quanto indovina 1, X, 2 separatamente) ---
    const accuracyByOutcome = {};
    for (const outcome of ["1", "X", "2"]) {
      const subset = matched.filter((m) => m.result.result_1x2 === outcome);
      const hit = subset.filter(
        (m) => m.prediction.prediction_1x2 === outcome
      ).length;
      accuracyByOutcome[outcome] = {
        total: subset.length,
        correct: hit,
        accuracy: subset.length > 0
          ? Number(((hit / subset.length) * 100).toFixed(1))
          : null
      };
    }

    // --- Confidence media ---
    const withConfidence = matched.filter(
      (m) => Number.isFinite(Number(m.prediction.confidence))
    );
    const avgConfidence = withConfidence.length > 0
      ? Number(
          (
            withConfidence.reduce(
              (s, m) => s + Number(m.prediction.confidence),
              0
            ) / withConfidence.length
          ).toFixed(1)
        )
      : null;

    // --- Ultime 10 partite con dettaglio ---
    const lastMatches = matched.slice(0, 10).map((m) => ({
      match: `${m.prediction.home_team} - ${m.prediction.away_team}`,
      predicted: m.prediction.prediction_1x2,
      predictedProbs: m.prediction.probabilities,
      result: `${m.result.goals_home}-${m.result.goals_away}`,
      result1x2: m.result.result_1x2,
      hit: m.prediction.prediction_1x2 === m.result.result_1x2,
      confidence: Number(m.prediction.confidence) || null,
      predictedXg: {
        home: Number(m.prediction.xg_home) || null,
        away: Number(m.prediction.xg_away) || null
      },
      date: m.result.kickoff_utc || m.result.finished_at || null
    }));

    return res.status(200).json({
      ok: true,
      stats: {
        totalPredictions: predictions.length,
        totalMatched: matched.length,
        pending: unmatched.length,

        accuracy1X2,
        correct,

        recent20: {
          sample: recent20.length,
          correct: recentCorrect,
          accuracy: recentAccuracy
        },

        maeTotalGoals: mae !== null ? Number(mae.toFixed(2)) : null,
        brierScore: brier !== null ? Number(brier.toFixed(4)) : null,
        rps: rps !== null ? Number(rps.toFixed(4)) : null,

        avgConfidence,

        picks: pickCounts,
        actualResults: resultCounts,
        accuracyByOutcome,

        calibration: calib
      },

      lastMatches
    });

  } catch (error) {
    console.error("BACKTEST ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: "BACKTEST_ERROR",
      message: error?.message || String(error)
    });
  }
}
