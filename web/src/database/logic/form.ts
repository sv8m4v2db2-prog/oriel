// Form views: questions offered for a mode (members / anonymous visitors), conditional questions,
// client-side checks and the answers sent to POST /api/forms/:vid/submit (or the public route).
// The server applies the same rules (routes/forms.ts): this module only mirrors them for the UI.
import type { DateValue, FileValue, FormConfig, FormQuestion, PlaceValue, PropertyDef, PropertyType } from '@oriel/shared';
import { FORM_QUESTION_TYPES, PUBLIC_FORM_QUESTION_TYPES, PROPERTY_TYPE_LABELS } from '@oriel/shared';
import { parseNumberInput } from './format';
import { orderedOptions } from './values';

export type FormMode = 'member' | 'public';

export interface ResolvedQuestion {
  question: FormQuestion;
  prop: PropertyDef;
  /** Label shown (the property name by default). */
  label: string;
}

/** Answer being typed, by question id (text inputs keep their raw text until submission). */
export type FormDraft = Record<string, unknown>;

export const formTypesFor = (mode: FormMode): PropertyType[] => (mode === 'public' ? PUBLIC_FORM_QUESTION_TYPES : FORM_QUESTION_TYPES);

/** Can a property be a question of a form (any mode)? */
export const isFormQuestionType = (type: PropertyType): boolean => FORM_QUESTION_TYPES.includes(type);

/** Why a question is not offered to anonymous visitors (null when it is). */
export function publicRestriction(prop: PropertyDef): string | null {
  if (PUBLIC_FORM_QUESTION_TYPES.includes(prop.type)) return null;
  return `Les propriétés « ${PROPERTY_TYPE_LABELS[prop.type]} » ne sont posées qu’aux membres de l’espace.`;
}

/** Questions of the form that can be answered in `mode`, in order (unknown properties dropped). */
export function resolveQuestions(form: FormConfig, properties: PropertyDef[], mode: FormMode): ResolvedQuestion[] {
  const allowed = formTypesFor(mode);
  const byId = new Map(properties.map((p) => [p.id, p]));
  const out: ResolvedQuestion[] = [];
  for (const question of form.questions) {
    const prop = byId.get(question.propertyId);
    if (!prop || !allowed.includes(prop.type)) continue;
    out.push({ question, prop, label: question.label?.trim() || prop.name });
  }
  return out;
}

/** Does an answer satisfy a condition value (option id, 'true' / 'false', exact text)? Same rule as the server. */
export function conditionMatches(answer: unknown, value: string): boolean {
  if (typeof answer === 'boolean') return String(answer) === value;
  if (Array.isArray(answer)) return answer.includes(value);
  if (typeof answer === 'number') return String(answer) === value;
  return typeof answer === 'string' && answer === value;
}

/** Properties whose answers can drive a condition. */
export const canBeCondition = (prop: PropertyDef): boolean =>
  prop.type === 'select' || prop.type === 'status' || prop.type === 'multi_select' || prop.type === 'checkbox';

/** Values offered for a condition on `prop`. */
export function conditionChoices(prop: PropertyDef): Array<{ value: string; label: string }> {
  if (prop.type === 'checkbox')
    return [
      { value: 'true', label: 'Coché' },
      { value: 'false', label: 'Non coché' },
    ];
  const options = prop.type === 'status' ? orderedOptions(prop) : (prop.options ?? []);
  return options.map((o) => ({ value: o.id, label: o.name }));
}

/**
 * Is the question asked, given the answers? A condition refers to another question of the same list;
 * a missing or circular condition hides the question (as on the server).
 */
export function isQuestionVisible(q: FormQuestion, questions: readonly ResolvedQuestion[], answers: FormDraft, seen = new Set([q.id])): boolean {
  if (!q.showIf) return true;
  const cond = questions.find((x) => x.question.id === q.showIf!.questionId);
  if (!cond || seen.has(cond.question.id)) return false;
  seen.add(cond.question.id);
  return isQuestionVisible(cond.question, questions, answers, seen) && conditionMatches(answers[cond.question.id], q.showIf.value);
}

export function visibleQuestions(questions: readonly ResolvedQuestion[], answers: FormDraft): ResolvedQuestion[] {
  return questions.filter((q) => isQuestionVisible(q.question, questions, answers));
}

/** Questions that may be used as the condition of `q` (earlier, condition-capable). */
export function conditionCandidates(q: FormQuestion, questions: readonly ResolvedQuestion[]): ResolvedQuestion[] {
  const idx = questions.findIndex((x) => x.question.id === q.id);
  return questions.slice(0, idx === -1 ? questions.length : idx).filter((x) => canBeCondition(x.prop));
}

// Same rule as the server (zod's e-mail check, ASCII only): an address it refuses is reported here.
const EMAIL = /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
const PHONE = /^[0-9+().\s-]+$/;

