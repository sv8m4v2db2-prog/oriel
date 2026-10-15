// Syntax of database formulas (SPEC §5.7): tokenizer, precedence parser and function catalogue.
// Shared by the evaluator (web/src/database/logic/formula.ts) and the rewriting of property references
// on rename (formulaReferences.ts), which both read the same syntax tree. No host code is ever run:
// functions are looked up in a closed Map, variables in lexical scopes known at parse time.

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const FORMULA_MAX_SOURCE_LENGTH = 5000;
const MAX_DEPTH = 64;

// ---------------------------------------------------------------------------
// Function catalogue
// ---------------------------------------------------------------------------

export type FormulaFunctionCategory = 'propriétés' | 'logique' | 'texte' | 'nombres' | 'dates' | 'listes' | 'variables';

export interface FormulaFunctionSpec {
  name: string;
  minArgs: number;
  maxArgs: number;
  signature: string;
  description: string;
  category: FormulaFunctionCategory;
  /** Index of the argument evaluated once per list element, with `current` and `index` in scope. */
  lambda?: number;
}

export const FORMULA_FUNCTION_SPECS: readonly FormulaFunctionSpec[] = [
  {
    name: 'prop',
    minArgs: 1,
    maxArgs: 1,
    signature: 'prop("Nom")',
    description: 'Valeur de la propriété « Nom » pour la ligne courante. Après une page (page.prop("Nom")), valeur de cette page.',
    category: 'propriétés',
  },
  {
    name: 'if',
    minArgs: 3,
    maxArgs: 3,
    signature: 'if(condition, siVrai, siFaux)',
    description: 'Renvoie siVrai si la condition est vraie, sinon siFaux.',
    category: 'logique',
  },
  {
    name: 'concat',
    minArgs: 1,
    maxArgs: Infinity,
    signature: 'concat(valeur1, valeur2, …)',
    description: 'Assemble plusieurs valeurs en un seul texte.',
    category: 'texte',
  },
  {
    name: 'length',
    minArgs: 1,
    maxArgs: 1,
    signature: 'length(texte) · liste.length()',
    description:
      'Nombre de caractères du texte (0 si vide). Sur une liste écrite liste.length(), ou sur le résultat de map(), filter()…, nombre d’éléments.',
    category: 'texte',
  },
  {
    name: 'lower',
    minArgs: 1,
    maxArgs: 1,
    signature: 'lower(texte)',
    description: 'Met le texte en minuscules.',
    category: 'texte',
  },
  {
    name: 'upper',
    minArgs: 1,
    maxArgs: 1,
    signature: 'upper(texte)',
    description: 'Met le texte en majuscules.',
    category: 'texte',
  },
  {
    name: 'round',
    minArgs: 1,
    maxArgs: 2,
    signature: 'round(nombre, décimales)',
    description: 'Arrondit au plus proche (décimales : 0 par défaut, demi vers l’extérieur).',
    category: 'nombres',
  },
  {
    name: 'floor',
    minArgs: 1,
    maxArgs: 1,
    signature: 'floor(nombre)',
    description: 'Arrondit à l’entier inférieur.',
    category: 'nombres',
  },
  {
    name: 'ceil',
    minArgs: 1,
    maxArgs: 1,
    signature: 'ceil(nombre)',
    description: 'Arrondit à l’entier supérieur.',
    category: 'nombres',
  },
  {
    name: 'abs',
    minArgs: 1,
    maxArgs: 1,
    signature: 'abs(nombre)',
    description: 'Valeur absolue d’un nombre.',
    category: 'nombres',
  },
  {
    name: 'min',
    minArgs: 1,
    maxArgs: Infinity,
    signature: 'min(valeur1, valeur2, …) · liste.min()',
    description:
      'Plus petite valeur parmi des nombres ou des dates (les valeurs vides sont ignorées, les listes sont parcourues).',
    category: 'nombres',
  },
  {
    name: 'max',
    minArgs: 1,
    maxArgs: Infinity,
    signature: 'max(valeur1, valeur2, …) · liste.max()',
    description:
      'Plus grande valeur parmi des nombres ou des dates (les valeurs vides sont ignorées, les listes sont parcourues).',
    category: 'nombres',
  },
  {
    name: 'sum',
    minArgs: 1,
    maxArgs: Infinity,
    signature: 'sum(valeur1, valeur2, …) · liste.sum()',
    description: 'Somme des nombres donnés ou contenus dans les listes ; les valeurs vides sont ignorées (0 si aucune).',
    category: 'nombres',
  },
  {
    name: 'now',
    minArgs: 0,
    maxArgs: 0,
    signature: 'now()',
    description: 'Date et heure actuelles.',
    category: 'dates',
  },
  {
    name: 'dateBetween',
    minArgs: 3,
    maxArgs: 3,
    signature: 'dateBetween(date1, date2, unité)',
    description:
      'Écart date1 − date2 en unités entières : "days", "weeks", "months", "years", "hours" ou "minutes".',
    category: 'dates',
  },
  {
    name: 'dateAdd',
    minArgs: 3,
    maxArgs: 3,
    signature: 'dateAdd(date, quantité, unité)',
    description: 'Ajoute (ou retire si négatif) une durée à une date, dans l’unité indiquée.',
    category: 'dates',
  },
  {
    name: 'format',
    minArgs: 1,
    maxArgs: 1,
    signature: 'format(valeur)',
    description: 'Convertit une valeur en texte (une liste devient ses éléments séparés par des virgules).',
    category: 'texte',
  },
  {
    name: 'empty',
    minArgs: 1,
    maxArgs: 1,
    signature: 'empty(valeur)',
    description:
      'Vrai si la valeur est vide (absente, texte sans contenu ou liste sans élément) ; 0 et faux ne sont pas vides.',
    category: 'logique',
  },
  {
    name: 'not',
    minArgs: 1,
    maxArgs: 1,
    signature: 'not(condition)',
    description: 'Inverse une condition (vrai devient faux et inversement).',
    category: 'logique',
  },
  {
    name: 'toNumber',
    minArgs: 1,
    maxArgs: 1,
    signature: 'toNumber(valeur)',
    description: 'Convertit une valeur en nombre (texte avec virgule accepté) ; vide si impossible.',
    category: 'nombres',
  },
  {
    name: 'contains',
    minArgs: 2,
    maxArgs: 2,
    signature: 'contains(texte, recherche)',
    description: 'Vrai si le texte contient la recherche, sans tenir compte de la casse.',
    category: 'texte',
  },
  // Listes
  {
    name: 'map',
    minArgs: 2,
    maxArgs: 2,
    signature: 'liste.map(expression)',
    description:
      'Calcule l’expression pour chaque élément et renvoie la liste des résultats. Dans l’expression, current désigne l’élément et index sa position (à partir de 0).',
    category: 'listes',
    lambda: 1,
  },
  {
    name: 'filter',
    minArgs: 2,
    maxArgs: 2,
    signature: 'liste.filter(condition)',
    description: 'Garde les éléments pour lesquels la condition est vraie (current, index).',
    category: 'listes',
    lambda: 1,
  },
  {
    name: 'find',
    minArgs: 2,
    maxArgs: 2,
    signature: 'liste.find(condition)',
    description: 'Premier élément pour lequel la condition est vraie ; vide si aucun.',
    category: 'listes',
    lambda: 1,
  },
  {
    name: 'findIndex',
    minArgs: 2,
    maxArgs: 2,
    signature: 'liste.findIndex(condition)',
    description: 'Position (à partir de 0) du premier élément qui vérifie la condition ; -1 si aucun.',
    category: 'listes',
    lambda: 1,
  },
  {
    name: 'some',
    minArgs: 2,
    maxArgs: 2,
    signature: 'liste.some(condition)',
    description: 'Vrai si au moins un élément vérifie la condition.',
    category: 'listes',
    lambda: 1,
  },
  {
    name: 'every',
    minArgs: 2,
    maxArgs: 2,
    signature: 'liste.every(condition)',
    description: 'Vrai si tous les éléments vérifient la condition (vrai pour une liste vide).',
    category: 'listes',
    lambda: 1,
  },
  {
    name: 'at',
    minArgs: 2,
    maxArgs: 2,
    signature: 'liste.at(position)',
    description: 'Élément à la position donnée, à partir de 0 ; une position négative compte depuis la fin. Vide hors de la liste.',
    category: 'listes',
  },
  {
    name: 'first',
    minArgs: 1,
    maxArgs: 1,
    signature: 'liste.first()',
    description: 'Premier élément de la liste ; vide si elle est vide.',
    category: 'listes',
  },
  {
    name: 'last',
    minArgs: 1,
    maxArgs: 1,
    signature: 'liste.last()',
    description: 'Dernier élément de la liste ; vide si elle est vide.',
    category: 'listes',
  },
  {
    name: 'slice',
    minArgs: 2,
    maxArgs: 3,
    signature: 'liste.slice(début, fin)',
    description: 'Éléments de la position début (incluse) à fin (exclue, fin de liste par défaut).',
    category: 'listes',
  },
  {
    name: 'sort',
    minArgs: 1,
    maxArgs: 2,
    signature: 'liste.sort() · liste.sort(clé)',
    description:
      'Trie la liste par ordre croissant : nombres, dates, textes, puis pages et personnes par nom. Avec une clé (current), trie selon sa valeur.',
    category: 'listes',
    lambda: 1,
  },
  {
    name: 'reverse',
    minArgs: 1,
    maxArgs: 1,
    signature: 'liste.reverse()',
    description: 'Inverse l’ordre des éléments (avec sort(), tri décroissant).',
    category: 'listes',
  },
  {
    name: 'unique',
    minArgs: 1,
    maxArgs: 1,
    signature: 'liste.unique()',
    description: 'Retire les doublons en gardant la première occurrence.',
    category: 'listes',
  },
  {
    name: 'flat',
    minArgs: 1,
    maxArgs: 1,
    signature: 'liste.flat()',
    description: 'Remplace chaque sous-liste par ses éléments (un niveau).',
    category: 'listes',
  },
  {
    name: 'join',
    minArgs: 1,
    maxArgs: 2,
    signature: 'liste.join(séparateur)',
    description: 'Assemble les éléments en un texte, séparés par le séparateur (", " par défaut).',
    category: 'listes',
  },
  {
    name: 'includes',
    minArgs: 2,
    maxArgs: 2,
    signature: 'liste.includes(valeur)',
    description: 'Vrai si la liste contient la valeur.',
    category: 'listes',
  },
  {
    name: 'name',
    minArgs: 1,
    maxArgs: 1,
    signature: 'personne.name()',
    description: 'Nom d’une personne, ou titre d’une page.',
    category: 'listes',
  },
  {
    name: 'email',
    minArgs: 1,
    maxArgs: 1,
    signature: 'personne.email()',
    description: 'Adresse e-mail d’une personne, quand elle est connue.',
    category: 'listes',
  },
  // Variables
  {
    name: 'let',
    minArgs: 3,
    maxArgs: 3,
    signature: 'let(nom, valeur, expression)',
    description: 'Calcule la valeur une fois, la nomme, puis renvoie l’expression qui peut utiliser ce nom.',
    category: 'variables',
  },
  {
    name: 'lets',
    minArgs: 3,
    maxArgs: Infinity,
    signature: 'lets(nom1, valeur1, nom2, valeur2, …, expression)',
    description: 'Comme let() avec plusieurs noms ; chaque valeur peut utiliser les noms définis avant elle.',
    category: 'variables',
  },
];

