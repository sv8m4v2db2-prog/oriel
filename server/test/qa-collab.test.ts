// QA (security review) of the collab surface: comments, mentions & reminders, inbox, e-mail links
// and templates, /api/events, /collab permission changes on live connections and the Yjs
// structures accepted on /collab.
// Each test is the reproduction of a suspected flaw; confirmed-but-unfixed ones are marked `todo`.
process.env.SMTP_URL = 'json:quiet';
process.env.MAIL_FROM = 'Oriel <oriel@oriel.test>';

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import nodemailer from 'nodemailer';
import { Awareness, applyAwarenessUpdate } from 'y-protocols/awareness';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import type { CommentThread, EmailInviteResponse, Invite, NotificationsResponse, Page, SessionResponse } from '@oriel/shared';
import { Client, addMember, createPage, expectOk, setupAdmin, sleep, startTestServer, waitFor, type TestServer } from './helpers.js';
import { collabContexts } from '../src/routes/collab.js';
import { mailOutbox } from '../src/collab/mailer.js';
import { inviteMail, notificationMail } from '../src/collab/templates.js';
import { cleanupNotifications, runDigestIfDue, runReminders } from '../src/collab/jobs.js';
import { INVITE_MAILS_PER_DAY, inviteMailsSent } from '../src/collab/invites.js';
import { extractCollabRefs } from '../src/collab/mentions.js';
import { parisToday } from '../src/collab/time.js';
import { MAX_CONTENT_DEPTH, extractContent, remapState } from '../src/content/ydoc.js';
import type { AppContext } from '../src/context.js';

// --- helpers ------------------------------------------------------------------------------

const opened: Array<{ close(): void }> = [];
const closeAll = () => {
  for (const c of opened.splice(0)) {
    try {
      c.close();
    } catch {
      /* already closed */
    }
  }
};

const para = (...content: unknown[]) => [{ type: 'paragraph', props: {}, content, children: [] }];
const text = (t: string) => ({ type: 'text', text: t, styles: {} });
const mention = (userId: string) => ({ type: 'userMention', props: { userId } });

const notifications = async (c: Client, wid: string, filter = '') =>
  expectOk(await c.get<NotificationsResponse>(`/workspaces/${wid}/notifications${filter}`)).notifications;

/** GET with arbitrary headers (Host included), through node:http. */
function rawGet(base: string, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

interface CollabClient {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  failed: string | null;
  close(): void;
}

async function connectCollab(wsBase: string, pageId: string, cookie: string | null): Promise<CollabClient> {
  class CookieWebSocket extends WebSocket {
    constructor(url: string) {
      super(url, cookie ? { headers: { cookie: `oriel_session=${cookie}` } } : {});
    }
  }
  const socket = new HocuspocusProviderWebsocket({ url: `${wsBase}/collab`, WebSocketPolyfill: CookieWebSocket });
  const doc = new Y.Doc();
  const state: { failed: string | null } = { failed: null };
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: `page:${pageId}`,
    document: doc,
    onAuthenticationFailed: ({ reason }) => {
      state.failed = reason || 'denied';
    },
  });
  provider.attach();
  const client: CollabClient = {
    doc,
    provider,
    get failed() {
      return state.failed;
    },
    close() {
      provider.destroy();
      socket.destroy();
    },
  };
  opened.push(client);
  await waitFor(() => provider.isSynced || state.failed, 5000, 'collab sync');
  return client;
}

function appendParagraph(doc: Y.Doc, value: string, inline: Array<{ name: string; attrs: Record<string, unknown> }> = []): void {
  const fragment = doc.getXmlFragment('blocknote');
  doc.transact(() => {
    let group = fragment.get(0) as Y.XmlElement | undefined;
    if (!group) {
      group = new Y.XmlElement('blockGroup');
      fragment.insert(0, [group]);
    }
    const container = new Y.XmlElement('blockContainer');
    container.setAttribute('id', crypto.randomUUID());
    const paragraph = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, value);
    const items: Array<Y.XmlElement | Y.XmlText> = [t];
    for (const i of inline) {
      const el = new Y.XmlElement(i.name);
      for (const [k, v] of Object.entries(i.attrs)) el.setAttribute(k, v as string);
      items.push(el);
    }
    paragraph.insert(0, items);
    container.insert(0, [paragraph]);
    group.insert(group.length, [container]);
  });
}

const docText = (doc: Y.Doc) => doc.getXmlFragment('blocknote').toString();

/**
 * Hand-rolled Hocuspocus client: records auth replies, the awareness states it receives, the
 * "update saved" acknowledgements and the documents the server closed.
 */
