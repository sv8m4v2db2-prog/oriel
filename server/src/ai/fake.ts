// Offline stand-in for the Anthropic Messages API, plugged into the real SDK through its `fetch`
// option: the SDK (tool runner, streaming parser, errors) runs unchanged, only the HTTP exchange is
// simulated. Used by the tests and by the demo mode (ORIEL_AI_FAKE=1), whose deterministic
// "brain" builds a plausible brief from real tool calls against the workspace.
import { randomUUID } from 'node:crypto';
import { addDays } from './time.js';

export type FakeBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id?: string; name: string; input: unknown }
  | { type: 'thinking'; thinking: string; signature?: string };

export interface FakeTurn {
  content: FakeBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' | 'stop_sequence';
  stop_details?: { type: 'refusal'; category: string | null; explanation: string | null } | null;
  /** Defaults to the requested model. */
  model?: string;
  /** Overrides of the simulated usage. */
  usage?: Partial<{
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    iterations: unknown[];
  }>;
}

export interface FakeRequest {
  url: string;
  headers: Headers;
  body: any;
}

/** An error response instead of a message (exercise the SDK's typed errors). */
export interface FakeHttpError {
  httpStatus: number;
  errorType: string;
  message: string;
}

export type FakeBrain = (request: FakeRequest) => FakeTurn | FakeHttpError | Promise<FakeTurn | FakeHttpError>;

const encoder = new TextEncoder();

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? '').length / 4);
}

function simulatedUsage(body: FakeRequest['body'], turn: FakeTurn) {
  const messages: unknown[] = Array.isArray(body?.messages) ? body.messages : [];
  const stable = estimateTokens(body?.system) + estimateTokens(body?.tools);
  const history = estimateTokens(messages.slice(0, -1));
  const fresh = estimateTokens(messages.slice(-1));
  const first = messages.length <= 1;
  return {
    input_tokens: first ? 40 : fresh + 20,
    cache_creation_input_tokens: first ? stable + fresh : Math.max(0, fresh - 20),
    cache_read_input_tokens: first ? 0 : stable + history,
    output_tokens: estimateTokens(turn.content) + 120,
    ...turn.usage,
  };
}