const FUNCTIONS_BY_KEY: ReadonlyMap<string, FormulaFunctionSpec> = new Map(
  FORMULA_FUNCTION_SPECS.map((spec) => [spec.name.toLowerCase(), spec] as const),
);

export function lookupFormulaFunction(name: string): FormulaFunctionSpec | undefined {
  return FUNCTIONS_BY_KEY.get(name.toLowerCase());
}

/** Names bound inside the per-element argument of map(), filter()… */
export const FORMULA_LAMBDA_VARIABLES = ['current', 'index'] as const;

// ---------------------------------------------------------------------------
// Date units
// ---------------------------------------------------------------------------

export type FormulaDateUnit = 'days' | 'weeks' | 'months' | 'years' | 'hours' | 'minutes';

const DATE_UNITS: ReadonlyMap<string, FormulaDateUnit> = new Map<string, FormulaDateUnit>([
  ['days', 'days'],
  ['day', 'days'],
  ['jours', 'days'],
  ['jour', 'days'],
  ['weeks', 'weeks'],
  ['week', 'weeks'],
  ['semaines', 'weeks'],
  ['semaine', 'weeks'],
  ['months', 'months'],
  ['month', 'months'],
  ['mois', 'months'],
  ['years', 'years'],
  ['year', 'years'],
  ['années', 'years'],
  ['année', 'years'],
  ['annees', 'years'],
  ['annee', 'years'],
  ['ans', 'years'],
  ['hours', 'hours'],
  ['hour', 'hours'],
  ['heures', 'hours'],
  ['heure', 'hours'],
  ['minutes', 'minutes'],
  ['minute', 'minutes'],
]);

