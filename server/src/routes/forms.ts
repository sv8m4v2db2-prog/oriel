// Database forms (view type 'form') — SECURITY-SENSITIVE: the public route is an anonymous write path.
//
//  - POST /api/forms/:vid/submit          workspace members who can read the database (viewers included)
//  - GET  /api/public/forms/:vid          anonymous: definition of a form explicitly shared (`form.isPublic`),
//                                         questions of public types and their properties only, never rows
//  - POST /api/public/forms/:vid/submit   anonymous, only for a form explicitly shared (`form.isPublic`)
//                                         and open (`acceptResponses`) whose database is live
//
// A public form does not require its database to be published (QA-VIEW-04): publishing the database
// would expose every answer (e-mails, phones) to anyone with its link. Its database and ancestors must
// not be trashed nor kept private by a registered exclusion (row templates): see shareableChain.
// Both create one row in the form's database (from its default template when there is one) and notify
// the database owner through the notification system. Values: only the questions of the form
// (allowlist), each shape-checked with zod then validated by validateValue; anonymous answers are
// limited to simple types (no people, relations, files, places, computed types). The public route
// ignores the session cookie, answers a bare confirmation, is rate limited per client address and capped
// per form per hour and per day, has a body size cap and a honeypot field (`website`).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  FORM_QUESTION_TYPES,
  PUBLIC_FORM_QUESTION_TYPES,
  newId,
  type FormConfig,
  type FormQuestion,
  type PropertyDef,
  type PropertyType,
  type PropertyValue,
  type PublicFormResponse,
  type ViewConfig,
} from '@oriel/shared';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import { parseJson, type PageRow, type ViewRow } from '../db/rows.js';
import { HttpError, badRequest, notFound, rateLimited } from '../errors.js';
import { idParam, parse, requireAuth } from '../http.js';
import { canEditRole, getPageRow, pageAccess, requireDatabasePage, roleOf, shareableChain } from '../access.js';
import { clientKey, RateLimiter } from '../auth/rateLimit.js';
import { submitFormSchema } from '../schemas.js';
import { defaultTemplateId, getViewRow, isTemplate, loadSchema, validateValue } from '../services/databases.js';
import { createPage, duplicatePage } from '../services/pages.js';
import { notify } from '../collab/notify.js';
import { formProperties } from '../services/propertyAccess.js';

export interface FormRouteOptions {
  /** Public submissions per client address per window (default 10 per 10 min). */
  ipLimit?: number;
  ipWindowMs?: number;
  /** Public submissions per form per hour / per day (default 60 / 300). */
  hourlyCap?: number;
  dailyCap?: number;
  /** Member submissions per user per minute (default 30). */
  userLimit?: number;
}

/** Test hook (set by the in-process test suite before requests). Never set in production code. */
export const formTestHooks: FormRouteOptions = {};

/** Max request body of a submission (bytes). */
export const FORM_BODY_LIMIT = 64 * 1024;

const vidParams = z.object({ vid: idParam });

const closed = () => new HttpError(403, 'form_closed', 'Ce formulaire n’accepte plus de réponses.');
const formNotFound = () => notFound('Formulaire introuvable.');

// --- per-type shapes (before validateValue) --------------------------------------------------------

const dateShape = z.object({
  start: z.string().max(40),
  end: z.string().max(40).nullable().optional(),
  includeTime: z.boolean().optional(),
});
const idList = z.array(z.string().min(1).max(64)).max(100);
const SHAPES: Partial<Record<PropertyType, z.ZodType>> = {
  title: z.string().max(2000),
  text: z.string().max(10_000),
  number: z.number().finite(),
  select: z.string().max(64),
  status: z.string().max(64),
  multi_select: idList,
  date: dateShape,
  checkbox: z.boolean(),
  url: z.string().trim().max(2000).regex(/^https?:\/\/\S+$/i, 'URL invalide'),
  email: z.string().trim().max(320).pipe(z.email()),
  phone: z.string().trim().max(100).regex(/^[0-9+().\s-]+$/, 'numéro invalide'),
  person: idList,
  relation: idList,
  // Files of a form are uploads of the workspace (existing upload route and limits).
  files: z
    .array(
      z.object({
        name: z.string().min(1).max(500),
        url: z.string().max(2000).regex(/^\/api\/files\/[A-Za-z0-9-]+\/[^/]+$/, 'fichier invalide'),
        size: z.number().int().min(0).optional(),
        mime: z.string().max(200).optional(),
      }),
    )
    .max(20),
  place: z.object({ address: z.string().max(500), lat: z.number().optional(), lng: z.number().optional() }),
};