function sseBody(turn: FakeTurn, body: FakeRequest['body']): string {
  const model = turn.model ?? body?.model ?? 'claude-opus-5-5';
  const usage = simulatedUsage(body, turn);
  const events: Array<[string, unknown]> = [];
  events.push([
    'message_start',
    {
      type: 'message_start',
      message: {
        id: `msg_fake_${randomUUID().slice(0, 12)}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: 1,
          cache_creation_input_tokens: usage.cache_creation_input_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens,
        },
      },
    },
  ]);
  turn.content.forEach((block, index) => {
    if (block.type === 'text') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: null } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }]);
    } else if (block.type === 'thinking') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature ?? 'fake-signature' } }]);
    } else {
      const id = block.id ?? `toolu_fake_${randomUUID().slice(0, 12)}`;
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: block.name, input: {} } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } }]);
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push([
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: turn.stop_reason, stop_sequence: null, stop_details: turn.stop_details ?? null },
      usage: {
        output_tokens: usage.output_tokens,
        input_tokens: usage.input_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
        ...(usage.iterations ? { iterations: usage.iterations } : {}),
      },
    },
  ]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** A `fetch` implementation answering POST /v1/messages with the brain's turns (as SSE when streamed). */
export function createFakeFetch(brain: FakeBrain): typeof fetch {
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (init?.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError');
    const raw = typeof init?.body === 'string' ? init.body : init?.body ? await new Response(init.body).text() : '{}';
    const body = JSON.parse(raw || '{}');
    if (!/\/v1\/messages(\?|$)/.test(url)) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Not found' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const result = await brain({ url, headers, body });
    if ('httpStatus' in result) {
      return new Response(JSON.stringify({ type: 'error', error: { type: result.errorType, message: result.message } }), {
        status: result.httpStatus,
        headers: { 'content-type': 'application/json', 'request-id': 'req_fake' },
      });
    }
    if (body.stream) {
      const text = sseBody(result, body);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(text));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_fake' } });
    }
    const usage = simulatedUsage(body, result);
    const message = {
      id: `msg_fake_${randomUUID().slice(0, 12)}`,
      type: 'message',
      role: 'assistant',
      model: result.model ?? body.model,
      content: result.content.map((b) =>
        b.type === 'tool_use' ? { type: 'tool_use', id: b.id ?? `toolu_fake_${randomUUID().slice(0, 12)}`, name: b.name, input: b.input } : b,
      ),
      stop_reason: result.stop_reason,
      stop_sequence: null,
      stop_details: result.stop_details ?? null,
      usage,
    };
    return new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_fake' } });
  };
  return fakeFetch as typeof fetch;
}

// ---------------------------------------------------------------------------
// Reading a conversation (helpers for brains)
// ---------------------------------------------------------------------------

export interface ToolExchange {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Raw tool_result content (string), or null when not answered yet. */
  result: string | null;
  isError: boolean;
}

/** Every tool call of the conversation with its result, in order. */
export function toolExchanges(body: FakeRequest['body']): ToolExchange[] {
  const calls: ToolExchange[] = [];
  const byId = new Map<string, ToolExchange>();
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (message.role === 'assistant' && block?.type === 'tool_use') {
        const call: ToolExchange = { id: block.id, name: block.name, input: block.input ?? {}, result: null, isError: false };
        calls.push(call);
        byId.set(block.id, call);
      } else if (message.role === 'user' && block?.type === 'tool_result') {
        const call = byId.get(block.tool_use_id);
        if (!call) continue;
        call.isError = block.is_error === true;
        call.result =
          typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((c: { text?: string }) => c.text ?? '').join('')
              : '';
      }
    }
  }
  return calls;
}

function parseResult<T>(call: ToolExchange | undefined): T | null {
  if (!call?.result || call.isError) return null;
  try {
    return JSON.parse(call.result) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Demo brain: lister_sources → interroger_base (parallel) → lire_page → publier_brief
// ---------------------------------------------------------------------------

interface SourcesResult {
  aujourdhui: string;
  sources: Array<{
    id: string;
    titre: string;
    proprietes: Array<{ nom: string; type: string; versBase?: { id: string; titre: string } }>;
    basesDansLesLignes?: Array<{ id: string; titre: string; ligne: { id: string; titre: string } }>;
  }>;
}

interface RowsResult {
  base: { id: string; titre: string };
  proprieteDate: string | null;
  lignes: Array<{ id: string; titre: string; groupe?: string; enRetard?: boolean; props: Record<string, string | number | boolean> }>;
}

interface DemoTask {
  id: string;
  titre: string;
  projetId: string | null;
  echeance: string | null;
  groupe: string | null;
  responsables: string[];
}

const PERSON_KEY = /respons|assign|porteur|qui|personne|owner|équipe|equipe/i;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;

function todayFrom(body: FakeRequest['body']): string {
  const first = body?.messages?.[0];
  const text = typeof first?.content === 'string' ? first.content : JSON.stringify(first?.content ?? '');
  return /(\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? new Date().toISOString().slice(0, 10);
}

export const demoBrain: FakeBrain = ({ body }) => {
  const calls = toolExchanges(body);
  const today = todayFrom(body);
  const listing = calls.find((c) => c.name === 'lister_sources');
  if (!listing) {
    return {
      content: [
        { type: 'text', text: 'Je commence par lister les bases projets à analyser.' },
        { type: 'tool_use', name: 'lister_sources', input: {} },
      ],
      stop_reason: 'tool_use',
    };
  }
  const sources = parseResult<SourcesResult>(listing)?.sources ?? [];
  const queries = calls.filter((c) => c.name === 'interroger_base');
  if (queries.length === 0 && sources.length > 0) {
    const ids = new Set<string>();
    for (const s of sources.slice(0, 3)) {
      ids.add(s.id);
      for (const p of s.proprietes) if (p.versBase) ids.add(p.versBase.id);
      for (const b of s.basesDansLesLignes ?? []) ids.add(b.id);
    }
    return {
      content: [
        { type: 'text', text: 'Je récupère les tâches non terminées des projets et de leurs plannings.' },
        ...[...ids].slice(0, 8).map((baseId): FakeBlock => ({ type: 'tool_use', name: 'interroger_base', input: { baseId, statut: 'non_termine', limite: 200 } })),
      ],
      stop_reason: 'tool_use',
    };
  }

  // Projects = rows of the configured sources; tasks = rows of the other databases.
  const sourceIds = new Set(sources.map((s) => s.id));
  const planningProject = new Map<string, string>();
  for (const s of sources) for (const b of s.basesDansLesLignes ?? []) planningProject.set(b.id, b.ligne.id);
  const projects = new Map<string, { id: string; titre: string }>();
  const tasks: DemoTask[] = [];
  for (const q of queries) {
    const res = parseResult<RowsResult>(q);
    if (!res) continue;
    const isSource = sourceIds.has(res.base.id);
    for (const row of res.lignes) {
      if (isSource) projects.set(row.id, { id: row.id, titre: row.titre });
      const dateValue = res.proprieteDate ? row.props[res.proprieteDate] : undefined;
      const echeance = typeof dateValue === 'string' ? (/(\d{4}-\d{2}-\d{2})(?!.*\d{4}-\d{2}-\d{2})/.exec(dateValue)?.[1] ?? null) : null;
      if (isSource && !echeance) continue;
      let projetId = planningProject.get(res.base.id) ?? null;
      if (!projetId) {
        for (const value of Object.values(row.props)) {
          const ref = typeof value === 'string' ? /\[([0-9a-f-]{36})\]/i.exec(value)?.[1] : undefined;
          if (ref) projetId = ref;
        }
      }
      const responsables = Object.entries(row.props)
        .filter(([k, v]) => PERSON_KEY.test(k) && typeof v === 'string')
        .flatMap(([, v]) => String(v).split(', '));
      tasks.push({ id: row.id, titre: row.titre, projetId: isSource ? row.id : projetId, echeance, groupe: row.groupe ?? null, responsables });
    }
  }
  if (!calls.some((c) => c.name === 'lire_page') && projects.size > 0) {
    return {
      content: [
        { type: 'text', text: 'Je lis les pages des projets pour vérifier les jalons.' },
        ...[...projects.values()].slice(0, 2).map((p): FakeBlock => ({ type: 'tool_use', name: 'lire_page', input: { pageId: p.id, maxCaracteres: 1500 } })),
      ],
      stop_reason: 'tool_use',
    };
  }

  const horizon = addDays(today, 7);
  const projectTitle = (id: string | null) => (id ? (projects.get(id)?.titre ?? null) : null);
  const toItem = (t: DemoTask, note: string) => ({
    titre: t.titre,
    pageId: t.id,
    projetId: t.projetId,
    echeance: t.echeance,
    responsables: t.responsables,
    note,
  });
  const late = tasks.filter((t) => t.echeance && t.echeance < today && t.groupe !== 'done').sort((a, b) => (a.echeance! < b.echeance! ? -1 : 1));
  const upcoming = tasks
    .filter((t) => t.echeance && t.echeance >= today && t.echeance <= horizon && t.groupe !== 'done')
    .sort((a, b) => (a.echeance! < b.echeance! ? -1 : 1));
  const lateNote = (t: DemoTask) => {
    const days = daysBetween(t.echeance!, today);
    const project = projectTitle(t.projetId);
    return `${plural(days, 'jour')} de retard${project ? ` sur « ${project} »` : ''}`;
  };
  const upcomingNote = (t: DemoTask) => {
    const days = daysBetween(today, t.echeance!);
    return days === 0 ? 'Échéance aujourd’hui.' : days === 1 ? 'Échéance demain.' : `Échéance dans ${days} jours.`;
  };
  const priorities = [
    ...late.slice(0, 3).map((t) => toItem(t, `À débloquer en priorité : ${lateNote(t)}.`)),
    ...upcoming.filter((t) => daysBetween(today, t.echeance!) <= 1).map((t) => toItem(t, upcomingNote(t))),
    ...tasks
      .filter((t) => t.groupe === 'in_progress' && t.id !== t.projetId && !late.includes(t) && !upcoming.includes(t))
      .map((t) => toItem(t, 'Tâche en cours à faire avancer.')),
  ].slice(0, 6);

  const projectEntries = [...projects.values()].map((p) => {
    const own = tasks.filter((t) => t.projetId === p.id && t.id !== p.id);
    const ownLate = late.filter((t) => t.projetId === p.id);
    const ownSoon = upcoming.filter((t) => t.projetId === p.id);
    const worst = ownLate.length ? daysBetween(ownLate[0]!.echeance!, today) : 0;
    const etat = ownLate.length >= 2 || worst >= 5 ? 'en_retard' : ownLate.length === 1 || ownSoon.length >= 3 ? 'a_surveiller' : 'en_bonne_voie';
    const next = ownSoon[0];
    const commentaire =
      `${plural(own.length, 'tâche')} ouverte${own.length > 1 ? 's' : ''}, ${ownLate.length} en retard` +
      (next ? `, prochaine échéance le ${next.echeance} (« ${next.titre} »).` : '.');
    return { pageId: p.id, titre: p.titre, etat, commentaire };
  });
  const risks = projectEntries
    .filter((p) => p.etat !== 'en_bonne_voie')
    .map((p) => {
      const ownLate = late.filter((t) => t.projetId === p.pageId);
      const first = ownLate[0];
      return {
        description: first
          ? `« ${first.titre} » a ${plural(daysBetween(first.echeance!, today), 'jour')} de retard et menace le calendrier de « ${p.titre} ».`
          : `Plusieurs échéances rapprochées sur « ${p.titre} » cette semaine.`,
        gravite: p.etat === 'en_retard' ? 'haute' : 'moyenne',
        pages: [...(first ? [first.id] : []), p.pageId],
      };
    });
  const resume =
    `${plural(projects.size, 'projet')} analysé${projects.size > 1 ? 's' : ''} : ${plural(late.length, 'tâche')} en retard et ` +
    `${plural(upcoming.length, 'échéance')} dans les 7 prochains jours. ` +
    (late[0] ? `Le point le plus urgent est « ${late[0].titre} » (${lateNote(late[0])}). ` : 'Aucun retard à signaler. ') +
    '(Brief de démonstration généré localement, sans appel à l’API Anthropic.)';
  return {
    content: [
      {
        type: 'tool_use',
        name: 'publier_brief',
        input: {
          resume,
          priorites: priorities,
          en_retard: late.map((t) => toItem(t, `${lateNote(t)}.`)),
          a_venir: upcoming.map((t) => toItem(t, upcomingNote(t))),
          risques: risks,
          projets: projectEntries,
        },
      },
    ],
    stop_reason: 'tool_use',
  };
};