export function lookupFormulaDateUnit(raw: string): FormulaDateUnit | undefined {
  return DATE_UNITS.get(raw.trim().toLowerCase().normalize('NFC'));
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

export type FormulaBinaryOperator = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '>' | '<=' | '>=';

export type FormulaToken =
  | { kind: 'number'; value: number; pos: number }
  /** `end`: offset just past the closing quote. */
  | { kind: 'string'; value: string; pos: number; end: number }
  | { kind: 'ident'; name: string; pos: number }
  | { kind: 'bool'; value: boolean; pos: number }
  | { kind: 'and' | 'or'; pos: number }
  /** `symbol` is true for the `!` spelling, false for the `not` keyword. */
  | { kind: 'not'; symbol: boolean; pos: number }
  | { kind: 'op'; op: FormulaBinaryOperator; pos: number }
  | { kind: '(' | ')' | ',' | '.' | '[' | ']' | 'eof'; pos: number };

export class FormulaSyntaxError extends Error {
  readonly position: number;

  constructor(message: string, position: number) {
    super(message);
    this.name = 'FormulaSyntaxError';
    this.position = position;
  }
}

function syntaxError(message: string, position: number): FormulaSyntaxError {
  return new FormulaSyntaxError(message, position);
}

const IDENT_START = /^[\p{L}_]$/u;
const IDENT_PART = /^[\p{L}\p{M}\p{N}_]$/u;
const WHITESPACE = /^\s$/u;

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9' && ch.length === 1;
}