class RawCollab {
  readonly auths = new Map<string, string[]>();
  readonly awareness = new Awareness(new Y.Doc());
  readonly saved = new Map<string, number>();
  readonly closedDocs = new Set<string>();
  closed = false;
  private constructor(readonly ws: WebSocket) {
    this.awareness.setLocalState(null);
    ws.on('message', (data) => {
      const dec = decoding.createDecoder(new Uint8Array(data as Buffer));
      const doc = decoding.readVarString(dec);
      const type = decoding.readVarUint(dec);
      if (type === 1) {
        applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), null);
        return;
      }
      if (type === 7) {
        this.closedDocs.add(doc);
        return;
      }
      if (type === 8) {
        if (decoding.readVarUint(dec) === 1) this.saved.set(doc, (this.saved.get(doc) ?? 0) + 1);
        return;
      }
      if (type !== 2) return;
      const sub = decoding.readVarUint(dec);
      const list = this.auths.get(doc) ?? [];
      list.push(sub === 2 ? `authenticated:${decoding.readVarString(dec)}` : 'denied');
      this.auths.set(doc, list);
    });
    ws.on('close', () => {
      this.closed = true;
    });
  }

  static open(wsBase: string, cookie: string | null): Promise<RawCollab> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}/collab`, cookie ? { headers: { cookie: `oriel_session=${cookie}` } } : {});
      ws.on('open', () => {
        const raw = new RawCollab(ws);
        opened.push(raw);
        resolve(raw);
      });
      ws.on('error', reject);
    });
  }

  async auth(pageId: string): Promise<string> {
    const doc = `page:${pageId}`;
    const before = this.auths.get(doc)?.length ?? 0;
    const e = encoding.createEncoder();
    encoding.writeVarString(e, doc);
    encoding.writeVarUint(e, 2); // Auth
    encoding.writeVarUint(e, 0); // Token
    encoding.writeVarString(e, 'session');
    this.ws.send(encoding.toUint8Array(e));
    await waitFor(() => (this.auths.get(doc)?.length ?? 0) > before || this.closed, 5000, 'auth reply');
    return this.auths.get(doc)?.[before] ?? 'closed';
  }

  /** Sends a raw Yjs update (sync "Update" message) and waits for the verdict of the server. */
  async push(pageId: string, update: Uint8Array): Promise<'saved' | 'closed'> {
    const doc = `page:${pageId}`;
    const before = this.saved.get(doc) ?? 0;
    const e = encoding.createEncoder();
    encoding.writeVarString(e, doc);
    encoding.writeVarUint(e, 0); // Sync
    encoding.writeVarUint(e, 2); // Update
    encoding.writeVarUint8Array(e, update);
    this.ws.send(encoding.toUint8Array(e));
    await waitFor(() => (this.saved.get(doc) ?? 0) > before || this.closedDocs.has(doc) || this.closed, 5000, 'update verdict');
    return this.closedDocs.has(doc) || this.closed ? 'closed' : 'saved';
  }

  /** Names seen in the awareness states relayed to this socket. */
  names(): string[] {
    return [...this.awareness.getStates().values()].map((s) => (s as { user?: { name?: string } }).user?.name ?? '').filter(Boolean);
  }

  close(): void {
    this.awareness.destroy();
    this.ws.close();
  }
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parisMs(date: string, hour: number, minute = 0): number {
  for (const offset of [1, 2]) {
    const t = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hour - offset, minute);
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' }).format(new Date(t));
    if (Number(parts) === hour) return t;
  }
  throw new Error('no Paris time');
}

/** Current content of a page document (content API), in a fresh Y.Doc. */
async function serverDoc(c: Client, pageId: string): Promise<Y.Doc> {
  const { update } = expectOk(await c.get<{ update: string }>(`/pages/${pageId}/content`));
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(update, 'base64'));
  return doc;
}

/** The update `change` makes on a copy of the server's document (what a modified client would send). */
async function forge(c: Client, pageId: string, change: (doc: Y.Doc, fragment: Y.XmlFragment) => void): Promise<Uint8Array> {
  const doc = await serverDoc(c, pageId);
  const before = Y.encodeStateVector(doc);
  change(doc, doc.getXmlFragment('blocknote'));
  return Y.encodeStateAsUpdate(doc, before);
}

/** `levels` nested elements under `parent`, inserted level by level (no recursive integration). */
function nest(doc: Y.Doc, parent: Y.XmlElement | Y.XmlFragment, levels: number): Y.XmlElement {
  let current = parent;
  doc.transact(() => {
    for (let i = 0; i < levels; i++) {
      const el = new Y.XmlElement('blockContainer');
      current.insert(0, [el]);
      current = el;
    }
  });
  return current as Y.XmlElement;
}

/** Deepest element along the first children of the fragment, with its depth (fragment children: 1). */
function deepest(doc: Y.Doc): { el: Y.XmlElement | null; depth: number } {
  let el: Y.XmlElement | null = null;
  let depth = 0;
  const fragment = doc.getXmlFragment('blocknote');
  let next: unknown = fragment.length > 0 ? fragment.get(0) : null;
  while (next instanceof Y.XmlElement) {
    el = next;
    depth++;
    next = next.length > 0 ? next.get(0) : null;
  }
  return { el, depth };
}

/** What the editor could not render, or the server walk: foreign roots, non-XML nodes, typed attributes, embeds, depth. */
function problems(doc: Y.Doc): string[] {
  const out: string[] = [];
  for (const key of doc.share.keys()) if (key !== 'blocknote') out.push(`root:${key}`);
  const stack: Array<[unknown, number]> = doc.getXmlFragment('blocknote').toArray().map((n) => [n, 1]);
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    if (node instanceof Y.XmlText) {
      if ((node.toDelta() as Array<{ insert?: unknown }>).some((op) => typeof op.insert !== 'string')) out.push('embed');
      continue;
    }
    if (!(node instanceof Y.XmlElement)) {
      out.push('non-xml');
      continue;
    }
    if (depth > 256) out.push('depth');
    for (const v of Object.values(node.getAttributes() as Record<string, unknown>)) if (v instanceof Y.AbstractType) out.push('typed-attribute');
    for (const child of node.toArray()) stack.push([child, depth + 1]);
  }
  return out;
}

// --- e-mail links ----------------------------------------------------------------------------

describe('QA collab: e-mail links and templates', () => {
  let srv: TestServer;
  let ctx: AppContext;
  let admin: Client;
  let wid: string;
  let member: Client;
  let viewer: Client;
  let viewerId: string;

  before(async () => {
    // No PUBLIC_URL: links come from the origin of remembered requests.
    srv = await startTestServer({ publicUrl: '' });
    ctx = collabContexts.get(srv.dataDir)!;
    ({ admin, wid } = await setupAdmin(srv.base));
    ({ client: member } = await addMember(admin, wid, 'mallory@oriel.test', 'Mallory', 'member'));
    const v = await addMember(admin, wid, 'victor@oriel.test', 'Victor', 'viewer');
    viewer = v.client;
    viewerId = v.user.id;
    expectOk(await viewer.patch('/me/notification-settings', { emailFrequency: 'immediate' }));
  });
  after(async () => {
    closeAll();
    await srv.stop();
  });

  test('QA-COL-01: a non-admin member cannot poison the host of password-reset and notification links', async () => {
    // The administrator browses the instance normally: links use the real origin.
    expectOk(await admin.get('/auth/me'));
    // Mallory (ordinary member, any account would do) sends one request with a forged host.
    assert.equal(await rawGet(srv.base, '/api/auth/me', { cookie: `oriel_session=${member.cookie}`, 'x-forwarded-host': 'evil.example' }), 200);
    assert.equal(await rawGet(srv.base, '/api/auth/me', { cookie: `oriel_session=${member.cookie}`, host: 'evil2.example' }), 200);

    // …then asks for the administrator's password reset (anonymous route).
    const start = mailOutbox.length;
    expectOk(await new Client(srv.base).post('/auth/password/forgot', { email: 'admin@oriel.test' }));
    const reset = await waitFor(() => mailOutbox.slice(start).find((m) => m.to === 'admin@oriel.test'), 3000, 'reset mail');
    assert.doesNotMatch(reset.text + reset.html, /evil2?\.example/, 'reset link points to the attacker host');
    assert.match(reset.text, new RegExp(`${srv.base.replace(/[.]/g, '\\.')}/reset-password/`));

    // Same for notification e-mails sent by the background jobs (daily digest of the administrator).
    const page = await createPage(admin, wid, { title: 'Liens' });
    expectOk(await member.post(`/pages/${page.id}/threads`, { anchored: false, body: para(text('Vois '), mention(viewerId)) }));
    assert.equal(await rawGet(srv.base, '/api/auth/me', { cookie: `oriel_session=${member.cookie}`, 'x-forwarded-host': 'evil.example' }), 200);
    ctx.db.setMeta('collab_last_digest', '');
    assert.ok((await runDigestIfDue(ctx, parisMs(parisToday(), 8, 30))) >= 1);
    const digest = mailOutbox.slice(start).find((m) => m.to === 'admin@oriel.test' && m.subject.startsWith('Oriel :'));
    assert.ok(digest, 'digest sent');
    assert.doesNotMatch(digest!.text + digest!.html, /evil2?\.example/, 'digest links point to the attacker host');
    // Immediate notification e-mail (sent right after the actor's own request).
    const notif = await waitFor(() => mailOutbox.slice(start).find((m) => m.to === 'victor@oriel.test'), 3000, 'notification mail');
    assert.doesNotMatch(notif.text + notif.html, /evil2?\.example/);
  });

  test('QA-COL-02 (ruled out): CR/LF in titles, names or workspace names cannot inject e-mail headers', async () => {
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    const forged = 'Projet\r\nBcc: victim@evil.example\r\nX-Injected: 1';
    const messages = [
      notificationMail({ to: 'a@oriel.test', workspace: forged, item: { title: `${forged} vous a mentionné`, excerpt: forged, url: 'http://x/' } }),
      inviteMail({ to: 'b@oriel.test', inviter: forged, workspace: forged, role: 'Membre', url: 'http://x/', expiresAt: Date.now() }),
    ];
    for (const m of messages) {
      const info = await transport.sendMail({ from: 'Oriel <oriel@oriel.test>', ...m });
      const raw = (info.message as Buffer).toString('utf8');
      const headers = raw.slice(0, raw.indexOf('\n\n'));
      assert.doesNotMatch(headers, /^(Bcc|X-Injected):/im, 'header injected');
    }
    // The HTML part escapes user-controlled text.
    const html = notificationMail({ to: 'a@oriel.test', workspace: '<img src=x onerror=alert(1)>', item: { title: '<b>t</b>', excerpt: '"><script>x</script>', url: 'http://x/"onmouseover="alert(1)' } }).html;
    assert.ok(!html.includes('<img src=x') && !html.includes('<script>x') && !html.includes('"onmouseover="'));
    void ctx;
  });

  test('QA-COL-14: invitation e-mails are capped per account over 24 hours; invitation links stay available', async () => {
    const adminId = ctx.db.get<{ id: string }>("SELECT id FROM users WHERE email = 'admin@oriel.test'")!.id;
    const now = Date.now();
    // Seed the e-mails already sent instead of sending them: one left before the cap, plus older ones.
    const seed = INVITE_MAILS_PER_DAY - 1 - inviteMailsSent(ctx.db, adminId, now);
    for (let i = 0; i < seed; i++) ctx.db.run('INSERT INTO collab_invite_mails (user_id, sent_at) VALUES (?, ?)', adminId, now - 60_000);
    for (let i = 0; i < 3; i++) ctx.db.run('INSERT INTO collab_invite_mails (user_id, sent_at) VALUES (?, ?)', adminId, now - 25 * 3600_000);
    const invites = () => ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM invites WHERE workspace_id = ?', wid)!.n;

    const start = mailOutbox.length;
    const last = expectOk(await admin.post<EmailInviteResponse>(`/workspaces/${wid}/invites/email`, { email: 'quota-1@exemple.test', role: 'member' }));
    assert.equal(last.emailed, true);
    const before = invites();
    const refused = await admin.post(`/workspaces/${wid}/invites/email`, { email: 'quota-2@exemple.test', role: 'member' });
    assert.equal(refused.status, 429);
    assert.equal(refused.body.error.code, 'rate_limited');
    assert.match(refused.body.error.message, new RegExp(`${INVITE_MAILS_PER_DAY} invitations par e-mail ces dernières 24 heures`));
    assert.equal(invites(), before, 'no invitation created by the refused request');
    assert.ok(!mailOutbox.slice(start).some((m) => m.to === 'quota-2@exemple.test'));
    // The invitation link itself can still be created (and shared by hand).
    expectOk(await admin.post<Invite>(`/workspaces/${wid}/invites`, { role: 'member' }));

    // Rolling window: once the e-mails are more than 24 hours old, sending works again; cleanup drops them.
    ctx.db.run('UPDATE collab_invite_mails SET sent_at = sent_at - ? WHERE user_id = ?', 25 * 3600_000, adminId);
    expectOk(await admin.post<EmailInviteResponse>(`/workspaces/${wid}/invites/email`, { email: 'quota-3@exemple.test', role: 'member' }));
    cleanupNotifications(ctx);
    assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM collab_invite_mails WHERE user_id = ?', adminId)!.n, 1);
  });
});

// --- comments, mentions, inbox -------------------------------------------------------------------

describe('QA collab: comments, mentions, inbox', () => {
  let srv: TestServer;
  let ctx: AppContext;
  let admin: Client;
  let adminId: string;
  let wid: string;
  let member: Client;
  let memberId: string;
  let viewer: Client;
  let viewerId: string;
  let foreignId: string;

  before(async () => {
    srv = await startTestServer();
    ctx = collabContexts.get(srv.dataDir)!;
    const a = await setupAdmin(srv.base);
    admin = a.admin;
    adminId = a.session.user.id;
    wid = a.wid;
    const m = await addMember(admin, wid, 'marie@oriel.test', 'Marie', 'member');
    member = m.client;
    memberId = m.user.id;
    const v = await addMember(admin, wid, 'victor@oriel.test', 'Victor', 'viewer');
    viewer = v.client;
    viewerId = v.user.id;
    // A user of another workspace (open sign-up).
    expectOk(await admin.patch('/admin/settings', { signupMode: 'open' }));
    const foreign = new Client(srv.base);
    foreignId = expectOk(await foreign.post<SessionResponse>('/auth/signup', { email: 'zoe@ailleurs.test', name: 'Zoé Confidentielle', password: 'motdepasse-solide' })).user.id;
  });
  after(async () => {
    closeAll();
    await srv.stop();
  });

  test('QA-COL-03 (ruled out): threads, comments and reactions of a page the user cannot read are unreachable', async () => {
    const priv = await createPage(admin, wid, { title: 'Privé admin', visibility: 'private' });
    const t = expectOk(await admin.post<CommentThread>(`/pages/${priv.id}/threads`, { anchored: false, body: para(text('secret')) }));
    const cid = t.comments[0]!.id;
    assert.equal((await member.post(`/threads/${t.id}/comments`, { body: para(text('x')) })).status, 404);
    assert.equal((await member.put(`/comments/${cid}/reactions`, { emoji: '👍', active: true })).status, 404);
    assert.equal((await member.post(`/threads/${t.id}/resolve`, { resolved: true })).status, 404);
    assert.equal((await member.del(`/threads/${t.id}`)).status, 404);
    assert.equal((await member.del(`/comments/${cid}`)).status, 404);
    assert.equal((await member.patch(`/comments/${cid}`, { body: para(text('x')) })).status, 404);
    // Mentioning someone who cannot read the page notifies nobody (no title/excerpt leak).
    expectOk(await admin.post(`/pages/${priv.id}/threads`, { anchored: false, body: para(text('Pour '), mention(memberId)) }));
    assert.ok(!(await notifications(member, wid)).some((n) => n.page?.id === priv.id || n.excerpt.includes('Pour')));
  });

  test('QA-COL-04: mentioning an arbitrary user id does not reveal the name of a user outside the workspace', async () => {
    const page = await createPage(admin, wid, { title: 'Annuaire' });
    // Comment by the member: the page creator (admin) gets a "comment" notification with the excerpt.
    expectOk(await member.post(`/pages/${page.id}/threads`, { anchored: false, body: para(text('Qui est '), mention(foreignId)) }));
    const n = (await notifications(admin, wid)).find((x) => x.page?.id === page.id && x.type === 'comment');
    assert.ok(n, 'creator notified');
    assert.doesNotMatch(n!.excerpt, /Zoé/, 'name of a non-member leaked through the comment excerpt');

    // Same through a page document: the excerpt of the viewer's "mention" notification.
    const doc = await createPage(member, wid, { title: 'Doc annuaire' });
    const c = await connectCollab(srv.wsBase, doc.id, member.cookie);
    appendParagraph(c.doc, 'Avec ', [
      { name: 'userMention', attrs: { userId: viewerId } },
      { name: 'userMention', attrs: { userId: foreignId } },
    ]);
    const m = await waitFor(async () => (await notifications(viewer, wid)).find((x) => x.type === 'mention' && x.page?.id === doc.id), 5000, 'mention');
    assert.doesNotMatch(m.excerpt, /Zoé/, 'name of a non-member leaked through the page mention excerpt');
    c.close();
  });

  test('QA-COL-05: notification excerpts of a page that became private are neither listed nor e-mailed', async () => {
    const page = await createPage(admin, wid, { title: 'Bientôt privé' });
    expectOk(await admin.post(`/pages/${page.id}/threads`, { anchored: false, body: para(text('Budget confidentiel 12 345 € '), mention(memberId)) }));
    const before = (await notifications(member, wid)).find((n) => n.page?.id === page.id);
    assert.ok(before && /12 345/.test(before.excerpt));
    // The owner moves the page to their private section before the daily digest goes out.
    expectOk(await admin.post(`/pages/${page.id}/move`, { parentType: 'workspace', parentId: wid, visibility: 'private' }));
    const listed = (await notifications(member, wid)).find((n) => n.id === before!.id);
    assert.ok(listed);
    assert.equal(listed!.page, null);
    assert.doesNotMatch(listed!.excerpt, /12 345/, 'inbox keeps showing the content of a page the user cannot read');
    const patched = expectOk(await member.patch(`/notifications/${before!.id}`, { read: false }));
    assert.doesNotMatch(patched.excerpt, /12 345/);

    const start = mailOutbox.length;
    ctx.db.setMeta('collab_last_digest', '');
    await runDigestIfDue(ctx, parisMs(parisToday(), 8, 30));
    const digest = mailOutbox.slice(start).find((m) => m.to === 'marie@oriel.test');
    assert.ok(!digest || !/12 345/.test(digest.text + digest.html), 'digest e-mails the content of a page the user cannot read');
  });

  test('QA-COL-06: deleting a thread archives the notifications of its comments', async () => {
    const page = await createPage(admin, wid, { title: 'Fil supprimé' });
    const t = expectOk(await member.post<CommentThread>(`/pages/${page.id}/threads`, { anchored: false, body: para(text('Erreur de destinataire '), mention(viewerId)) }));
    expectOk(await admin.post(`/threads/${t.id}/comments`, { body: para(text('Réponse sensible')) }));
    assert.ok((await notifications(viewer, wid)).some((n) => n.threadId === t.id));
    expectOk(await admin.del(`/threads/${t.id}`));
    assert.ok(!(await notifications(viewer, wid)).some((n) => n.threadId === t.id), 'notification of a deleted thread still in the inbox');
    assert.ok(!(await notifications(member, wid)).some((n) => n.threadId === t.id));
    // (unread counts follow)
    void adminId;
  });

  test('QA-COL-13 (ruled out): reminders of a page that became private or was trashed do not fire for others', async () => {
    const date = addDays(parisToday(), 4);
    const pages = [await createPage(member, wid, { title: 'Rappel privatisé' }), await createPage(member, wid, { title: 'Rappel supprimé' })];
    for (const page of pages) {
      const c = await connectCollab(srv.wsBase, page.id, member.cookie);
      appendParagraph(c.doc, 'Échéance ', [{ name: 'dateMention', attrs: { date, reminder: true, userId: memberId } }]);
      await waitFor(() => ctx.db.get('SELECT 1 AS x FROM collab_reminders WHERE page_id = ?', page.id), 5000, 'reminder stored');
      c.close();
    }
    expectOk(await admin.post(`/pages/${pages[0]!.id}/move`, { parentType: 'workspace', parentId: wid, visibility: 'private' }));
    expectOk(await admin.post(`/pages/${pages[1]!.id}/trash`));
    runReminders(ctx, parisMs(date, 9, 5));
    const fired = ctx.db.all(
      "SELECT id FROM collab_notifications WHERE type = 'reminder' AND page_id IN (?, ?)",
      pages[0]!.id,
      pages[1]!.id,
    );
    assert.equal(fired.length, 0);
  });

  /** Resolves once the server stored the page document with `marker` in its text (mentions processed). */
  const stored = (pageId: string, marker: string) =>
    waitFor(() => ctx.db.get<{ text: string }>('SELECT text FROM documents WHERE page_id = ?', pageId)?.text.includes(marker), 5000, `stored: ${marker}`);
  const reminderRows = (pageId: string) =>
    ctx.db
      .all<{ user_id: string; date: string }>('SELECT user_id, date FROM collab_reminders WHERE page_id = ? ORDER BY user_id, date', pageId)
      .map((r) => ({ user_id: r.user_id, date: r.date }));

  test('QA-COL-07: a member cannot schedule date reminders for another member', async () => {
    const page = await createPage(member, wid, { title: 'Rappel imposé' });
    const date = addDays(parisToday(), 3);
    const c = await connectCollab(srv.wsBase, page.id, member.cookie);
    appendParagraph(c.doc, 'Pour Victor ', [{ name: 'dateMention', attrs: { date, reminder: true, userId: viewerId } }]);
    await stored(page.id, 'Pour Victor');
    // Also for the administrator, who edits the page afterwards: the planted reminder is not adopted.
    appendParagraph(c.doc, 'Pour Alice ', [{ name: 'dateMention', attrs: { date, reminder: true, userId: adminId } }]);
    await stored(page.id, 'Pour Alice');
    c.close();
    const a = await connectCollab(srv.wsBase, page.id, admin.cookie);
    appendParagraph(a.doc, 'Alice écrit ailleurs');
    await stored(page.id, 'Alice écrit ailleurs');
    assert.deepEqual(reminderRows(page.id), [], 'reminder scheduled by someone else');
    // Her own "Me rappeler" is scheduled.
    const own = addDays(date, 1);
    appendParagraph(a.doc, 'Mon rappel ', [{ name: 'dateMention', attrs: { date: own, reminder: true, userId: adminId } }]);
    await stored(page.id, 'Mon rappel');
    a.close();
    assert.deepEqual(reminderRows(page.id), [{ user_id: adminId, date: own }]);
    runReminders(ctx, parisMs(date, 9, 5));
    const r = (await notifications(viewer, wid)).filter((n) => n.type === 'reminder' && n.page?.id === page.id);
    assert.equal(r.length, 0, 'reminder created by someone else for the viewer');
  });

  test('QA-COL-07: members editing concurrently each keep their own reminder', async () => {
    const page = await createPage(member, wid, { title: 'Rappels croisés' });
    const date = addDays(parisToday(), 6);
    const m = await connectCollab(srv.wsBase, page.id, member.cookie);
    const a = await connectCollab(srv.wsBase, page.id, admin.cookie);
    // Both changes reach the server within the same save window (the last editor is only one of them).
    appendParagraph(m.doc, 'Rappel de Marie ', [{ name: 'dateMention', attrs: { date, reminder: true, userId: memberId } }]);
    appendParagraph(a.doc, 'Rappel d’Alice ', [{ name: 'dateMention', attrs: { date, reminder: true, userId: adminId } }]);
    await stored(page.id, 'Rappel de Marie');
    await stored(page.id, 'Rappel d’Alice');
    m.close();
    a.close();
    const expected = [
      { user_id: memberId, date },
      { user_id: adminId, date },
    ].sort((x, y) => (x.user_id < y.user_id ? -1 : 1));
    assert.deepEqual(reminderRows(page.id), expected);
  });
});

// --- /collab live permission changes ----------------------------------------------------------

describe('QA collab: /collab permission changes on open connections', () => {
  let srv: TestServer;
  let admin: Client;
  let wid: string;

  before(async () => {
    srv = await startTestServer();
    ({ admin, wid } = await setupAdmin(srv.base));
  });
  after(async () => {
    closeAll();
    await srv.stop();
  });

  test('QA-COL-08 (ruled out): a member demoted to viewer while connected can no longer write', async () => {
    const { client: m, user } = await addMember(admin, wid, 'demote@oriel.test', 'Denis', 'member');
    const page = await createPage(admin, wid, { title: 'Rétrogradation' });
    const a = await connectCollab(srv.wsBase, page.id, admin.cookie);
    const c = await connectCollab(srv.wsBase, page.id, m.cookie);
    appendParagraph(c.doc, 'Avant');
    await waitFor(() => docText(a.doc).includes('Avant'), 3000, 'write before demotion');
    expectOk(await admin.patch(`/workspaces/${wid}/members/${user.id}`, { role: 'viewer' }));
    appendParagraph(c.doc, 'Après rétrogradation');
    appendParagraph(a.doc, 'Marqueur admin');
    await waitFor(() => docText(c.doc).includes('Marqueur admin'), 3000, 'viewer still reads');
    await sleep(300);
    assert.doesNotMatch(docText(a.doc), /Après rétrogradation/);
  });

  test('QA-COL-09 (ruled out): a member removed while connected neither reads nor writes anymore', async () => {
    const { client: m, user } = await addMember(admin, wid, 'removed@oriel.test', 'Rémi', 'member');
    const page = await createPage(admin, wid, { title: 'Départ' });
    const a = await connectCollab(srv.wsBase, page.id, admin.cookie);
    const c = await connectCollab(srv.wsBase, page.id, m.cookie);
    appendParagraph(a.doc, 'Commun');
    await waitFor(() => docText(c.doc).includes('Commun'));
    expectOk(await admin.del(`/workspaces/${wid}/members/${user.id}`));
    await sleep(200);
    appendParagraph(c.doc, 'Écrit après le départ');
    appendParagraph(a.doc, 'Secret après le départ');
    await sleep(500);
    assert.doesNotMatch(docText(a.doc), /Écrit après le départ/);
    assert.doesNotMatch(docText(c.doc), /Secret après le départ/);
  });

  test('QA-COL-10 (ruled out): a page moved to its owner’s private section stops streaming to other members', async () => {
    const { client: m } = await addMember(admin, wid, 'peer@oriel.test', 'Paul', 'member');
    const page = await createPage(admin, wid, { title: 'Devient privée' });
    const a = await connectCollab(srv.wsBase, page.id, admin.cookie);
    const c = await connectCollab(srv.wsBase, page.id, m.cookie);
    appendParagraph(a.doc, 'Partagé');
    await waitFor(() => docText(c.doc).includes('Partagé'));
    expectOk(await admin.post(`/pages/${page.id}/move`, { parentType: 'workspace', parentId: wid, visibility: 'private' }));
    await sleep(200);
    appendParagraph(a.doc, 'Désormais privé');
    appendParagraph(c.doc, 'Intrusion');
    await sleep(500);
    assert.doesNotMatch(docText(c.doc), /Désormais privé/);
    assert.doesNotMatch(docText(a.doc), /Intrusion/);
    // Re-opening the document is refused.
    const raw = await RawCollab.open(srv.wsBase, m.cookie);
    assert.equal(await raw.auth(page.id), 'denied');
  });

  test('QA-COL-12 (ruled out): cross-site /collab upgrades, rows of a private database and document name tricks are refused', async () => {
    const { client: m } = await addMember(admin, wid, 'rows@oriel.test', 'Rosa', 'member');
    // Cross-site WebSocket hijacking with the session cookie.
    await assert.rejects(
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`${srv.wsBase}/collab`, { headers: { cookie: `oriel_session=${m.cookie}`, origin: 'https://evil.example' } });
        ws.on('open', () => {
          ws.close();
          resolve();
        });
        ws.on('error', reject);
      }),
      /403/,
    );
    // Rows (and the database itself) inherit the privacy of a private database.
    const db = await createPage(admin, wid, { kind: 'database', title: 'Base privée', visibility: 'private' });
    const row = expectOk(await admin.post<{ id: string }>(`/databases/${db.id}/rows`, { title: 'Ligne secrète' }));
    const raw = await RawCollab.open(srv.wsBase, m.cookie);
    assert.equal(await raw.auth(db.id), 'denied');
    assert.equal(await raw.auth(row.id), 'denied');
    const shared = await createPage(admin, wid, { title: 'Partagée' });
    for (const name of [`${shared.id}/x`, ` ${shared.id}`, `${shared.id.toUpperCase()}`, `${db.id}\u0000`]) {
      assert.equal(await raw.auth(name), 'denied', `document name ${JSON.stringify(name)}`);
    }
  });

  test('QA-COL-11: anonymous visitors of a published page do not receive the presence (names, ids) of members', async () => {
    const { client: m } = await addMember(admin, wid, 'presence@oriel.test', 'Prisca Présente', 'member');
    const page = await createPage(admin, wid, { title: 'Publiée' });
    expectOk(await admin.post(`/pages/${page.id}/publish`, { isPublic: true }));
    const c = await connectCollab(srv.wsBase, page.id, m.cookie);
    c.provider.setAwarenessField('user', { name: 'Prisca Présente', color: '#123456' });
    const anon = await RawCollab.open(srv.wsBase, null);
    assert.equal(await anon.auth(page.id), 'authenticated:readonly');
    // A member on the same page does see the presence (control).
    const peer = await RawCollab.open(srv.wsBase, admin.cookie);
    assert.equal(await peer.auth(page.id), 'authenticated:read-write');
    c.provider.setAwarenessField('user', { name: 'Prisca Présente', color: '#654321' });
    await waitFor(() => peer.names().includes('Prisca Présente'), 3000, 'member sees presence');
    await sleep(200);
    assert.deepEqual(anon.names(), [], 'member presence relayed to anonymous visitors');
  });
});

// --- /collab: Yjs structures accepted from editors ------------------------------------------------

/**
 * A page document no editor can write any more (stored before the /collab checks): 10 000 nested
 * blocks (the former recursive walkers overflowed the stack around 8 000) ending with a text, a
 * person mention, a date reminder and a linked database; a shallow block; a Y.Map in the fragment.
 */
function legacyHostileState(opts: { mentioned: string; reminded: string; date: string; databaseId: string }): Uint8Array {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('blocknote');
  doc.transact(() => {
    const group = new Y.XmlElement('blockGroup');
    fragment.insert(0, [group, new Y.Map() as unknown as Y.XmlElement]);
    const bottom = nest(doc, group, 10_000);
    const paragraph = new Y.XmlElement('paragraph');
    bottom.insert(0, [paragraph]);
    const text = new Y.XmlText();
    paragraph.insert(0, [text]);
    text.insert(0, 'Tout au fond ');
    const mention = new Y.XmlElement('userMention');
    paragraph.insert(1, [mention]);
    mention.setAttribute('userId', opts.mentioned);
    const reminder = new Y.XmlElement('dateMention');
    paragraph.insert(2, [reminder]);
    reminder.setAttribute('date', opts.date);
    reminder.setAttribute('reminder', true as never);
    reminder.setAttribute('userId', opts.reminded);
    const linked = new Y.XmlElement('linkedDatabase');
    bottom.insert(1, [linked]);
    linked.setAttribute('linkId', 'lien-1');
    linked.setAttribute('databaseId', opts.databaseId);
    const shallow = new Y.XmlElement('blockContainer');
    group.insert(1, [shallow]);
    const p = new Y.XmlElement('paragraph');
    shallow.insert(0, [p]);
    const t = new Y.XmlText();
    p.insert(0, [t]);
    t.insert(0, 'Surface');
  });
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}

describe('QA collab: Yjs structures accepted on /collab', () => {
  let srv: TestServer;
  let ctx: AppContext;
  let admin: Client;
  let adminId: string;
  let wid: string;
  let memberId: string;

  before(async () => {
    srv = await startTestServer();
    ctx = collabContexts.get(srv.dataDir)!;
    const a = await setupAdmin(srv.base);
    admin = a.admin;
    adminId = a.session.user.id;
    wid = a.wid;
    memberId = (await addMember(admin, wid, 'mona@oriel.test', 'Mona', 'member')).user.id;
  });
  after(async () => {
    closeAll();
    await srv.stop();
  });

  const storedText = (pageId: string) => ctx.db.get<{ text: string }>('SELECT text FROM documents WHERE page_id = ?', pageId)?.text ?? '';
  /** A raw editor connection of the administrator, authenticated on the page. */
  const editor = async (pageId: string) => {
    const raw = await RawCollab.open(srv.wsBase, admin.cookie);
    assert.equal(await raw.auth(pageId), 'authenticated:read-write');
    return raw;
  };
  const paragraph = (fragment: Y.XmlFragment, value?: string): Y.XmlElement => {
    const p = new Y.XmlElement('paragraph');
    fragment.insert(fragment.length, [p]);
    if (value !== undefined) {
      const t = new Y.XmlText();
      p.insert(0, [t]);
      t.insert(0, value);
    }
    return p;
  };

  test('a Y.Map, a Y.Text, a typed attribute, an embedded type, a raw value or another root type is refused before reaching the document', async () => {
    const page = await createPage(admin, wid, { title: 'Structures' });
    const peer = await connectCollab(srv.wsBase, page.id, admin.cookie);
    appendParagraph(peer.doc, 'Début');
    await waitFor(() => storedText(page.id).includes('Début'), 5000, 'first store');
    const hostile: Array<[string, (doc: Y.Doc, fragment: Y.XmlFragment) => void]> = [
      ['Y.Map in the fragment', (_d, f) => f.insert(f.length, [new Y.Map() as unknown as Y.XmlElement])],
      ['raw value in the fragment', (_d, f) => f.insert(f.length, ['brut' as unknown as Y.XmlText])],
      ['Y.Text in a block', (_d, f) => paragraph(f).insert(0, [new Y.Text('pas du XmlText') as unknown as Y.XmlText])],
      ['type as an attribute value', (_d, f) => paragraph(f).setAttribute('textColor', new Y.Map() as never)],
      [
        'type embedded in a text',
        (_d, f) => {
          const t = new Y.XmlText();
          paragraph(f).insert(0, [t]);
          t.insertEmbed(0, new Y.Map());
        },
      ],
      ['another root type', (d) => d.getMap('threads').set('x', 'pirate')],
    ];
    for (const [label, change] of hostile) {
      const raw = await editor(page.id);
      assert.equal(await raw.push(page.id, await forge(admin, page.id, change)), 'closed', label);
      raw.close();
    }
    // Control: a valid update sent the same way is applied and relayed (after the refused ones).
    const raw = await editor(page.id);
    assert.equal(await raw.push(page.id, await forge(admin, page.id, (_d, f) => void paragraph(f, 'Témoin'))), 'saved');
    raw.close();
    await waitFor(() => docText(peer.doc).includes('Témoin'), 3000, 'valid update relayed');
    assert.deepEqual(problems(peer.doc), [], 'refused structure relayed to an editor');
    assert.deepEqual(problems(await serverDoc(admin, page.id)), [], 'refused structure in the server document');
    // Editors keep working.
    appendParagraph(peer.doc, 'Toujours éditable');
    await waitFor(() => storedText(page.id).includes('Toujours éditable'), 5000, 'store after the refusals');
    peer.close();
  });

  test('the page content API applies the same rules to texts and attributes (typed attribute, embedded type)', async () => {
    const page = await createPage(admin, wid, { title: 'Import' });
    const build = (change: (p: Y.XmlElement) => void) => {
      const doc = new Y.Doc();
      const f = doc.getXmlFragment('blocknote');
      const group = new Y.XmlElement('blockGroup');
      f.insert(0, [group]);
      const container = new Y.XmlElement('blockContainer');
      group.insert(0, [container]);
      const p = new Y.XmlElement('paragraph');
      container.insert(0, [p]);
      change(p);
      return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
    };
    const typedAttribute = build((p) => p.setAttribute('textColor', new Y.Map() as never));
    const embedded = build((p) => {
      const t = new Y.XmlText();
      p.insert(0, [t]);
      t.insertEmbed(0, new Y.Map());
    });
    for (const update of [typedAttribute, embedded]) {
      for (const mode of ['replace', 'append'] as const) {
        const res = await admin.put(`/pages/${page.id}/content`, { update, mode });
        assert.equal(res.status, 400, mode);
      }
    }
    assert.deepEqual(problems(await serverDoc(admin, page.id)), []);
  });

  test('nesting: 256 levels are accepted, one more is refused, also when added under existing blocks', async () => {
    const page = await createPage(admin, wid, { title: 'Imbrication' });
    let raw = await editor(page.id);
    assert.equal(await raw.push(page.id, await forge(admin, page.id, (d, f) => void nest(d, f, MAX_CONTENT_DEPTH + 1))), 'closed', '257 levels');
    raw.close();
    raw = await editor(page.id);
    assert.equal(await raw.push(page.id, await forge(admin, page.id, (d, f) => void nest(d, f, 200))), 'saved', '200 levels');
    assert.equal(await raw.push(page.id, await forge(admin, page.id, (d) => void nest(d, deepest(d).el!, 57))), 'closed', '200 + 57 levels');
    raw.close();
    raw = await editor(page.id);
    assert.equal(await raw.push(page.id, await forge(admin, page.id, (d) => void nest(d, deepest(d).el!, 56))), 'saved', '200 + 56 levels');
    raw.close();
    const doc = await serverDoc(admin, page.id);
    assert.equal(deepest(doc).depth, MAX_CONTENT_DEPTH);
    assert.deepEqual(problems(doc), []);
  });

  test('a re-sent item cannot lie about its place in the document', async () => {
    const page = await createPage(admin, wid, { title: 'Usurpation' });
    const client = 424242;
    const raw = await editor(page.id);
    // Client 424242 writes a chain of 256 levels (clocks 0…255)…
    const chain = await forge(admin, page.id, (d, f) => {
      d.clientID = client;
      nest(d, f, MAX_CONTENT_DEPTH);
    });
    assert.equal(await raw.push(page.id, chain), 'saved');
    // …then claims, in a document of its own, that clock 255 is a top-level block, and adds a child to it.
    const liar = new Y.Doc();
    liar.clientID = client;
    const f = liar.getXmlFragment('blocknote');
    liar.transact(() => {
      for (let i = 0; i < MAX_CONTENT_DEPTH; i++) f.insert(f.length, [new Y.XmlElement('blockContainer')]);
    });
    (f.get(MAX_CONTENT_DEPTH - 1) as Y.XmlElement).insert(0, [new Y.XmlElement('blockContainer')]);
    assert.equal(await raw.push(page.id, Y.encodeStateAsUpdate(liar)), 'closed', 'child integrated at depth 257');
    raw.close();
    assert.equal(deepest(await serverDoc(admin, page.id)).depth, MAX_CONTENT_DEPTH);
  });

  test('an item whose parent is missing is left out, and not integrated when the parent arrives later', async () => {
    const page = await createPage(admin, wid, { title: 'En attente' });
    const doc = await serverDoc(admin, page.id);
    const start = Y.encodeStateVector(doc);
    const p = paragraph(doc.getXmlFragment('blocknote'));
    const withParent = Y.encodeStateAsUpdate(doc, start);
    const middle = Y.encodeStateVector(doc);
    p.insert(0, [new Y.Map() as unknown as Y.XmlElement]);
    const orphan = Y.encodeStateAsUpdate(doc, middle);
    const raw = await editor(page.id);
    // Parent unknown: nothing to check yet; Yjs keeps the item pending and the server drops it.
    assert.equal(await raw.push(page.id, orphan), 'saved');
    assert.equal(await raw.push(page.id, withParent), 'saved');
    raw.close();
    const server = await serverDoc(admin, page.id);
    const first = server.getXmlFragment('blocknote').get(0);
    assert.ok(first instanceof Y.XmlElement && first.nodeName === 'paragraph');
    assert.equal(first.length, 0, 'pending Y.Map integrated once its parent arrived');
    assert.deepEqual(problems(server), []);
  });

  test('server walkers survive documents stored before the checks: save, mentions, duplication, snapshot restore', async () => {
    const linked = await createPage(admin, wid, { kind: 'database', title: 'Base liée' });
    const date = addDays(parisToday(), 2);
    const state = legacyHostileState({ mentioned: memberId, reminded: adminId, date, databaseId: linked.id });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    const { text, links } = extractContent(doc);
    assert.match(text, /Tout au fond/);
    assert.match(text, /Surface/);
    assert.ok(links.includes(linked.id));
    const refs = extractCollabRefs(doc);
    assert.deepEqual(refs.mentions.map((m) => m.userId), [memberId]);
    assert.match(refs.mentions[0]!.context, /^Tout au fond @\{/);
    assert.deepEqual(refs.reminders.map((r) => [r.userId, r.date]), [[adminId, date]]);
    assert.ok(remapState(state, new Map([[linked.id, 'ailleurs']])).links.includes('ailleurs'));
    doc.destroy();

    // A page holding it stays editable over /collab, is saved and can be duplicated.
    const page = await createPage(admin, wid, { title: 'Héritage' });
    ctx.db.run(
      `INSERT INTO documents (page_id, state, text, updated_at, editors) VALUES (?, ?, '', ?, '[]')
       ON CONFLICT(page_id) DO UPDATE SET state = excluded.state`,
      page.id,
      state,
      Date.now(),
    );
    const c = await connectCollab(srv.wsBase, page.id, admin.cookie);
    appendParagraph(c.doc, 'Encore éditable');
    await waitFor(() => storedText(page.id).includes('Encore éditable'), 10_000, 'store of the legacy page');
    assert.match(storedText(page.id), /Tout au fond/);
    c.close();
    const copy = expectOk(await admin.post<Page>(`/pages/${page.id}/duplicate`));
    assert.match(storedText(copy.id), /Tout au fond/);

    // Restoring such a snapshot keeps what the editor renders, within the limits.
    const target = await createPage(admin, wid, { title: 'Restauration' });
    const sid = crypto.randomUUID();
    ctx.db.run("INSERT INTO snapshots (id, page_id, state, created_at, authors, reason) VALUES (?, ?, ?, ?, '[]', 'auto')", sid, target.id, state, Date.now());
    expectOk(await admin.post(`/pages/${target.id}/snapshots/${sid}/restore`));
    const restored = await serverDoc(admin, target.id);
    assert.deepEqual(problems(restored), []);
    // Since QA-G6-01 a block that loses its content beyond the limit is dropped (here, the whole
    // chain of empty containers): the restored document stays within the limit.
    assert.ok(deepest(restored).depth <= MAX_CONTENT_DEPTH);
    assert.match(extractContent(restored).text, /Surface/);
  });
});
