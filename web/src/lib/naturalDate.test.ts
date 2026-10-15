import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeNaturalDate, naturalDateToValue, parseNaturalDate } from './naturalDate';

// « Maintenant » : jeudi 15 octobre 2026, 10:30, dans le fuseau du processus.
const NOW = new Date(2026, 9, 15, 10, 30);

const pad = (n: number) => String(n).padStart(2, '0');
const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtT = (d: Date) => `${fmt(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Début au format « AAAA-MM-JJ » (jour seul) ou « AAAA-MM-JJ HH:mm » (avec heure). */
function p(input: string, now: Date = NOW): string | null {
  const r = parseNaturalDate(input, now);
  if (!r) return null;
  return r.hasTime ? fmtT(r.start) : fmt(r.start);
}

function range(input: string, now: Date = NOW): [string, string] | null {
  const r = parseNaturalDate(input, now);
  if (!r || !r.end) return null;
  return r.hasTime ? [fmtT(r.start), fmtT(r.end)] : [fmt(r.start), fmt(r.end)];
}

test('mots simples', () => {
  assert.equal(p('aujourd’hui'), '2026-10-15');
  assert.equal(p("aujourd'hui"), '2026-10-15');
  assert.equal(p('Aujourdhui'), '2026-10-15');
  assert.equal(p('demain'), '2026-10-16');
  assert.equal(p('Demain'), '2026-10-16');
  assert.equal(p('après-demain'), '2026-10-17');
  assert.equal(p('apres demain'), '2026-10-17');
  assert.equal(p('hier'), '2026-10-14');
  assert.equal(p('avant-hier'), '2026-10-13');
  assert.equal(p('  demain  '), '2026-10-16');
});

test('jours de la semaine : prochaine occurrence, aujourd’hui exclu', () => {
  // Jeudi 15 octobre 2026.
  assert.equal(p('vendredi'), '2026-10-16');
  assert.equal(p('vendredi prochain'), '2026-10-16');
  assert.equal(p('lundi'), '2026-10-19');
  assert.equal(p('lundi prochain'), '2026-10-19');
  assert.equal(p('jeudi'), '2026-10-22');
  assert.equal(p('jeudi prochain'), '2026-10-22');
  assert.equal(p('dimanche'), '2026-10-18');
  assert.equal(p('ven.'), '2026-10-16');
  assert.equal(p('lun'), '2026-10-19');
  assert.equal(p('MERCREDI'), '2026-10-21');
});

test('« ce » inclut aujourd’hui, « dernier » regarde en arrière', () => {
  assert.equal(p('ce jeudi'), '2026-10-15');
  assert.equal(p('ce vendredi'), '2026-10-16');
  assert.equal(p('jeudi dernier'), '2026-10-08');
  assert.equal(p('lundi dernier'), '2026-10-12');
  assert.equal(p('vendredi passé'), '2026-10-09');
});

test('jour de la semaine et semaine (lundi à dimanche)', () => {
  assert.equal(p('lundi de la semaine prochaine'), '2026-10-19');
  assert.equal(p('vendredi de la semaine prochaine'), '2026-10-23');
  assert.equal(p('lundi de cette semaine'), '2026-10-12');
  assert.equal(p('dimanche de cette semaine'), '2026-10-18');
  assert.equal(p('mardi de la semaine dernière'), '2026-10-06');
  assert.equal(p('mercredi en huit'), '2026-10-28');
});

test('périodes', () => {
  assert.equal(p('semaine prochaine'), '2026-10-22');
  assert.equal(p('la semaine prochaine'), '2026-10-22');
  assert.equal(p('la semaine dernière'), '2026-10-08');
  assert.equal(p('le mois prochain'), '2026-11-15');
  assert.equal(p('mois dernier'), '2026-09-15');
  assert.equal(p("l'année prochaine"), '2027-10-15');
  assert.equal(p("l'an prochain"), '2027-10-15');
  assert.equal(p('fin du mois'), '2026-10-31');
  assert.equal(p('fin du mois prochain'), '2026-11-30');
  assert.equal(p('week-end'), '2026-10-17');
  assert.equal(p('ce weekend'), '2026-10-17');
  assert.equal(p('week-end prochain'), '2026-10-24');
});

test('durées « dans N … » et « il y a N … »', () => {
  assert.equal(p('dans 3 jours'), '2026-10-18');
  assert.equal(p('dans 3 j'), '2026-10-18');
  assert.equal(p('dans trois jours'), '2026-10-18');
  assert.equal(p('dans 1 jour'), '2026-10-16');
  assert.equal(p('dans un jour'), '2026-10-16');
  assert.equal(p('dans 2 semaines'), '2026-10-29');
  assert.equal(p('dans une semaine'), '2026-10-22');
  assert.equal(p('dans 1 mois'), '2026-11-15');
  assert.equal(p('dans 2 mois'), '2026-12-15');
  assert.equal(p('dans un an'), '2027-10-15');
  assert.equal(p('dans 10 jours'), '2026-10-25');
  assert.equal(p('il y a 3 jours'), '2026-10-12');
  assert.equal(p('il y a 2 semaines'), '2026-10-01');
  assert.equal(p('il y a un mois'), '2026-09-15');
  assert.equal(p('dans une quinzaine'), '2026-10-29');
});

test('usage : « dans huit jours » = 7, « dans quinze jours » = 14, mais en chiffres littéral', () => {
  assert.equal(p('dans huit jours'), '2026-10-22');
  assert.equal(p('dans quinze jours'), '2026-10-29');
  assert.equal(p('dans 8 jours'), '2026-10-23');
  assert.equal(p('dans 15 jours'), '2026-10-30');
});

test('mois : le quantième est ramené à la fin du mois si besoin', () => {
  const jan31 = new Date(2026, 0, 31, 9, 0);
  assert.equal(p('dans 1 mois', jan31), '2026-02-28');
  assert.equal(p('le mois prochain', jan31), '2026-02-28');
  const leap = new Date(2028, 0, 31, 9, 0);
  assert.equal(p('dans 1 mois', leap), '2028-02-29');
  assert.equal(p("l'année prochaine", new Date(2028, 1, 29)), '2029-02-28');
});

test('dates avec mois en lettres', () => {
  assert.equal(p('12 nov'), '2026-11-12');
  assert.equal(p('12 nov.'), '2026-11-12');
  assert.equal(p('12 novembre'), '2026-11-12');
  assert.equal(p('12 Novembre 2027'), '2027-11-12');
  assert.equal(p('1er mai'), '2027-05-01');
  assert.equal(p('1er mai 2026'), '2026-05-01');
  assert.equal(p('3 déc'), '2026-12-03');
  assert.equal(p('3 dec'), '2026-12-03');
  assert.equal(p('25 décembre'), '2026-12-25');
  assert.equal(p('14 juil'), '2027-07-14');
  assert.equal(p('29 fév 2028'), '2028-02-29');
  assert.equal(p('31 août'), '2027-08-31');
  assert.equal(p('2 sept'), '2027-09-02');
  assert.equal(p('le 12 novembre'), '2026-11-12');
  assert.equal(p('vendredi 20 novembre'), '2026-11-20');
  assert.equal(p('ven. 20 nov.'), '2026-11-20');
});

test('année omise : cette année tant que la date n’est pas passée depuis plus d’un mois', () => {
  assert.equal(p('1 oct'), '2026-10-01');
  assert.equal(p('1 sept'), '2027-09-01');
  assert.equal(p('14 sept'), '2026-09-14');
  assert.equal(p('13 sept'), '2027-09-13');
  assert.equal(p('15 sept'), '2026-09-15');
  assert.equal(p('1 janv'), '2027-01-01');
});

test('dates invalides', () => {
  assert.equal(p('31 novembre'), null);
  assert.equal(p('30 fév'), null);
  assert.equal(p('32 mars'), null);
  assert.equal(p('29 fév 2027'), null);
  assert.equal(p('12 truc'), null);
  assert.equal(p('0 nov'), null);
});

test('dates numériques', () => {
  assert.equal(p('12/11'), '2026-11-12');
  assert.equal(p('12/11/2026'), '2026-11-12');
  assert.equal(p('12/11/27'), '2027-11-12');
  assert.equal(p('12.11.2026'), '2026-11-12');
  assert.equal(p('12-11-2026'), '2026-11-12');
  assert.equal(p('2026-11-12'), '2026-11-12');
  assert.equal(p('1/2'), '2027-02-01');
  assert.equal(p('31/12'), '2026-12-31');
  assert.equal(p('31/02'), null);
  assert.equal(p('13/13/2026'), null);
  assert.equal(p('lundi 16/11'), '2026-11-16');
});

test('quantième seul : prochaine occurrence', () => {
  assert.equal(p('le 15'), '2026-10-15');
  assert.equal(p('le 20'), '2026-10-20');
  assert.equal(p('le 3'), '2026-11-03');
  assert.equal(p('25'), '2026-10-25');
  assert.equal(p('le 1er'), '2026-11-01');
  // Le 31 saute les mois de 30 jours (novembre).
  assert.equal(p('le 31'), '2026-10-31');
  assert.equal(p('le 31', new Date(2026, 10, 1)), '2026-12-31');
  assert.equal(p('le 30', new Date(2026, 0, 31)), '2026-03-30');
  assert.equal(p('le 32'), null);
  assert.equal(p('le 0'), null);
});

test('heures', () => {
  assert.equal(p('14h'), '2026-10-15 14:00');
  assert.equal(p('14h30'), '2026-10-15 14:30');
  assert.equal(p('14 h 30'), '2026-10-15 14:30');
  assert.equal(p('14:30'), '2026-10-15 14:30');
  assert.equal(p('à 9h'), '2026-10-15 09:00');
  assert.equal(p('9 heures'), '2026-10-15 09:00');
  assert.equal(p('0h15'), '2026-10-15 00:15');
  assert.equal(p('23h59'), '2026-10-15 23:59');
  assert.equal(p('24h'), null);
  assert.equal(p('12h60'), null);
  assert.equal(p('midi'), '2026-10-15 12:00');
  assert.equal(p('minuit'), '2026-10-15 00:00');
  assert.equal(p('midi et demi'), '2026-10-15 12:30');
  assert.equal(p('14h et demie'), '2026-10-15 14:30');
  assert.equal(p('14h et quart'), '2026-10-15 14:15');
  assert.equal(p('14h moins le quart'), '2026-10-15 13:45');
  assert.equal(p('15h moins 10'), '2026-10-15 14:50');
  assert.equal(p('3 h de l’après-midi'), '2026-10-15 15:00');
  assert.equal(p('9h du matin'), '2026-10-15 09:00');
  assert.equal(p('8h du soir'), '2026-10-15 20:00');
});

test('jour + heure', () => {
  assert.equal(p('lundi 14h'), '2026-10-19 14:00');
  assert.equal(p('lundi à 14h'), '2026-10-19 14:00');
  assert.equal(p('lundi 14h30'), '2026-10-19 14:30');
  assert.equal(p('demain 9h'), '2026-10-16 09:00');
  assert.equal(p('demain à 9h'), '2026-10-16 09:00');
  assert.equal(p('14h demain'), '2026-10-16 14:00');
  assert.equal(p('12 nov 18h30'), '2026-11-12 18:30');
  assert.equal(p('le 12 novembre à 14h'), '2026-11-12 14:00');
  assert.equal(p('12/11 à 8h'), '2026-11-12 08:00');
  assert.equal(p('dans 3 jours à 14h'), '2026-10-18 14:00');
  assert.equal(p('vendredi prochain 17h'), '2026-10-16 17:00');
  assert.equal(p('demain midi'), '2026-10-16 12:00');
});

test('moments de la journée', () => {
  assert.equal(p('ce soir'), '2026-10-15 19:00');
  assert.equal(p('demain matin'), '2026-10-16 09:00');
  assert.equal(p('demain soir'), '2026-10-16 19:00');
  assert.equal(p('cet après-midi'), '2026-10-15 15:00');
  assert.equal(p('lundi matin'), '2026-10-19 09:00');
  assert.equal(p('ce matin'), '2026-10-15 09:00');
});

test('durées courtes à partir de maintenant', () => {
  assert.equal(p('dans 2 h'), '2026-10-15 12:30');
  assert.equal(p('dans 2 heures'), '2026-10-15 12:30');
  assert.equal(p('dans 45 min'), '2026-10-15 11:15');
  assert.equal(p('dans 30 minutes'), '2026-10-15 11:00');
  assert.equal(p('dans une heure'), '2026-10-15 11:30');
  assert.equal(p('il y a 2 heures'), '2026-10-15 08:30');
  // Passe minuit.
  assert.equal(p('dans 14 h'), '2026-10-16 00:30');
  assert.equal(p('maintenant'), '2026-10-15 10:30');
});

test('plages de jours', () => {
  assert.deepEqual(range('du 12 au 14 nov'), ['2026-11-12', '2026-11-14']);
  assert.deepEqual(range('du 12 au 14 novembre 2027'), ['2027-11-12', '2027-11-14']);
  assert.deepEqual(range('12-14 novembre'), ['2026-11-12', '2026-11-14']);
  assert.deepEqual(range('12 au 14 nov'), ['2026-11-12', '2026-11-14']);
  assert.deepEqual(range('du 28 oct au 2 nov'), ['2026-10-28', '2026-11-02']);
  assert.deepEqual(range('du 28 au 2 nov'), ['2026-10-28', '2026-11-02']);
  assert.deepEqual(range('du lundi au vendredi'), ['2026-10-19', '2026-10-23']);
  assert.deepEqual(range('demain → dans 3 jours'), ['2026-10-16', '2026-10-18']);
  assert.deepEqual(range('12/11 - 14/11'), ['2026-11-12', '2026-11-14']);
  assert.deepEqual(range('du 28 déc au 3 janv'), ['2026-12-28', '2027-01-03']);
});

test('plages invalides ou inversées', () => {
  assert.deepEqual(range('du 14 au 12 nov'), ['2026-10-14', '2026-11-12']);
  assert.equal(parseNaturalDate('du 12 au'), null);
});

test('plages horaires', () => {
  assert.deepEqual(range('lundi 14h-16h'), ['2026-10-19 14:00', '2026-10-19 16:00']);
  assert.deepEqual(range('lundi de 14h à 16h30'), ['2026-10-19 14:00', '2026-10-19 16:30']);
  assert.deepEqual(range('demain 9h-10h'), ['2026-10-16 09:00', '2026-10-16 10:00']);
  // Fin avant le début : le lendemain.
  assert.deepEqual(range('demain 22h-2h'), ['2026-10-16 22:00', '2026-10-17 02:00']);
});

test('refus', () => {
  assert.equal(parseNaturalDate(''), null);
  assert.equal(parseNaturalDate('   '), null);
  assert.equal(parseNaturalDate('bonjour'), null);
  assert.equal(parseNaturalDate('novembre'), null);
  assert.equal(parseNaturalDate('2026'), null);
  assert.equal(parseNaturalDate('x'.repeat(500)), null);
  assert.equal(parseNaturalDate('dans 3 pommes'), null);
  assert.equal(parseNaturalDate('demain demain'), null);
});

test('frontières de mois, d’année et années bissextiles', () => {
  const dec31 = new Date(2026, 11, 31, 8, 0);
  assert.equal(p('demain', dec31), '2027-01-01');
  assert.equal(p('dans 2 jours', dec31), '2027-01-02');
  assert.equal(p('hier', new Date(2027, 0, 1)), '2026-12-31');
  assert.equal(p('demain', new Date(2028, 1, 28)), '2028-02-29');
  assert.equal(p('demain', new Date(2027, 1, 28)), '2027-03-01');
  assert.equal(p('1/1', dec31), '2027-01-01');
  assert.equal(p('dans 30 jours', new Date(2026, 0, 15)), '2026-02-14');
});

test('changement d’heure : les jours restent des jours calendaires', () => {
  // Passage à l'heure d'hiver en Europe (25 oct. 2026) : +3 jours = même heure locale, minuit.
  const before = new Date(2026, 9, 24, 12, 0);
  assert.equal(p('dans 2 jours', before), '2026-10-26');
  assert.equal(p('dans 1 semaine', before), '2026-10-31');
  const r = parseNaturalDate('dans 2 jours', before)!;
  assert.equal(r.start.getHours(), 0);
  assert.equal(r.start.getMinutes(), 0);
  // Passage à l'heure d'été (29 mars 2026).
  const spring = new Date(2026, 2, 28, 23, 0);
  assert.equal(p('demain', spring), '2026-03-29');
  assert.equal(p('après-demain', spring), '2026-03-30');
  assert.equal(p('lundi', spring), '2026-03-30');
  assert.equal(p('dans 2 jours à 9h', spring), '2026-03-30 09:00');
});

test('sérialisation en valeur de propriété date', () => {
  const day = parseNaturalDate('12 novembre 2026', NOW)!;
  assert.deepEqual(naturalDateToValue(day), { start: '2026-11-12' });
  const withTime = parseNaturalDate('12 novembre 2026 14h30', NOW)!;
  const v = naturalDateToValue(withTime);
  assert.equal(v.includeTime, true);
  // Instant ISO relu en local : même heure murale.
  assert.equal(fmtT(new Date(v.start)), '2026-11-12 14:30');
  const rng = naturalDateToValue(parseNaturalDate('du 12 au 14 nov', NOW)!);
  assert.deepEqual(rng, { start: '2026-11-12', end: '2026-11-14' });
});

test('description lisible', () => {
  assert.equal(describeNaturalDate(parseNaturalDate('vendredi 20 novembre 2026', NOW)!), 'vendredi 20 novembre 2026');
  assert.equal(describeNaturalDate(parseNaturalDate('20 novembre 2026 14h', NOW)!), 'vendredi 20 novembre 2026 à 14:00');
  assert.match(describeNaturalDate(parseNaturalDate('du 12 au 14 nov', NOW)!), /^jeudi 12 novembre 2026 → samedi 14 novembre 2026$/);
});