/** Full code point (1 or 2 UTF-16 units) starting at `i`, or '' past the end. */
function codePointAt(src: string, i: number): string {
  const cp = src.codePointAt(i);
  return cp === undefined ? '' : String.fromCodePoint(cp);
}

export function tokenizeFormula(src: string): FormulaToken[] {
  const tokens: FormulaToken[] = [];
  const n = src.length;
  let i = 0;

  while (i < n) {
    const ch = src.charAt(i);

    if (WHITESPACE.test(ch)) {
      i += 1;
      continue;
    }

    // Nombres : 12, 3.5, .5, 1e3, 2.5E-1
    if (isDigit(ch) || (ch === '.' && isDigit(src.charAt(i + 1)))) {
      const start = i;
      while (isDigit(src.charAt(i))) i += 1;
      if (src.charAt(i) === '.') {
        i += 1;
        while (isDigit(src.charAt(i))) i += 1;
      }
      const e = src.charAt(i);
      if (e === 'e' || e === 'E') {
        let j = i + 1;
        const sign = src.charAt(j);
        if (sign === '+' || sign === '-') j += 1;
        if (isDigit(src.charAt(j))) {
          i = j;
          while (isDigit(src.charAt(i))) i += 1;
        }
      }
      const next = codePointAt(src, i);
      if (next === '.' || (next !== '' && IDENT_PART.test(next))) {
        throw syntaxError('Nombre invalide', start);
      }
      const value = Number(src.slice(start, i));
      if (!Number.isFinite(value)) throw syntaxError('Nombre trop grand', start);
      tokens.push({ kind: 'number', value, pos: start });
      continue;
    }

    // Chaînes : "…" ou '…'
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      let text = '';
      i += 1;
      for (;;) {
        if (i >= n) throw syntaxError('Chaîne non terminée', start);
        const c = src.charAt(i);
        if (c === quote) {
          i += 1;
          break;
        }
        if (c === '\\') {
          if (i + 1 >= n) throw syntaxError('Chaîne non terminée', start);
          const esc = src.charAt(i + 1);
          switch (esc) {
            case 'n':
              text += '\n';
              break;
            case 't':
              text += '\t';
              break;
            case '"':
            case "'":
            case '\\':
              text += esc;
              break;
            default:
              // Séquence inconnue : conservée telle quelle (ex. "C:\dossier").
              text += `\\${esc}`;
          }
          i += 2;
          continue;
        }
        text += c;
        i += 1;
      }
      tokens.push({ kind: 'string', value: text, pos: start, end: i });
      continue;
    }

    // Identifiants et mots-clés
    const cp = codePointAt(src, i);
    if (IDENT_START.test(cp)) {
      const start = i;
      while (i < n) {
        const part = codePointAt(src, i);
        if (!IDENT_PART.test(part)) break;
        i += part.length;
      }
      const word = src.slice(start, i);
      switch (word.toLowerCase()) {
        case 'true':
          tokens.push({ kind: 'bool', value: true, pos: start });
          break;
        case 'false':
          tokens.push({ kind: 'bool', value: false, pos: start });
          break;
        case 'and':
          tokens.push({ kind: 'and', pos: start });
          break;
        case 'or':
          tokens.push({ kind: 'or', pos: start });
          break;
        case 'not':
          tokens.push({ kind: 'not', symbol: false, pos: start });
          break;
        default:
          tokens.push({ kind: 'ident', name: word, pos: start });
      }
      continue;
    }

    // Opérateurs à deux caractères
    const two = src.slice(i, i + 2);
    switch (two) {
      case '==':
      case '!=':
      case '<=':
      case '>=':
        tokens.push({ kind: 'op', op: two, pos: i });
        i += 2;
        continue;
      case '<>':
        tokens.push({ kind: 'op', op: '!=', pos: i });
        i += 2;
        continue;
      case '&&':
        tokens.push({ kind: 'and', pos: i });
        i += 2;
        continue;
      case '||':
        tokens.push({ kind: 'or', pos: i });
        i += 2;
        continue;
      default:
        break;
    }

    // Opérateurs et ponctuation à un caractère
    switch (ch) {
      case '+':
      case '-':
      case '*':
      case '/':
      case '%':
      case '<':
      case '>':
        tokens.push({ kind: 'op', op: ch, pos: i });
        i += 1;
        continue;
      case '=':
        tokens.push({ kind: 'op', op: '==', pos: i });
        i += 1;
        continue;
      case '!':
        tokens.push({ kind: 'not', symbol: true, pos: i });
        i += 1;
        continue;
      case '(':
      case ')':
      case ',':
      case '.':
      case '[':
      case ']':
        tokens.push({ kind: ch, pos: i });
        i += 1;
        continue;
      default:
        throw syntaxError(`Caractère inattendu : «${cp}»`, i);
    }
  }

  tokens.push({ kind: 'eof', pos: n });
  return tokens;
}

