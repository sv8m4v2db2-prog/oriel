// Dates en langage naturel, en français : « demain », « vendredi prochain », « dans 3 jours »,
// « 12 nov », « lundi 14h », « du 12 au 14 novembre »…
//
// Parseur maison, sans dépendance. Tout est calculé sur le calendrier LOCAL de l'utilisateur
// (jamais d'arithmétique en millisecondes pour les jours : un changement d'heure ne décale rien).
// Sert à l'éditeur de date des cellules et aux mentions de date `@`.
//
// Conventions :
// - un jour de semaine seul (« vendredi », « vendredi prochain ») = la prochaine occurrence,
//   aujourd'hui exclu ; « ce vendredi » = la prochaine occurrence, aujourd'hui compris ;
//   « vendredi dernier » = l'occurrence passée la plus récente ;
// - une date sans année = cette année, ou l'année suivante si elle est passée depuis plus d'un mois ;
// - un nombre seul (« le 15 ») = la prochaine occurrence de ce quantième (aujourd'hui compris) ;
// - « dans huit jours » = 7 jours et « dans quinze jours » = 14 (usage français, écrit en lettres) ;
//   « dans 8 jours » = 8 jours.

export interface NaturalDate {
  /** Début : le jour local à 00:00, ou jour + heure quand `hasTime`. */
  start: Date;
  /** Fin d'une plage (« du 12 au 14 nov », « lundi 14h-16h »), sinon null. */
  end: Date | null;
  /** Une heure a été donnée. */
  hasTime: boolean;
}

const MAX_INPUT = 80;

const MONTH_FORMS: Array<[string[], number]> = [
  [['janvier', 'janv', 'jan'], 0],
  [['fevrier', 'fevr', 'fev'], 1],
  [['mars', 'mar'], 2],
  [['avril', 'avr'], 3],
  [['mai'], 4],
  [['juin'], 5],
  [['juillet', 'juil'], 6],
  [['aout', 'aou'], 7],
  [['septembre', 'sept', 'sep'], 8],
  [['octobre', 'oct'], 9],
  [['novembre', 'nov'], 10],
  [['decembre', 'dec'], 11],
];
const MONTHS = new Map<string, number>();
for (const [forms, idx] of MONTH_FORMS) for (const f of forms) MONTHS.set(f, idx);

/** Jours de la semaine, indexés comme Date#getDay() (dimanche = 0). */
const WEEKDAY_FORMS: Array<[string[], number]> = [
  [['dimanche', 'dim'], 0],
  [['lundi', 'lun'], 1],
  [['mardi', 'mar'], 2],
  [['mercredi', 'mer'], 3],
  [['jeudi', 'jeu'], 4],
  [['vendredi', 'ven'], 5],
  [['samedi', 'sam'], 6],
];
const WEEKDAYS = new Map<string, number>();
for (const [forms, idx] of WEEKDAY_FORMS) for (const f of forms) WEEKDAYS.set(f, idx);

const NUMBER_WORDS: Record<string, number> = {
  un: 1,
  une: 1,
  deux: 2,
  trois: 3,
  quatre: 4,
  cinq: 5,
  six: 6,
  sept: 7,
  huit: 8,
  neuf: 9,
  dix: 10,
  onze: 11,
  douze: 12,
  treize: 13,
  quatorze: 14,
  quinze: 15,
  seize: 16,
  vingt: 20,
  trente: 30,
};

// ---------------------------------------------------------------------------
// Calendrier local
// ---------------------------------------------------------------------------

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/** Ajoute des mois en gardant le quantième, ramené au dernier jour du mois s'il n'existe pas. */
function addMonths(d: Date, n: number): Date {
  const first = new Date(d.getFullYear(), d.getMonth() + n, 1);
  return new Date(first.getFullYear(), first.getMonth(), Math.min(d.getDate(), daysInMonth(first.getFullYear(), first.getMonth())));
}

function validDay(year: number, month: number, day: number): Date | null {
  if (year < 1000 || year > 9999) return null;
  const d = new Date(year, month, day);
  return d.getFullYear() === year && d.getMonth() === month && d.getDate() === day ? d : null;
}

