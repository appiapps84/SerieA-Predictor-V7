// Normalizzazione nomi squadre — UNICA fonte di verità per tutto il backend.
// I nomi che arrivano da BBS, Understat, API-Football sono diversi tra loro:
// questo modulo li rende tutti confrontabili con una chiave stabile.

const NOISE = /\b(fc|ac|as|ss|ssc|usc|cfc|calcio|1907|1899|1909|1913|1920|1926|1928|1929)\b/g;

// Alias: da nome BBS/Understat/API-Football → chiave canonica V7
const ALIASES = {
  // Inter
  "inter milan": "inter",
  "internazionale": "inter",
  "inter": "inter",

  // Milan
  "ac milan": "milan",
  "milan": "milan",

  // Roma
  "as roma": "roma",
  "roma": "roma",

  // Como
  "como 1907": "como",
  "como": "como",

  // Venezia
  "venezia fc": "venezia",
  "venezia": "venezia",

  // Hellas Verona
  "hellas verona": "verona",
  "verona": "verona",

  // Juventus
  "juventus": "juventus",
  "juve": "juventus",

  // Napoli
  "napoli": "napoli",
  "ssc napoli": "napoli",

  // Lazio
  "lazio": "lazio",
  "ss lazio": "lazio",

  // Fiorentina
  "fiorentina": "fiorentina",
  "acf fiorentina": "fiorentina",

  // Atalanta
  "atalanta": "atalanta",
  "atalanta bc": "atalanta",

  // Torino
  "torino": "torino",

  // Bologna
  "bologna": "bologna",

  // Udinese
  "udinese": "udinese",

  // Genoa
  "genoa": "genoa",
  "genoa cfc": "genoa",

  // Cagliari
  "cagliari": "cagliari",

  // Empoli
  "empoli": "empoli",

  // Lecce
  "lecce": "lecce",

  // Parma
  "parma": "parma",
  "parma calcio": "parma",

  // Monza
  "monza": "monza",

  // Salernitana
  "salernitana": "salernitana",

  // Sassuolo
  "sassuolo": "sassuolo",

  // Frosinone
  "frosinone": "frosinone",

  // Cremonese
  "cremonese": "cremonese",

  // Pisa
  "pisa": "pisa",

  // Chievo (storico)
  "chievo": "chievo",
  "chievo verona": "chievo",

  // Sampdoria (storico)
  "sampdoria": "sampdoria",

  // Spezia (storico)
  "spezia": "spezia",

  // Benevento (storico)
  "benevento": "benevento",

  // Brescia (storico)
  "brescia": "brescia",

  // Crotone (storico)
  "crotone": "crotone"
};

export function normalizeTeamName(value) {
  if (value == null) return "";

  // Se è un oggetto (es. { name: "Inter" }), estrai il nome
  if (typeof value === "object") {
    value = value.name ?? value.team_name ?? value.teamName ?? value.title ?? "";
  }

  let s = String(value).toLowerCase().trim();

  // rimuovi accenti
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // rimuovi punteggiatura
  s = s.replace(/[^a-z0-9\s]/g, " ");

  // rimuovi parole di rumore (fc, ac, anni...)
  s = s.replace(NOISE, " ");

  // collassa spazi
  s = s.replace(/\s+/g, " ").trim();

  // applica alias (prima match esatto, poi contiene)
  if (ALIASES[s]) return ALIASES[s];

  for (const [alias, canonical] of Object.entries(ALIASES)) {
    if (s.includes(alias) && alias.length >= 4) return canonical;
  }

  return s;
}

// Chiave H2H stabile (ordine indipendente)
export function h2hKey(teamA, teamB) {
  const a = normalizeTeamName(teamA);
  const b = normalizeTeamName(teamB);
  return a < b ? `${a}__${b}` : `${b}__${a}`;
}

// Chiave per cache / dizionari xG
export function xgKey(teamName) {
  return normalizeTeamName(teamName);
}