// ---------------------------------------------------------------------------
// Syntax tree
// ---------------------------------------------------------------------------

/** Offsets of a property name literal in the source (start: opening quote, end: past the closing one). */
export interface FormulaNameSpan {
  start: number;
  end: number;
}

export type FormulaAst =
  | { k: 'lit'; value: number | string | boolean; pos: number }
  /** prop("Nom"): property of the row the formula belongs to. */
  | { k: 'prop'; name: string; span: FormulaNameSpan; pos: number }
  /** valeur.prop("Nom"): property of a page (relation element, current…). */
  | { k: 'pageProp'; target: FormulaAst; name: string; span: FormulaNameSpan; pos: number }
  | { k: 'var'; name: string; pos: number }
  | { k: 'list'; items: FormulaAst[]; pos: number }
  | { k: 'let'; names: string[]; values: FormulaAst[]; body: FormulaAst; pos: number }
  | { k: 'neg' | 'plus' | 'not'; arg: FormulaAst; pos: number }
  | { k: 'bin'; op: FormulaBinaryOperator; left: FormulaAst; right: FormulaAst; pos: number }
  | { k: 'and' | 'or'; left: FormulaAst; right: FormulaAst; pos: number }
  /** `method`: written receiver.fn(…), the receiver being args[0]. */
  | { k: 'call'; fn: string; args: FormulaAst[]; method: boolean; pos: number };

const COMPARISON_OPERATORS: ReadonlySet<FormulaBinaryOperator> = new Set<FormulaBinaryOperator>([
  '==',
  '!=',
  '<',
  '>',
  '<=',
  '>=',
]);

const PROP_ARGUMENT_MESSAGE = "prop() attend le nom d'une propriété entre guillemets";

function plural(count: number, word: string): string {
  return `${count} ${word}${count > 1 ? 's' : ''}`;
}

function arityMessage(spec: FormulaFunctionSpec, given: number): string {
  const provided = `${given} fourni${given > 1 ? 's' : ''}`;
  if (spec.maxArgs === 0) return `${spec.name}() n'attend aucun argument (${provided})`;
  if (spec.minArgs === spec.maxArgs) {
    return `${spec.name}() attend ${plural(spec.minArgs, 'argument')} (${provided})`;
  }
  if (spec.maxArgs === Infinity) {
    return `${spec.name}() attend au moins ${plural(spec.minArgs, 'argument')} (${provided})`;
  }
  return `${spec.name}() attend ${spec.minArgs} à ${spec.maxArgs} arguments (${provided})`;
}