const isEmptyAnswer = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

/** Does `answer` satisfy a showIf condition value (option id, 'true' / 'false', text)? */
function matches(answer: unknown, value: string): boolean {
  if (typeof answer === 'boolean') return String(answer) === value;
  if (Array.isArray(answer)) return answer.includes(value);
  if (typeof answer === 'number') return String(answer) === value;
  return typeof answer === 'string' && answer === value;
}

export interface FormValues {
  title: string;
  properties: Record<string, PropertyValue>;
}

/**
 * Relation answers of a member: only live, non-template rows of the target database that the
 * SUBMITTER can see. The row is created by the database owner when the submitter cannot edit
 * (formActor), so the relation sync alone would check the owner's visibility (QA-VIEW-02).
 */
function checkRelationTargets(db: Db, def: PropertyDef, ids: string[], submitterId: string): boolean {
  const target = def.relation?.databaseId;
  if (!target) return ids.length === 0;
  // Two-way relation: the answer writes the mirror too, which the submitter must be allowed to answer (D30, QA-G3-07).
  const synced = def.relation?.syncedPropertyId;
  if (synced && ids.length > 0) {
    const mirror = loadSchema(db, target).properties.find((p) => p.id === synced);
    const workspaceId = getPageRow(db, target)?.workspace_id;
    if (mirror && (!workspaceId || formProperties(db, [mirror], roleOf(db, submitterId, workspaceId)).length === 0)) return false;
  }
  return ids.every((id) => {
    const page = pageAccess(db, submitterId, id)?.page;
    return !!page && page.parent_type === 'database' && page.parent_id === target && page.trashed_at === null && !isTemplate(db, id);
  });
}

/**
 * Builds the row values of a submission. Only the form's questions on allowed property types are
 * accepted (any other key → 400); hidden conditional questions are ignored; required answers enforced.
 * `submitterId`: the member answering (member mode), whose visibility bounds the relation answers.
 */
export function formValues(
  db: Db,
  schema: PropertyDef[],
  form: FormConfig,
  answers: Record<string, unknown>,
  mode: 'public' | 'member',
  workspaceId: string,
  submitterId: string | null = null,
): FormValues {
  const allowed = mode === 'public' ? PUBLIC_FORM_QUESTION_TYPES : FORM_QUESTION_TYPES;
  const byId = new Map(schema.map((p) => [p.id, p] as const));
  const questions = form.questions.filter((q) => {
    const def = byId.get(q.propertyId);
    return !!def && allowed.includes(def.type);
  });
  const known = new Map(questions.map((q) => [q.id, q] as const));
  for (const key of Object.keys(answers)) if (!known.has(key)) throw badRequest('Réponse inattendue.');

  const visible = (q: FormQuestion, seen: Set<string>): boolean => {
    if (!q.showIf) return true;
    const cond = known.get(q.showIf.questionId);
    if (!cond || seen.has(cond.id)) return false;
    seen.add(cond.id);
    return visible(cond, seen) && matches(answers[cond.id], q.showIf.value);
  };

  const out: FormValues = { title: '', properties: {} };
  const usedProps = new Set<string>();
  for (const q of questions) {
    const def = byId.get(q.propertyId)!;
    const label = q.label?.trim() || def.name;
    if (!visible(q, new Set([q.id]))) continue;
    const raw = answers[q.id];
    const empty = isEmptyAnswer(raw) || (def.type === 'checkbox' && raw === false && q.required);
    if (empty) {
      if (q.required) throw badRequest(`La question « ${label} » est obligatoire.`);
      continue;
    }
    // A property is answered once (the first question mapped to it wins).
    if (usedProps.has(def.id)) continue;
    usedProps.add(def.id);
    const shaped = SHAPES[def.type]?.safeParse(raw);
    if (!shaped || !shaped.success) throw badRequest(`Réponse invalide pour « ${label} ».`);
    if (def.type === 'title') {
      out.title = (shaped.data as string).trim();
      continue;
    }
    try {
      out.properties[def.id] = validateValue(db, def, shaped.data, workspaceId);
    } catch {
      throw badRequest(`Réponse invalide pour « ${label} ».`);
    }
    if (def.type === 'relation' && (mode !== 'member' || !submitterId || !checkRelationTargets(db, def, out.properties[def.id] as string[], submitterId))) {
      throw badRequest(`Réponse invalide pour « ${label} ».`);
    }
  }
  return out;
}