/** Adds https:// to a web address typed without scheme. */
export function normalizeUrl(raw: string): string {
  const v = raw.trim();
  if (!v) return v;
  return /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`;
}

const isBlank = (v: unknown) =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

/** Value sent for one answer (undefined: not answered, or invalid — see validateAnswers). */
export function answerValue(prop: PropertyDef, raw: unknown): unknown {
  if (isBlank(raw)) return undefined;
  switch (prop.type) {
    case 'title':
    case 'text':
      return typeof raw === 'string' ? raw.trim() : undefined;
    case 'number': {
      if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
      const n = typeof raw === 'string' ? parseNumberInput(raw) : undefined;
      return typeof n === 'number' ? n : undefined;
    }
    case 'url':
      return typeof raw === 'string' ? normalizeUrl(raw) : undefined;
    case 'email':
    case 'phone':
      return typeof raw === 'string' ? raw.trim() : undefined;
    case 'select':
    case 'status':
      return typeof raw === 'string' ? raw : undefined;
    case 'multi_select':
    case 'person':
    case 'relation':
      return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : undefined;
    case 'checkbox':
      return raw === true;
    case 'date':
      return raw && typeof raw === 'object' && typeof (raw as DateValue).start === 'string' ? raw : undefined;
    case 'files':
      return Array.isArray(raw) ? (raw as FileValue[]) : undefined;
    case 'place': {
      const p = raw as PlaceValue;
      return p && typeof p === 'object' && typeof p.address === 'string' && p.address.trim() ? p : undefined;
    }
    default:
      return undefined;
  }
}

/** Error message per question id (required answers, formats). Hidden questions are never checked. */
export function validateAnswers(questions: readonly ResolvedQuestion[], answers: FormDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const q of visibleQuestions(questions, answers)) {
    const raw = answers[q.question.id];
    const value = answerValue(q.prop, raw);
    const empty = value === undefined || (q.prop.type === 'checkbox' && value === false);
    if (empty) {
      if (!isBlank(raw) && q.prop.type === 'number') errors[q.question.id] = 'Saisissez un nombre.';
      else if (q.question.required) errors[q.question.id] = 'Cette question est obligatoire.';
      continue;
    }
    if (q.prop.type === 'email' && !EMAIL.test(String(value))) errors[q.question.id] = 'Adresse e-mail invalide.';
    if (q.prop.type === 'phone' && !PHONE.test(String(value))) errors[q.question.id] = 'Numéro de téléphone invalide.';
    if (q.prop.type === 'url' && !/^https?:\/\/\S+$/i.test(String(value))) errors[q.question.id] = 'Adresse web invalide.';
  }
  return errors;
}

/** Answers sent to the server: visible, answered questions only (one answer per property). */
export function buildSubmission(questions: readonly ResolvedQuestion[], answers: FormDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const used = new Set<string>();
  for (const q of visibleQuestions(questions, answers)) {
    if (used.has(q.prop.id)) continue;
    // Checkboxes are always answered (unchecked = false): conditions on « Non coché » need the value.
    const value = q.prop.type === 'checkbox' ? answers[q.question.id] === true : answerValue(q.prop, answers[q.question.id]);
    if (value === undefined) continue;
    used.add(q.prop.id);
    out[q.question.id] = value;
  }
  return out;
}

/** Initial answers: checkboxes unchecked (so that « Non coché » conditions apply), the rest empty. */
export function initialDraft(questions: readonly ResolvedQuestion[]): FormDraft {
  const out: FormDraft = {};
  for (const q of questions) if (q.prop.type === 'checkbox') out[q.question.id] = false;
  return out;
}

/** Unique question id (q1, q2…). */
export function newQuestionId(form: FormConfig): string {
  const ids = new Set(form.questions.map((q) => q.id));
  for (let i = form.questions.length + 1; ; i++) if (!ids.has(`q${i}`)) return `q${i}`;
}

/** Properties that can still be added as questions (each property asked once). */
export function availableQuestionProperties(form: FormConfig, properties: PropertyDef[]): PropertyDef[] {
  const used = new Set(form.questions.map((q) => q.propertyId));
  return properties.filter((p) => isFormQuestionType(p.type) && !used.has(p.id));
}

/** Removes a question and the conditions that referred to it. */
export function removeQuestion(form: FormConfig, questionId: string): FormConfig {
  return {
    ...form,
    questions: form.questions
      .filter((q) => q.id !== questionId)
      .map((q) => (q.showIf?.questionId === questionId ? { ...q, showIf: null } : q)),
  };
}

/**
 * Moves a question up (-1) or down (+1). A condition must refer to an earlier question: conditions
 * that the move breaks are dropped.
 */
export function moveQuestion(form: FormConfig, questionId: string, delta: -1 | 1): FormConfig {
  const list = [...form.questions];
  const i = list.findIndex((q) => q.id === questionId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return form;
  [list[i], list[j]] = [list[j]!, list[i]!];
  const seen = new Set<string>();
  const questions = list.map((q) => {
    const ok = !q.showIf || seen.has(q.showIf.questionId);
    seen.add(q.id);
    return ok ? q : { ...q, showIf: null };
  });
  return { ...form, questions };
}