/** Analyse par précédence (descente récursive, un niveau par priorité). */
class Parser {
  private readonly tokens: FormulaToken[];
  private readonly eof: FormulaToken;
  private index = 0;
  private depth = 0;
  /** Lexical scopes: names of let()/lets() variables and current/index inside per-element arguments. */
  private readonly scopes: string[][] = [];
  readonly references: string[] = [];

  constructor(tokens: FormulaToken[]) {
    this.tokens = tokens;
    this.eof = tokens[tokens.length - 1] ?? { kind: 'eof', pos: 0 };
  }

  parseFormula(): FormulaAst {
    const node = this.parseOr();
    const t = this.peek();
    if (t.kind !== 'eof') {
      if (t.kind === ')') throw syntaxError('Parenthèse fermante inattendue', t.pos);
      if (t.kind === ']') throw syntaxError('Crochet fermant inattendu', t.pos);
      if (t.kind === ',') throw syntaxError('Virgule inattendue', t.pos);
      throw syntaxError('Opérateur attendu', t.pos);
    }
    return node;
  }

  private peek(offset = 0): FormulaToken {
    return this.tokens[this.index + offset] ?? this.eof;
  }

  private advance(): FormulaToken {
    const t = this.peek();
    if (this.index < this.tokens.length - 1) this.index += 1;
    return t;
  }