/** A member with edit rights who creates the rows of submissions that cannot be attributed: owner first. */
function formActor(db: Db, dbPage: PageRow): string | null {
  if (canEditRole(roleOf(db, dbPage.owner_id, dbPage.workspace_id))) return dbPage.owner_id;
  return (
    db.get<{ user_id: string }>(
      "SELECT user_id FROM members WHERE workspace_id = ? AND role IN ('owner', 'admin') ORDER BY role = 'owner' DESC, joined_at LIMIT 1",
      dbPage.workspace_id,
    )?.user_id ?? null
  );
}

function formOf(view: ViewRow): FormConfig | null {
  if (view.type !== 'form') return null;
  const config = parseJson<Partial<ViewConfig>>(view.config, {});
  const form = config.form;
  if (!form || !Array.isArray(form.questions)) return null;
  return form;
}

/**
 * View, form and database of a form open to people without an account, else 404: a form view with
 * `isPublic` whose database is live (shareableChain: nothing trashed in its chain, no exclusion such as
 * a row template). Publication of the database is not required (QA-VIEW-04).
 */
function publicForm(db: Db, vid: string): { view: ViewRow; form: FormConfig; dbPage: PageRow } {
  const view = getViewRow(db, vid);
  const form = view ? formOf(view) : null;
  if (!view || !form || form.isPublic !== true) throw formNotFound();
  const dbPage = shareableChain(db, view.database_id)?.[0];
  if (!dbPage || dbPage.kind !== 'database') throw formNotFound();
  return { view, form, dbPage };
}

const CHOICE_TYPES: PropertyType[] = ['select', 'multi_select', 'status'];

/**
 * What the public page of a form shows, rebuilt field by field (allowlist): its texts, the questions an
 * anonymous visitor may answer and, for each one's property, id, name, type and choices. No row, no
 * other property, no other view setting.
 */
export function publicFormDefinition(view: ViewRow, form: FormConfig, schema: PropertyDef[]): PublicFormResponse {
  const byId = new Map(schema.map((p) => [p.id, p] as const));
  const questions: FormQuestion[] = [];
  const used = new Set<string>();
  for (const q of form.questions) {
    const def = byId.get(q.propertyId);
    if (!def || !PUBLIC_FORM_QUESTION_TYPES.includes(def.type)) continue;
    const out: FormQuestion = { id: q.id, propertyId: q.propertyId };
    if (q.label !== undefined) out.label = q.label;
    if (q.description !== undefined) out.description = q.description;
    if (q.required !== undefined) out.required = q.required;
    if (q.showIf) out.showIf = { questionId: q.showIf.questionId, value: q.showIf.value };
    questions.push(out);
    used.add(def.id);
  }
  const properties = schema
    .filter((p) => used.has(p.id))
    .map((p) => {
      const out: PublicFormResponse['properties'][number] = { id: p.id, name: p.name, type: p.type };
      if (CHOICE_TYPES.includes(p.type)) {
        out.options = (p.options ?? []).map((o) => (o.group ? { id: o.id, name: o.name, color: o.color, group: o.group } : { id: o.id, name: o.name, color: o.color }));
      }
      return out;
    });
  const def: FormConfig = { questions, acceptResponses: form.acceptResponses === true, isPublic: true };
  if (form.title !== undefined) def.title = form.title;
  if (form.description !== undefined) def.description = form.description;
  if (form.submitLabel !== undefined) def.submitLabel = form.submitLabel;
  if (form.confirmation !== undefined) def.confirmation = form.confirmation;
  return { view: { id: view.id, name: view.name }, form: def, properties };
}

/** Creates the row (default template when set) and notifies the database owner. */
function createSubmission(
  ctx: AppContext,
  view: ViewRow,
  dbPage: PageRow,
  values: FormValues,
  actorId: string,
  submitterId: string | null,
): void {
  const { db } = ctx;
  db.tx(() => {
    const templateId = defaultTemplateId(db, dbPage.id);
    const row = templateId
      ? duplicatePage(ctx, actorId, templateId, {
          title: values.title,
          properties: values.properties,
          position: { after: undefined },
          asTemplate: false,
        })
      : createPage(ctx, actorId, dbPage.workspace_id, {
          parentType: 'database',
          parentId: dbPage.id,
          kind: 'page',
          title: values.title,
          properties: values.properties,
        });
    const now = Date.now();
    db.run(
      'INSERT INTO database_form_submissions (id, view_id, is_public, created_at) VALUES (?, ?, ?, ?)',
      newId(),
      view.id,
      submitterId ? 0 : 1,
      now,
    );
    db.run('DELETE FROM database_form_submissions WHERE created_at < ?', now - 2 * 24 * 3600_000);
    notify(ctx, {
      userId: dbPage.owner_id,
      workspaceId: dbPage.workspace_id,
      type: 'form_response',
      actorId: submitterId,
      pageId: row.id,
      excerpt: values.title || view.name,
    });
  });
}