/** Jour sans année : cette année, ou la suivante s'il est passé depuis plus d'un mois. */
function withoutYear(month: number, day: number, today: Date): Date | null {
  const d = validDay(today.getFullYear(), month, day);
  if (!d) return validDay(today.getFullYear() + 1, month, day);
  return d.getTime() < addDays(today, -31).getTime() ? validDay(today.getFullYear() + 1, month, day) : d;
}

/** Prochaine occurrence du jour de semaine ; `inclusive` : aujourd'hui compris. */
function nextWeekday(today: Date, weekday: number, inclusive: boolean): Date {
  let diff = (weekday - today.getDay() + 7) % 7;
  if (diff === 0 && !inclusive) diff = 7;
  return addDays(today, diff);
}

function previousWeekday(today: Date, weekday: number): Date {
  const diff = (today.getDay() - weekday + 7) % 7 || 7;
  return addDays(today, -diff);
}

/** Lundi de la semaine (ISO) du jour donné. */
function mondayOf(d: Date): Date {
  return addDays(d, -((d.getDay() + 6) % 7));
}

/** Prochain quantième `day` (aujourd'hui compris), en sautant les mois trop courts. */
function nextDayOfMonth(today: Date, day: number): Date | null {
  for (let i = 0; i < 14; i++) {
    const first = new Date(today.getFullYear(), today.getMonth() + i, 1);
    const d = validDay(first.getFullYear(), first.getMonth(), day);
    if (d && d.getTime() >= today.getTime()) return d;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Normalisation et petits analyseurs
// ---------------------------------------------------------------------------

function normalize(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** « 3 » ou « trois » → 3 ; null sinon. */
function count(word: string): number | null {
  if (/^\d{1,3}$/.test(word)) return Number(word);
  return NUMBER_WORDS[word] ?? null;
}

interface Time {
  h: number;
  m: number;
}

interface Parsed {
  day: Date;
  time: Time | null;
  /** Heure de fin d'une plage horaire, le même jour (« 14h-16h »). */
  endTime: Time | null;
}

const validTime = (h: number, m: number) => h >= 0 && h <= 23 && m >= 0 && m <= 59;

/** « 3 h de l'après-midi », « 9h du soir » : ramène une heure du matin sur l'après-midi. */
function applyDayPart(h: number, part: string | undefined): number {
  if (!part) return h;
  if ((part === 'soir' || part === 'apres-midi') && h < 12) return h + 12;
  return h;
}

const DAY_PART_DEFAULT: Record<string, Time> = {
  matin: { h: 9, m: 0 },
  'apres-midi': { h: 15, m: 0 },
  soir: { h: 19, m: 0 },
};

/** Extrait l'heure (ou la plage horaire) de la phrase ; renvoie le reste sans l'heure. */
function extractTime(s: string): { rest: string; time: Time | null; endTime: Time | null; invalid: boolean } {
  let rest = s;
  let time: Time | null = null;
  let endTime: Time | null = null;

  // Plage horaire : « 14h-16h », « de 14h à 16h30 », « 14:00 - 15:30 ».
  const range = /(?:\b(?:de|a|vers)\s+)?\b(\d{1,2})\s*(?:h|:)\s*(\d{2})?\s*(?:-|a|jusqu'?a|jusqu'?au)\s*(\d{1,2})\s*(?:h|:)\s*(\d{2})?\b/.exec(rest);
  if (range) {
    const h1 = Number(range[1]);
    const m1 = range[2] ? Number(range[2]) : 0;
    const h2 = Number(range[3]);
    const m2 = range[4] ? Number(range[4]) : 0;
    if (!validTime(h1, m1) || !validTime(h2, m2)) return { rest, time: null, endTime: null, invalid: true };
    time = { h: h1, m: m1 };
    endTime = { h: h2, m: m2 };
    rest = (rest.slice(0, range.index) + ' ' + rest.slice(range.index + range[0].length)).trim();
  } else {
    // « 14h », « 14h30 », « 14 h 30 », « 14:30 », « à 9h », « 3 h de l'après-midi », « 14h et demie ».
    const single = /(?:\b(?:a|vers)\s+)?\b(\d{1,2})\s*(?:h(?:eures?)?|:)(?:\s*(\d{2})(?!\d))?(\s+et\s+demie?|\s+et\s+quart|\s+moins\s+le\s+quart|\s+moins\s+(\d{1,2}))?(?:\s+(?:du|de\s+l'|de\s+la|au)\s*(matin|apres-midi|soir))?/.exec(rest);
    if (single) {
      let h = Number(single[1]);
      let m = single[2] ? Number(single[2]) : 0;
      const modifier = single[3]?.trim();
      if (modifier) {
        if (/^et\s+demie?$/.test(modifier)) m = 30;
        else if (/^et\s+quart$/.test(modifier)) m = 15;
        else if (/^moins\s+le\s+quart$/.test(modifier)) {
          h = h - 1;
          m = 45;
        } else if (single[4]) {
          h = h - 1;
          m = 60 - Number(single[4]);
        }
      }
      if (h < 0) h += 24;
      h = applyDayPart(h, single[5]);
      if (!validTime(h, m)) return { rest, time: null, endTime: null, invalid: true };
      time = { h, m };
      rest = (rest.slice(0, single.index) + ' ' + rest.slice(single.index + single[0].length)).trim();
    }
  }

  if (!time) {
    // « midi », « midi et demi », « minuit », « vers midi ».
    const word = /(?:\b(?:a|vers)\s+)?(?<![\w-])(midi|minuit)(\s+et\s+demi|\s+et\s+quart)?\b/.exec(rest);
    if (word) {
      const base = word[1] === 'midi' ? 12 : 0;
      const m = word[2] ? (/demi/.test(word[2]) ? 30 : 15) : 0;
      time = { h: base, m };
      rest = (rest.slice(0, word.index) + ' ' + rest.slice(word.index + word[0].length)).trim();
    }
  }

  if (!time) {
    // « ce soir », « demain matin », « cet après-midi » : heure par défaut du moment de la journée.
    const part = /\b(matin|apres-midi|soir)\b/.exec(rest);
    if (part) {
      time = { ...DAY_PART_DEFAULT[part[1]!]! };
      rest = (rest.slice(0, part.index) + ' ' + rest.slice(part.index + part[0].length)).trim();
    }
  }
  return { rest: rest.replace(/\s+/g, ' ').trim(), time, endTime, invalid: false };
}

/** Retire les mots de liaison autour de la partie « date ». */
function tidy(s: string): string {
  let t = s.replace(/[,;]/g, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) {
    t = t
      .replace(/^(?:(?:le|la|du|de|a|au|vers|pour|ce|cet|cette)\s+|l')/, '')
      .replace(/\s+(?:a|le|vers)$/, '')
      .trim();
  }
  return t;
}

// ---------------------------------------------------------------------------
// Partie « jour »
// ---------------------------------------------------------------------------

interface DayHint {
  /** Mois / année de référence (fin d'une plage) pour une borne qui n'en donne pas. */
  month: number;
  year: number;
}

function parseDay(raw: string, today: Date, now: Date, hint: DayHint | null): Date | null {
  const original = raw;
  const s = tidy(raw);
  const bare = original.replace(/\s+/g, ' ').trim();

  // Seulement « ce », « cet », « cette » (reste de « ce soir ») ou rien.
  if (s === '' || /^(?:ce|cet|cette)$/.test(bare)) return /^(?:ce|cet|cette)?$/.test(bare) ? today : null;
  if (/^(?:aujourd'?hui|auj|ce jour|today)$/.test(s)) return today;
  if (s === 'maintenant') return startOfDay(now);
  if (s === 'demain' || s === 'dem') return addDays(today, 1);
  if (/^apres[ -]?demain$/.test(s)) return addDays(today, 2);
  if (s === 'hier') return addDays(today, -1);
  if (/^avant[ -]?hier$/.test(s)) return addDays(today, -2);

  // Périodes : « semaine prochaine », « mois dernier », « l'an prochain », « fin du mois ».
  let m = /^(semaine|mois|annee|an)\s+(prochaine?|suivante?|derniere?|dernier|passee?)$/.exec(s);
  if (m) {
    const sign = /^(?:proch|suiv)/.test(m[2]!) ? 1 : -1;
    if (m[1] === 'semaine') return addDays(today, 7 * sign);
    if (m[1] === 'mois') return addMonths(today, sign);
    return addMonths(today, 12 * sign);
  }
  if (/^fin\s+(?:du|de)\s+mois$/.test(s)) return new Date(today.getFullYear(), today.getMonth() + 1, 0);
  if (/^fin\s+(?:du|de)\s+mois\s+prochain$/.test(s)) return new Date(today.getFullYear(), today.getMonth() + 2, 0);
  m = /^(?:week-?end|weekend)(?:\s+(prochain|suivant))?$/.exec(s);
  if (m) {
    if (!m[1]) return nextWeekday(today, 6, true);
    return addDays(mondayOf(today), 7 + 5);
  }

  // « dans 3 jours », « dans une semaine », « il y a 2 mois », « dans huit jours ».
  m = /^(dans|il y a)\s+(\d{1,3}|[a-z]+)\s+(jours?|j|semaines?|sem|mois|ans?|annees?|quinzaines?)$/.exec(s);
  if (m) {
    const n0 = count(m[2]!);
    if (n0 === null) return null;
    const unit = m[3]!;
    let n = n0;
    // Usage : « dans huit jours » = une semaine, « dans quinze jours » = deux semaines.
    const written = !/^\d/.test(m[2]!);
    if (written && /^jours?$/.test(unit)) {
      if (n === 8) n = 7;
      else if (n === 15) n = 14;
    }
    const sign = m[1] === 'dans' ? 1 : -1;
    if (/^(?:jours?|j)$/.test(unit)) return addDays(today, sign * n);
    if (/^(?:semaines?|sem)$/.test(unit)) return addDays(today, sign * n * 7);
    if (/^quinzaines?$/.test(unit)) return addDays(today, sign * n * 14);
    if (unit === 'mois') return addMonths(today, sign * n);
    return addMonths(today, sign * n * 12);
  }
  m = /^dans\s+une\s+quinzaine$/.exec(s);
  if (m) return addDays(today, 14);

  // Jour de semaine : « lundi », « lun. », « vendredi prochain », « mardi dernier »,
  // « ce jeudi », « lundi de la semaine prochaine », « mercredi en huit ».
  const wd = parseWeekday(s, original, today);
  if (wd) return wd;

  // ISO « 2026-11-12 ».
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return validDay(Number(m[1]), Number(m[2]) - 1, Number(m[3]));

  // « 12/11 », « 12/11/2026 », « 12.11.26 », « 12-11-2026 », avec jour de semaine facultatif devant.
  m = /^(?:([a-z]+)\.?\s+)?(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}|\d{2}))?$/.exec(s);
  if (m && (m[1] === undefined || WEEKDAYS.has(m[1]))) {
    const day = Number(m[2]);
    const month = Number(m[3]) - 1;
    if (m[4]) {
      const year = m[4].length === 2 ? 2000 + Number(m[4]) : Number(m[4]);
      return validDay(year, month, day);
    }
    return hint ? validDay(hint.year, month, day) : withoutYear(month, day, today);
  }

  // « 12 nov », « 12 novembre 2027 », « 1er mai », « lundi 12 novembre », « ven. 12 nov. ».
  m = /^(?:([a-z]+)\.?\s+)?(\d{1,2})(?:er)?\s+([a-z]+)\.?(?:\s+(?:'\s?)?(\d{4}|\d{2}))?$/.exec(s);
  if (m && (m[1] === undefined || WEEKDAYS.has(m[1]))) {
    const month = MONTHS.get(m[3]!);
    if (month === undefined) return null;
    const day = Number(m[2]);
    if (m[4]) {
      // Deux chiffres : seulement avec une apostrophe (« 12 nov '27 »), sinon ambigu avec une heure.
      if (m[4].length === 2 && !/'/.test(s)) return null;
      const year = m[4].length === 2 ? 2000 + Number(m[4]) : Number(m[4]);
      return validDay(year, month, day);
    }
    return hint ? validDay(hint.year, month, day) : withoutYear(month, day, today);
  }

  // « le 15 », « 15 » : prochain quantième.
  m = /^(?:[a-z]+\.?\s+)?(\d{1,2})(?:er)?$/.exec(s);
  if (m) {
    const first = /^([a-z]+)/.exec(s)?.[1];
    if (first && !WEEKDAYS.has(first)) return null;
    const day = Number(m[1]);
    if (day < 1 || day > 31) return null;
    if (hint) return validDay(hint.year, hint.month, day);
    return nextDayOfMonth(today, day);
  }
  return null;
}

function parseWeekday(s: string, original: string, today: Date): Date | null {
  const m =
    /^([a-z]+)\.?(?:\s+(prochain|suivant|dernier|passe))?(?:\s+de\s+(?:la\s+)?semaine\s+(prochaine|suivante|derniere|passee)|\s+de\s+cette\s+semaine|\s+en\s+(huit|quinze))?$/.exec(
      s,
    );
  if (!m) return null;
  const weekday = WEEKDAYS.get(m[1]!);
  if (weekday === undefined) return null;
  // « mar » seul est ambigu avec mars : en première position d'une phrase il reste « mardi ».
  const pointed = /^(?:ce|cet|cette)\s/.test(original.trim());
  const dir = m[2];
  const weekOf = m[3];
  const thisWeek = /de cette semaine$/.test(s);
  const monday = mondayOf(today);
  const offset = (weekday + 6) % 7; // 0 = lundi
  if (weekOf) return addDays(monday, offset + (/^(?:proch|suiv)/.test(weekOf) ? 7 : -7));
  if (thisWeek) return addDays(monday, offset);
  if (m[4]) return addDays(nextWeekday(today, weekday, false), 7);
  if (dir === 'dernier' || dir === 'passe') return previousWeekday(today, weekday);
  return nextWeekday(today, weekday, pointed && !dir);
}

// ---------------------------------------------------------------------------
// Expression complète
// ---------------------------------------------------------------------------

/** « dans 2 h », « dans 45 minutes », « il y a 3 heures » : durée à partir de maintenant. */
function parseShortDuration(s: string, now: Date): Parsed | null {
  const m = /^(dans|il y a)\s+(\d{1,3}|[a-z]+)\s*(heures?|h|minutes?|min)$/.exec(s);
  if (!m) return null;
  const n = count(m[2]!);
  if (n === null) return null;
  const minutes = /^(?:heures?|h)$/.test(m[3]!) ? n * 60 : n;
  const at = new Date(now.getTime() + (m[1] === 'dans' ? 1 : -1) * minutes * 60_000);
  return { day: startOfDay(at), time: { h: at.getHours(), m: at.getMinutes() }, endTime: null };
}

function parseSingle(s: string, now: Date, today: Date, hint: DayHint | null): Parsed | null {
  const short = parseShortDuration(s, now);
  if (short) return short;
  const { rest, time, endTime, invalid } = extractTime(s);
  if (invalid) return null;
  if (!time && rest === '') return null;
  const day = parseDay(rest, today, now, hint);
  if (!day) return null;
  if (rest === 'maintenant' && !time) return { day, time: { h: now.getHours(), m: now.getMinutes() }, endTime: null };
  return { day, time, endTime };
}

function build(p: Parsed): Date {
  return p.time ? new Date(p.day.getFullYear(), p.day.getMonth(), p.day.getDate(), p.time.h, p.time.m) : p.day;
}

const RANGE_SEPARATORS: RegExp[] = [/\s+(?:au|jusqu'?au?)\s+/, /\s*(?:→|->)\s*/, /\s+-\s+/, /-/, /\s+a\s+/];

/**
 * Interprète une date en français. `now` fixe « maintenant » (tests) ; le fuseau est celui du
 * système. Renvoie null quand rien ne correspond.
 */
export function parseNaturalDate(input: string, now: Date = new Date()): NaturalDate | null {
  if (typeof input !== 'string' || input.length > MAX_INPUT) return null;
  const s = normalize(input);
  if (!s) return null;
  const today = startOfDay(now);

  const single = parseSingle(s, now, today, null);
  if (single) return finish(single);

  // Plages de jours : « du 12 au 14 nov », « 12-14 novembre », « lundi au vendredi ».
  const body = s.replace(/^(?:du|de|entre le|entre)\s+/, '').replace(/^le\s+/, '');
  for (const sep of RANGE_SEPARATORS) {
    const parts = body.split(sep);
    if (parts.length !== 2) continue;
    const [left, right] = [parts[0]!.trim(), parts[1]!.trim().replace(/^le\s+/, '')];
    if (!left || !right) continue;
    // « du lundi au vendredi » : le jour de semaine de fin se compte à partir du début.
    const endWeekday = WEEKDAYS.get(tidy(right).replace(/\.$/, ''));
    let r: Parsed | null;
    let l: Parsed | null;
    if (endWeekday !== undefined) {
      l = parseSingle(left, now, today, null);
      if (!l) continue;
      r = { day: nextWeekday(l.day, endWeekday, true), time: null, endTime: null };
    } else {
      r = parseSingle(right, now, today, null);
      if (!r) continue;
      l = parseSingle(left, now, today, { month: r.day.getMonth(), year: r.day.getFullYear() });
      if (!l) continue;
    }
    // Une borne gauche sans mois ni année (« du 28 au 2 nov ») prend le mois précédent si besoin.
    let start = build({ ...l, time: l.time ?? null });
    const rightStart = build(r);
    if (l.day.getTime() > r.day.getTime()) {
      const lastMonth = addMonths(l.day, -1);
      if (/^\d{1,2}(?:er)?$/.test(tidy(left))) l = { ...l, day: lastMonth };
      else if (!/\d{4}/.test(left)) l = { ...l, day: addMonths(l.day, -12) };
      start = build(l);
    }
    if (start.getTime() > rightStart.getTime()) continue;
    return { start, end: rightStart, hasTime: !!l.time || !!r.time };
  }
  return null;
}

function finish(p: Parsed): NaturalDate {
  const start = build(p);
  if (p.time && p.endTime) {
    let end = new Date(p.day.getFullYear(), p.day.getMonth(), p.day.getDate(), p.endTime.h, p.endTime.m);
    if (end.getTime() <= start.getTime()) end = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1, p.endTime.h, p.endTime.m);
    return { start, end, hasTime: true };
  }
  return { start, end: null, hasTime: !!p.time };
}

// ---------------------------------------------------------------------------
// Sorties
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');

/** Date locale « AAAA-MM-JJ ». */
export function naturalDayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Valeur de propriété date (`DateValue`) : jour seul « AAAA-MM-JJ », ou ISO complet avec heure. */
export function naturalDateToValue(r: NaturalDate): { start: string; end?: string; includeTime?: boolean } {
  const ser = (d: Date) => (r.hasTime ? d.toISOString() : naturalDayKey(d));
  const out: { start: string; end?: string; includeTime?: boolean } = { start: ser(r.start) };
  if (r.end) out.end = ser(r.end);
  if (r.hasTime) out.includeTime = true;
  return out;
}

const longDay = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

/** « vendredi 20 novembre 2026 à 14:00 », « du 12 au 14 novembre 2026 ». */
export function describeNaturalDate(r: NaturalDate): string {
  const time = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = r.end && naturalDayKey(r.end) === naturalDayKey(r.start);
  if (!r.end || sameDay) {
    const base = longDay.format(r.start);
    if (!r.hasTime) return base;
    return r.end ? `${base} de ${time(r.start)} à ${time(r.end)}` : `${base} à ${time(r.start)}`;
  }
  const a = r.hasTime ? `${longDay.format(r.start)} ${time(r.start)}` : longDay.format(r.start);
  const b = r.hasTime ? `${longDay.format(r.end)} ${time(r.end)}` : longDay.format(r.end);
  return `${a} → ${b}`;
}