  private enter(pos: number): void {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) {
      throw syntaxError(`Formule trop imbriquée (${MAX_DEPTH} niveaux maximum)`, pos);
    }
  }

  private leave(): void {
    this.depth -= 1;
  }

  private inScope(name: string): boolean {
    return this.scopes.some((scope) => scope.includes(name));
  }

  // or < and < not < comparaisons < + - < * / % < unaire < suffixe (.f()) < appel / primaire

  private parseOr(): FormulaAst {
    let left = this.parseAnd();
    for (let t = this.peek(); t.kind === 'or'; t = this.peek()) {
      this.advance();
      const right = this.parseAnd();
      left = { k: 'or', left, right, pos: t.pos };
    }
    return left;
  }

  private parseAnd(): FormulaAst {
    let left = this.parseNot();
    for (let t = this.peek(); t.kind === 'and'; t = this.peek()) {
      this.advance();
      const right = this.parseNot();
      left = { k: 'and', left, right, pos: t.pos };
    }
    return left;
  }

  private parseNot(): FormulaAst {
    const t = this.peek();
    // `not(` est traité comme un appel de fonction (voir parsePrimary).
    if (t.kind === 'not' && (t.symbol || this.peek(1).kind !== '(')) {
      this.advance();
      this.enter(t.pos);
      const arg = this.parseNot();
      this.leave();
      return { k: 'not', arg, pos: t.pos };
    }
    return this.parseComparison();
  }

  private parseComparison(): FormulaAst {
    let left = this.parseAdditive();
    for (let t = this.peek(); t.kind === 'op' && COMPARISON_OPERATORS.has(t.op); t = this.peek()) {
      this.advance();
      const right = this.parseAdditive();
      left = { k: 'bin', op: t.op, left, right, pos: t.pos };
    }
    return left;
  }

  private parseAdditive(): FormulaAst {
    let left = this.parseMultiplicative();
    for (let t = this.peek(); t.kind === 'op' && (t.op === '+' || t.op === '-'); t = this.peek()) {
      this.advance();
      const right = this.parseMultiplicative();
      left = { k: 'bin', op: t.op, left, right, pos: t.pos };
    }
    return left;
  }

  private parseMultiplicative(): FormulaAst {
    let left = this.parseUnary();
    for (
      let t = this.peek();
      t.kind === 'op' && (t.op === '*' || t.op === '/' || t.op === '%');
      t = this.peek()
    ) {
      this.advance();
      const right = this.parseUnary();
      left = { k: 'bin', op: t.op, left, right, pos: t.pos };
    }
    return left;
  }

  private parseUnary(): FormulaAst {
    const t = this.peek();
    if (t.kind === 'op' && (t.op === '-' || t.op === '+')) {
      this.advance();
      this.enter(t.pos);
      const arg = this.parseUnary();
      this.leave();
      return { k: t.op === '-' ? 'neg' : 'plus', arg, pos: t.pos };
    }
    return this.parsePostfix();
  }

  /** Primary followed by `.fn(…)` / `.prop("Nom")` suffixes. */
  private parsePostfix(): FormulaAst {
    let node = this.parsePrimary();
    let suffixes = 0;
    for (let dot = this.peek(); dot.kind === '.'; dot = this.peek()) {
      const name = this.peek(1);
      if (name.kind !== 'ident') throw syntaxError('Nom de fonction attendu après le point', name.pos);
      this.advance(); // .
      this.enter(dot.pos);
      suffixes += 1;
      node = this.parseCall(name.name, name.pos, node);
    }
    for (; suffixes > 0; suffixes -= 1) this.leave();
    return node;
  }

  private parsePrimary(): FormulaAst {
    const t = this.peek();
    switch (t.kind) {
      case 'number':
      case 'string':
      case 'bool':
        this.advance();
        return { k: 'lit', value: t.value, pos: t.pos };
      case '(': {
        this.advance();
        this.enter(t.pos);
        const inner = this.parseOr();
        const close = this.peek();
        if (close.kind !== ')') throw syntaxError('Parenthèse fermante attendue', close.pos);
        this.advance();
        this.leave();
        return inner;
      }
      case '[': {
        this.advance();
        this.enter(t.pos);
        const items: FormulaAst[] = [];
        if (this.peek().kind !== ']') {
          for (;;) {
            items.push(this.parseOr());
            if (this.peek().kind !== ',') break;
            this.advance();
          }
        }
        const close = this.peek();
        if (close.kind !== ']') throw syntaxError('Crochet fermant attendu', close.pos);
        this.advance();
        this.leave();
        return { k: 'list', items, pos: t.pos };
      }
      case 'ident':
        if (this.peek(1).kind !== '(' && this.inScope(t.name)) {
          this.advance();
          return { k: 'var', name: t.name, pos: t.pos };
        }
        return this.parseCall(t.name, t.pos, null);
      case 'not':
        // Forme fonction `not(x)` ; sinon un `not`/`!` en position d'opérande
        // (ex. `1 + not x`) est ambigu : on demande des parenthèses.
        if (!t.symbol && this.peek(1).kind === '(') return this.parseCall('not', t.pos, null);
        throw syntaxError(`Parenthèses nécessaires autour de « ${t.symbol ? '!' : 'not'} »`, t.pos);
      default:
        throw syntaxError('Expression attendue', t.pos);
    }
  }

  /** `receiver` is set for the suffix form receiver.name(…). The current token is `name`. */
  private parseCall(name: string, pos: number, receiver: FormulaAst | null): FormulaAst {
    const spec = lookupFormulaFunction(name);
    const open = this.peek(1);
    if (open.kind !== '(') {
      if (spec) throw syntaxError(`Parenthèse ouvrante attendue après ${spec.name}`, open.pos);
      if (!receiver && (FORMULA_LAMBDA_VARIABLES as readonly string[]).includes(name)) {
        throw syntaxError(`«${name}» ne s'utilise que dans map(), filter() et les fonctions de liste semblables`, pos);
      }
      if (receiver) throw syntaxError(`Fonction inconnue : ${name}`, pos);
      throw syntaxError(`Nom inconnu : «${name}» (utilisez prop("${name}") pour lire une propriété)`, pos);
    }
    if (!spec) throw syntaxError(`Fonction inconnue : ${name}`, pos);

    this.advance(); // nom
    this.advance(); // (
    this.enter(pos);

    if (spec.name === 'prop') {
      const arg = this.peek();
      if (arg.kind !== 'string') throw syntaxError(PROP_ARGUMENT_MESSAGE, arg.pos);
      const close = this.peek(1);
      if (close.kind !== ')') throw syntaxError(PROP_ARGUMENT_MESSAGE, close.pos);
      this.advance();
      this.advance();
      this.leave();
      const span = { start: arg.pos, end: arg.end };
      if (receiver) return { k: 'pageProp', target: receiver, name: arg.value, span, pos };
      if (!this.references.includes(arg.value)) this.references.push(arg.value);
      return { k: 'prop', name: arg.value, span, pos };
    }

    if (spec.name === 'let' || spec.name === 'lets') {
      if (receiver) throw syntaxError(`${spec.name}() ne s'utilise pas après un point`, pos);
      return this.parseLet(spec, pos);
    }

    const args: FormulaAst[] = receiver ? [receiver] : [];
    if (this.peek().kind !== ')') {
      for (;;) {
        const lambda = spec.lambda !== undefined && args.length === spec.lambda;
        if (lambda) this.scopes.push([...FORMULA_LAMBDA_VARIABLES]);
        args.push(this.parseOr());
        if (lambda) this.scopes.pop();
        if (this.peek().kind !== ',') break;
        this.advance();
      }
    }
    const close = this.peek();
    if (close.kind !== ')') throw syntaxError('Parenthèse fermante attendue', close.pos);
    this.advance();
    this.leave();

    if (args.length < spec.minArgs || args.length > spec.maxArgs) {
      throw syntaxError(arityMessage(spec, args.length), pos);
    }

    // Unité littérale vérifiée dès la compilation pour guider l'utilisateur.
    if (spec.name === 'dateBetween' || spec.name === 'dateAdd') {
      const unit = args[2];
      if (unit && unit.k === 'lit' && typeof unit.value === 'string' && !lookupFormulaDateUnit(unit.value)) {
        throw syntaxError(
          `Unité inconnue : «${unit.value}» (days, weeks, months, years, hours ou minutes)`,
          unit.pos,
        );
      }
    }

    return { k: 'call', fn: spec.name, args, method: receiver !== null, pos };
  }

  /** let(nom, valeur, expression) / lets(nom1, valeur1, …, expression); the current token follows `(`. */
  private parseLet(spec: FormulaFunctionSpec, pos: number): FormulaAst {
    const names: string[] = [];
    const values: FormulaAst[] = [];
    const scope: string[] = [];
    this.scopes.push(scope);
    let body: FormulaAst | null = null;
    for (;;) {
      const t = this.peek();
      // A name followed by a comma starts a binding; anything else is the final expression.
      if (t.kind === 'ident' && this.peek(1).kind === ',' && (names.length === 0 || spec.name === 'lets')) {
        if (lookupFormulaFunction(t.name) || (FORMULA_LAMBDA_VARIABLES as readonly string[]).includes(t.name)) {
          throw syntaxError(`«${t.name}» est réservé et ne peut pas nommer une variable`, t.pos);
        }
        this.advance();
        this.advance();
        names.push(t.name);
        values.push(this.parseOr());
        scope.push(t.name);
        const sep = this.peek();
        if (sep.kind !== ',') {
          if (sep.kind === ')') throw syntaxError(`${spec.name}() attend une expression après la dernière valeur`, sep.pos);
          throw syntaxError('Virgule attendue', sep.pos);
        }
        this.advance();
        continue;
      }
      if (names.length === 0) throw syntaxError(`${spec.name}() attend un nom de variable en premier argument`, t.pos);
      body = this.parseOr();
      break;
    }
    this.scopes.pop();
    const close = this.peek();
    if (close.kind === ',') throw syntaxError(arityMessage(spec, names.length * 2 + 2), pos);
    if (close.kind !== ')') throw syntaxError('Parenthèse fermante attendue', close.pos);
    this.advance();
    this.leave();
    return { k: 'let', names, values, body, pos };
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface ParsedFormula {
  /** null when the source is empty or invalid. */
  ast: FormulaAst | null;
  error: { message: string; position: number } | null;
  /** Names read through prop("…") on the formula's own row, deduplicated, in order of appearance. */
  references: string[];
}

export function parseFormulaSource(source: string): ParsedFormula {
  const src = typeof source === 'string' ? source : '';
  if (src.length > FORMULA_MAX_SOURCE_LENGTH) {
    return {
      ast: null,
      error: {
        message: `Formule trop longue (${FORMULA_MAX_SOURCE_LENGTH} caractères maximum)`,
        position: FORMULA_MAX_SOURCE_LENGTH,
      },
      references: [],
    };
  }
  if (src.trim() === '') return { ast: null, error: null, references: [] };
  try {
    const parser = new Parser(tokenizeFormula(src));
    const ast = parser.parseFormula();
    return { ast, error: null, references: [...parser.references] };
  } catch (e) {
    const error =
      e instanceof FormulaSyntaxError
        ? { message: e.message, position: e.position }
        : { message: 'Formule invalide', position: 0 };
    return { ast: null, error, references: [] };
  }
}