export function registerFormRoutes(app: FastifyInstance, ctx: AppContext, options: FormRouteOptions = {}): void {
  const { db } = ctx;
  const opt = <K extends keyof FormRouteOptions>(k: K, d: number): number => options[k] ?? formTestHooks[k] ?? d;
  const limiters = new Map<string, RateLimiter>();
  /** One limiter per (limit, window): settings are read per request (test hooks). */
  const limiter = (limit: number, windowMs: number) => {
    const key = `${limit}/${windowMs}`;
    let l = limiters.get(key);
    if (!l) limiters.set(key, (l = new RateLimiter(limit, windowMs)));
    return l;
  };
  const ipLimiter = { hit: (key: string) => limiter(opt('ipLimit', 10), opt('ipWindowMs', 10 * 60_000)).hit(key) };
  const userLimiter = { hit: (key: string) => limiter(opt('userLimit', 30), 60_000).hit(key) };

  // --- members ------------------------------------------------------------------------------------

  app.post('/api/forms/:vid/submit', { bodyLimit: FORM_BODY_LIMIT }, async (req) => {
    const { user } = requireAuth(req);
    const { vid } = parse(vidParams, req.params);
    const body = parse(submitFormSchema, req.body);
    const view = getViewRow(db, vid);
    if (!view) throw formNotFound();
    let dbPage: PageRow;
    try {
      dbPage = requireDatabasePage(db, user.id, view.database_id).page;
    } catch (err) {
      if ((err as { status?: number }).status === 404) throw formNotFound();
      throw err;
    }
    const form = formOf(view);
    if (!form || dbPage.trashed_at !== null) throw formNotFound();
    if (!form.acceptResponses) throw closed();
    if (body.website) return { ok: true as const };
    if (!userLimiter.hit(`form:${user.id}`)) throw rateLimited('Trop de réponses envoyées. Réessayez dans une minute.');
    const role = roleOf(db, user.id, dbPage.workspace_id);
    // Per-property permissions (D30): questions on properties the submitter may not write are refused.
    const values = formValues(db, formProperties(db, loadSchema(db, dbPage.id).properties, role), form, body.answers, 'member', dbPage.workspace_id, user.id);
    const canEdit = canEditRole(role);
    const actor = canEdit ? user.id : formActor(db, dbPage);
    if (!actor) throw closed();
    createSubmission(ctx, view, dbPage, values, actor, user.id);
    return { ok: true as const };
  });

  // --- public (anonymous) ---------------------------------------------------------------------------

  // Anonymous on purpose (both routes): the session cookie is never read here.
  app.get('/api/public/forms/:vid', async (req): Promise<PublicFormResponse> => {
    const { vid } = parse(vidParams, req.params);
    const { view, form, dbPage } = publicForm(db, vid);
    return publicFormDefinition(view, form, formProperties(db, loadSchema(db, dbPage.id).properties, null));
  });

  app.post('/api/public/forms/:vid/submit', { bodyLimit: FORM_BODY_LIMIT }, async (req) => {
    if (!ipLimiter.hit(`public-form:${clientKey(req.ip)}`)) throw rateLimited('Trop de réponses envoyées. Réessayez plus tard.');
    const { vid } = parse(vidParams, req.params);
    const body = parse(submitFormSchema, req.body);
    const { view, form, dbPage } = publicForm(db, vid);
    if (!form.acceptResponses) throw closed();
    // Honeypot: bots fill every field. Same answer as a success, nothing stored.
    if (body.website) return { ok: true as const };
    const count = (since: number) =>
      db.get<{ n: number }>('SELECT COUNT(*) AS n FROM database_form_submissions WHERE view_id = ? AND is_public = 1 AND created_at >= ?', vid, since)
        ?.n ?? 0;
    const now = Date.now();
    if (count(now - 3600_000) >= opt('hourlyCap', 60) || count(now - 24 * 3600_000) >= opt('dailyCap', 300)) {
      throw rateLimited('Ce formulaire reçoit trop de réponses pour le moment. Réessayez plus tard.');
    }
    const values = formValues(db, formProperties(db, loadSchema(db, dbPage.id).properties, null), form, body.answers, 'public', dbPage.workspace_id);
    const actor = formActor(db, dbPage);
    if (!actor || !getPageRow(db, dbPage.id)) throw closed();
    createSubmission(ctx, view, dbPage, values, actor, null);
    return { ok: true as const };
  });
}
