// Collab module: comments (permissions, notifications), page mentions diffing, date reminders,
// e-mail rendering (nodemailer JSON transport), invitations.
process.env.SMTP_URL = 'json:quiet';
process.env.MAIL_FROM = 'Oriel <oriel@oriel.test>';

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import type {
  Change,
  CommentItem,
  CommentThread,
  EmailInviteResponse,
  Invite,
  NotificationsResponse,
  ServerMessage,
  ThreadsResponse,
  UnreadCountResponse,
} from '@oriel/shared';
import { Client, addMember, createPage, expectOk, setupAdmin, signup, sleep, startTestServer, waitFor, type TestServer } from './helpers.js';
import { collabContexts } from '../src/routes/collab.js';
import { mailOutbox } from '../src/collab/mailer.js';
import { runDigestIfDue, runReminders } from '../src/collab/jobs.js';
import { parisToday } from '../src/collab/time.js';
import type { AppContext } from '../src/context.js';

// --- helpers ------------------------------------------------------------------------------

const para = (...content: unknown[]) => [{ type: 'paragraph', props: {}, content, children: [] }];
const text = (t: string) => ({ type: 'text', text: t, styles: {} });
const mention = (userId: string) => ({ type: 'userMention', props: { userId } });

async function connectEvents(wsBase: string, cookie: string | null, wid: string) {
  const ws = new WebSocket(`${wsBase}/api/events`, { headers: cookie ? { cookie: `oriel_session=${cookie}` } : {} });
  const messages: ServerMessage[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  ws.send(JSON.stringify({ type: 'subscribe', workspaceId: wid }));
  await waitFor(() => messages.some((m) => m.type === 'subscribed'), 3000, 'subscribed');
  return { ws, changes: (): Change[] => messages.flatMap((m) => (m.type === 'changes' ? m.changes : [])), close: () => ws.close() };
}

async function connectCollab(wsBase: string, pageId: string, cookie: string) {
  class CookieWebSocket extends WebSocket {
    constructor(url: string) {
      super(url, { headers: { cookie: `oriel_session=${cookie}` } });
    }
  }
  const socket = new HocuspocusProviderWebsocket({ url: `${wsBase}/collab`, WebSocketPolyfill: CookieWebSocket });
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({ websocketProvider: socket, name: `page:${pageId}`, document: doc });
  provider.attach();
  await waitFor(() => provider.isSynced, 5000, 'collab sync');
  return {
    doc,
    close() {
      provider.destroy();
      socket.destroy();
    },
  };
}

/** Appends a paragraph "text + inline items" to a BlockNote Yjs document. Returns the inline elements. */
function appendParagraph(doc: Y.Doc, value: string, inline: Array<{ name: string; attrs: Record<string, unknown> }> = []): Y.XmlElement[] {
  const fragment = doc.getXmlFragment('blocknote');
  const created: Y.XmlElement[] = [];
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
      created.push(el);
    }
    paragraph.insert(0, items);
    container.insert(0, [paragraph]);
    group.insert(group.length, [container]);
  });
  return created;
}

function removeElement(el: Y.XmlElement) {
  const parent = el.parent as Y.XmlElement;
  const index = parent.toArray().indexOf(el);
  parent.delete(index, 1);
}

const notifications = async (c: Client, wid: string) => expectOk(await c.get<NotificationsResponse>(`/workspaces/${wid}/notifications`)).notifications;

function parisMs(date: string, hour: number, minute = 0): number {
  // Europe/Paris is UTC+1 or UTC+2: find the UTC instant whose Paris wall clock matches.
  for (const offset of [1, 2]) {
    const t = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hour - offset, minute);
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' }).format(new Date(t));
    if (Number(parts) === hour) return t;
  }
  throw new Error('no Paris time');
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// --- tests --------------------------------------------------------------------------------

describe('collab: comments, mentions, notifications, e-mail', () => {
  let srv: TestServer;
  let ctx: AppContext;
  let admin: Client;
  let adminId: string;
  let wid: string;
  let member: Client;
  let memberId: string;
  let viewer: Client;
  let viewerId: string;
  let outsider: Client;
  let pageId: string;

  before(async () => {
    srv = await startTestServer();
    ctx = collabContexts.get(srv.dataDir)!;
    assert.ok(ctx, 'collab context registered');
    const a = await setupAdmin(srv.base);
    admin = a.admin;
    adminId = a.session.user.id;
    wid = a.wid;
    const m = await addMember(admin, wid, 'marie@oriel.test', 'Marie Curie', 'member');
    member = m.client;
    memberId = m.user.id;
    const v = await addMember(admin, wid, 'victor@oriel.test', 'Victor Hugo', 'viewer');
    viewer = v.client;
    viewerId = v.user.id;
    outsider = (await signup(srv.base, 'out@oriel.test', 'Olivier Dehors', expectOk(await admin.post<Invite>(`/workspaces/${wid}/invites`, { role: 'member' })).token)).client;
    // The outsider leaves the workspace: no access anymore.
    const outId = expectOk(await outsider.get('/auth/me')).user.id;
    expectOk(await admin.del(`/workspaces/${wid}/members/${outId}`));
    pageId = (await createPage(admin, wid, { title: 'Plan de projet' })).id;
  });
  after(async () => {
    await srv.stop();
  });

  test('comment permissions: members write, viewers read only, others see nothing', async () => {
    const created = expectOk(
      await member.post<CommentThread>(`/pages/${pageId}/threads`, { anchored: true, quote: 'Jour 1', body: para(text('À valider '), mention(viewerId)) }),
    );
    assert.equal(created.comments.length, 1);
    assert.equal(created.anchored, true);
    assert.equal(created.quote, 'Jour 1');

    const list = expectOk(await viewer.get<ThreadsResponse>(`/pages/${pageId}/threads`));
    assert.equal(list.threads.length, 1);
    assert.equal(list.canComment, false);
    assert.ok(list.users.some((u) => u.id === memberId));

    assert.equal((await viewer.post(`/pages/${pageId}/threads`, { anchored: false, body: para(text('Non')) })).status, 403);
    assert.equal((await viewer.post(`/threads/${created.id}/comments`, { body: para(text('Non')) })).status, 403);
    assert.equal((await viewer.put(`/comments/${created.comments[0]!.id}/reactions`, { emoji: '👍', active: true })).status, 403);
    assert.equal((await viewer.post(`/threads/${created.id}/resolve`, { resolved: true })).status, 403);

    assert.equal((await outsider.get(`/pages/${pageId}/threads`)).status, 404);
    assert.equal((await outsider.post(`/threads/${created.id}/comments`, { body: para(text('x')) })).status, 404);
    assert.equal((await new Client(srv.base).get(`/pages/${pageId}/threads`)).status, 401);

    // Private page of the admin: invisible to the member.
    const priv = await createPage(admin, wid, { title: 'Privé', visibility: 'private' });
    assert.equal((await member.get(`/pages/${priv.id}/threads`)).status, 404);
    assert.equal((await member.post(`/pages/${priv.id}/threads`, { anchored: false, body: para(text('x')) })).status, 404);

    // Empty / invalid bodies.
    assert.equal((await member.post(`/pages/${pageId}/threads`, { anchored: false, body: [] })).status, 400);
    assert.equal((await member.post(`/pages/${pageId}/threads`, { anchored: false, body: 'texte' })).status, 400);
  });

  test('new thread notifies mentioned people and the page creator', async () => {
    const viewerNotifs = await notifications(viewer, wid);
    assert.equal(viewerNotifs.length, 1);
    assert.equal(viewerNotifs[0]!.type, 'comment_mention');
    assert.equal(viewerNotifs[0]!.actor?.id, memberId);
    assert.equal(viewerNotifs[0]!.page?.id, pageId);
    assert.match(viewerNotifs[0]!.excerpt, /À valider @Victor Hugo/);
    const adminNotifs = await notifications(admin, wid);
    const creatorNotif = adminNotifs.find((n) => n.type === 'comment');
    assert.ok(creatorNotif, 'page creator notified');
    assert.ok(creatorNotif!.threadId);
    // Nobody is notified of their own comment.
    assert.equal((await notifications(member, wid)).length, 0);
  });

  test('replies notify participants once; edit/delete/reactions/resolve rules', async () => {
    const thread = expectOk(await member.get<ThreadsResponse>(`/pages/${pageId}/threads`)).threads[0]!;
    const before = (await notifications(member, wid)).length;
    const reply = expectOk(await admin.post<CommentItem>(`/threads/${thread.id}/comments`, { body: para(text('OK pour moi')) }));
    const memberNotifs = await notifications(member, wid);
    assert.equal(memberNotifs.length, before + 1);
    assert.equal(memberNotifs[0]!.type, 'reply');
    assert.equal(memberNotifs[0]!.excerpt, 'OK pour moi');
    // Admin (page creator, participant now) replying again: member notified, admin not.
    const adminCount = (await notifications(admin, wid)).length;
    expectOk(await member.post(`/threads/${thread.id}/comments`, { body: para(text('Merci')) }));
    assert.equal((await notifications(admin, wid)).length, adminCount + 1);
    assert.equal((await notifications(admin, wid))[0]!.type, 'reply');

    // Only the author edits.
    assert.equal((await member.patch(`/comments/${reply.id}`, { body: para(text('pirate')) })).status, 403);
    const edited = expectOk(await admin.patch<CommentItem>(`/comments/${reply.id}`, { body: para(text('OK, avec '), mention(memberId)) }));
    assert.ok(edited.updatedAt >= edited.createdAt);
    // Newly added mention in an edit notifies.
    assert.equal((await notifications(member, wid))[0]!.type, 'comment_mention');

    // Reactions toggle.
    let c = expectOk(await member.put<CommentItem>(`/comments/${reply.id}/reactions`, { emoji: '👍', active: true }));
    c = expectOk(await viewer.get<ThreadsResponse>(`/pages/${pageId}/threads`)).threads[0]!.comments.find((x) => x.id === reply.id)!;
    assert.deepEqual(c.reactions.map((r) => [r.emoji, r.userIds]), [['👍', [memberId]]]);
    c = expectOk(await admin.put<CommentItem>(`/comments/${reply.id}/reactions`, { emoji: '👍', active: true }));
    assert.deepEqual(c.reactions[0]!.userIds.sort(), [adminId, memberId].sort());
    c = expectOk(await member.put<CommentItem>(`/comments/${reply.id}/reactions`, { emoji: '👍', active: false }));
    assert.deepEqual(c.reactions[0]!.userIds, [adminId]);

    // Resolve / reopen by any member.
    let t = expectOk(await member.post<CommentThread>(`/threads/${thread.id}/resolve`, { resolved: true }));
    assert.equal(t.resolved, true);
    assert.equal(t.resolvedBy, memberId);
    t = expectOk(await admin.post<CommentThread>(`/threads/${thread.id}/resolve`, { resolved: false }));
    assert.equal(t.resolved, false);

    // Delete: member cannot delete the admin's comment, admin (moderator) can delete anyone's.
    assert.equal((await member.del(`/comments/${reply.id}`)).status, 403);
    const firstId = thread.comments[0]!.id;
    expectOk(await admin.del(`/comments/${firstId}`));
    const after = expectOk(await admin.get<ThreadsResponse>(`/pages/${pageId}/threads`)).threads[0]!;
    assert.ok(!after.comments.some((x) => x.id === firstId));
    // Deleting the last comments removes the thread.
    for (const x of after.comments) expectOk(await admin.del(`/comments/${x.id}`));
    assert.equal(expectOk(await admin.get<ThreadsResponse>(`/pages/${pageId}/threads`)).threads.length, 0);
  });

  test('page-level discussion + real-time "comments" and per-user "notifications" changes', async () => {
    const adminEvents = await connectEvents(srv.wsBase, admin.cookie, wid);
    const viewerEvents = await connectEvents(srv.wsBase, viewer.cookie, wid);
    try {
      const t = expectOk(await member.post<CommentThread>(`/pages/${pageId}/threads`, { anchored: false, body: para(text('Discussion générale')) }));
      assert.equal(t.anchored, false);
      await waitFor(() => adminEvents.changes().some((c) => c.entity === 'comments' && c.pageId === pageId), 3000, 'comments change');
      await waitFor(() => viewerEvents.changes().some((c) => c.entity === 'comments'), 3000, 'viewer comments change');
      await waitFor(() => adminEvents.changes().some((c) => c.entity === 'notifications'), 3000, 'admin notifications change');
      await sleep(100);
      assert.ok(!viewerEvents.changes().some((c) => c.entity === 'notifications'), 'notifications are private');
    } finally {
      adminEvents.close();
      viewerEvents.close();
    }
  });

  test('inbox: unread count, mark read, read all, archive', async () => {
    // (Notifications of deleted comments are archived: create a fresh one.)
    expectOk(await member.post(`/pages/${pageId}/threads`, { anchored: false, body: para(text('Pour '), mention(viewerId)) }));
    const before = expectOk(await viewer.get<UnreadCountResponse>(`/workspaces/${wid}/notifications/unread`)).unread;
    assert.ok(before >= 1);
    const list = await notifications(viewer, wid);
    expectOk(await viewer.patch(`/notifications/${list[0]!.id}`, { read: true }));
    assert.equal(expectOk(await viewer.get<UnreadCountResponse>(`/workspaces/${wid}/notifications/unread`)).unread, before - 1);
    assert.equal((await member.patch(`/notifications/${list[0]!.id}`, { read: true })).status, 404);
    expectOk(await viewer.patch(`/notifications/${list[0]!.id}`, { archived: true }));
    assert.ok(!(await notifications(viewer, wid)).some((n) => n.id === list[0]!.id));
    const archived = expectOk(await viewer.get<NotificationsResponse>(`/workspaces/${wid}/notifications?filter=archived`)).notifications;
    assert.ok(archived.some((n) => n.id === list[0]!.id));
    expectOk(await admin.post(`/workspaces/${wid}/notifications/read-all`));
    assert.equal(expectOk(await admin.get<UnreadCountResponse>(`/workspaces/${wid}/notifications/unread`)).unread, 0);
    assert.equal((await outsider.get(`/workspaces/${wid}/notifications`)).status, 404);
  });

  test('page mentions: only NEW mentions notify (diff against known mentions)', async () => {
    const page = await createPage(member, wid, { title: 'Compte rendu' });
    const collab = await connectCollab(srv.wsBase, page.id, member.cookie!);
    try {
      const count = async () => (await notifications(viewer, wid)).filter((n) => n.type === 'mention' && n.page?.id === page.id).length;
      const [m1] = appendParagraph(collab.doc, 'Merci ', [{ name: 'userMention', attrs: { userId: viewerId } }]);
      await waitFor(async () => (await count()) === 1, 5000, 'first mention notification');
      const n = (await notifications(viewer, wid)).find((x) => x.type === 'mention')!;
      assert.equal(n.actor?.id, memberId);
      assert.match(n.excerpt, /Merci @Victor Hugo/);
      // Same mention again elsewhere + unrelated edit: no new notification.
      appendParagraph(collab.doc, 'Encore ', [{ name: 'userMention', attrs: { userId: viewerId } }]);
      appendParagraph(collab.doc, 'Texte sans mention');
      await sleep(600);
      assert.equal(await count(), 1);
      // Self-mention never notifies.
      appendParagraph(collab.doc, 'Moi ', [{ name: 'userMention', attrs: { userId: memberId } }]);
      await sleep(600);
      assert.equal((await notifications(member, wid)).filter((x) => x.type === 'mention').length, 0);
      // Remove every mention of the viewer, store, then mention again: notifies again.
      collab.doc.transact(() => {
        removeElement(m1!);
      });
      const fragment = collab.doc.getXmlFragment('blocknote');
      collab.doc.transact(() => {
        const walk = (el: Y.XmlElement | Y.XmlFragment) => {
          for (const child of el.toArray()) {
            if (child instanceof Y.XmlElement) {
              if (child.nodeName === 'userMention' && child.getAttribute('userId') === viewerId) removeElement(child);
              else walk(child);
            }
          }
        };
        walk(fragment);
      });
      await sleep(600);
      appendParagraph(collab.doc, 'Retour ', [{ name: 'userMention', attrs: { userId: viewerId } }]);
      await waitFor(async () => (await count()) === 2, 5000, 'second mention notification');
      // Outsiders (not members) are never notified.
      appendParagraph(collab.doc, 'Ext ', [{ name: 'userMention', attrs: { userId: 'not-a-member' } }]);
      await sleep(400);
    } finally {
      collab.close();
    }
  });

  test('date reminders fire at 09:00 Europe/Paris on the date, once, for the reminder creator', async () => {
    const page = await createPage(member, wid, { title: 'Livraison' });
    const date = addDays(parisToday(), 2);
    const collab = await connectCollab(srv.wsBase, page.id, member.cookie!);
    try {
      appendParagraph(collab.doc, 'Livraison le ', [{ name: 'dateMention', attrs: { date, reminder: true, userId: memberId } }]);
      appendParagraph(collab.doc, 'Sans rappel ', [{ name: 'dateMention', attrs: { date, reminder: false, userId: '' } }]);
      await waitFor(() => ctx.db.get('SELECT 1 AS x FROM collab_reminders WHERE page_id = ?', page.id), 5000, 'reminder stored');
    } finally {
      collab.close();
    }
    const rows = ctx.db.all<{ user_id: string; date: string }>('SELECT user_id, date FROM collab_reminders WHERE page_id = ?', page.id);
    assert.deepEqual(rows.map((r) => ({ ...r })), [{ user_id: memberId, date }]);
    const reminders = async () => (await notifications(member, wid)).filter((n) => n.type === 'reminder');
    assert.equal(runReminders(ctx, parisMs(addDays(date, -1), 10)), 0, 'not the day before');
    assert.equal(runReminders(ctx, parisMs(date, 8, 59)), 0, 'not before 09:00');
    assert.equal(runReminders(ctx, parisMs(date, 9, 1)), 1, 'fires at 09:00');
    assert.equal(runReminders(ctx, parisMs(date, 10)), 0, 'only once');
    const r = await reminders();
    assert.equal(r.length, 1);
    assert.equal(r[0]!.date, date);
    assert.equal(r[0]!.page?.id, page.id);
    assert.equal(r[0]!.actor, null);
  });

  test('e-mails: immediate notifications and daily digest (JSON transport)', async () => {
    expectOk(await viewer.patch('/me/notification-settings', { emailFrequency: 'immediate' }));
    const settings = expectOk(await viewer.get('/me/notification-settings'));
    assert.deepEqual(settings, { emailFrequency: 'immediate', emailEnabled: true });
    assert.equal((await viewer.patch('/me/notification-settings', { emailFrequency: 'weekly' })).status, 400);

    const start = mailOutbox.length;
    expectOk(await member.post(`/pages/${pageId}/threads`, { anchored: false, body: para(text('Regarde ça '), mention(viewerId)) }));
    const mail = await waitFor(() => mailOutbox.slice(start).find((m) => m.to === 'victor@oriel.test'), 3000, 'immediate mail');
    assert.equal(mail.subject, 'Marie Curie vous a mentionné dans un commentaire sur « Plan de projet »');
    assert.match(mail.text, /Regarde ça @Victor Hugo/);
    assert.match(mail.text, new RegExp(`/w/${wid}/p/${pageId}\\?thread=`));
    assert.match(mail.html, /<!doctype html>/);
    assert.match(mail.html, /Oriel/);
    assert.equal(mail.from, 'Oriel <oriel@oriel.test>');
    // HTML is escaped.
    expectOk(await member.post(`/pages/${pageId}/threads`, { anchored: false, body: para(text('<script>alert(1)</script> '), mention(viewerId)) }));
    const escaped = await waitFor(() => mailOutbox.slice(start).find((m) => m.text.includes('<script>')), 3000, 'escaped mail');
    assert.ok(!escaped.html.includes('<script>alert(1)</script>'));
    assert.ok(escaped.html.includes('&lt;script&gt;'));

    // Daily digest: admin (default "daily") gets one digest with the pending notifications.
    const adminPending = (await notifications(admin, wid)).filter((n) => !n.readAt).length;
    assert.ok(adminPending > 0);
    const beforeDigest = mailOutbox.length;
    const today = parisToday();
    assert.equal(await runDigestIfDue(ctx, parisMs(today, 7, 30)), 0, 'not before 08:00');
    const sent = await runDigestIfDue(ctx, parisMs(today, 8, 5));
    assert.ok(sent >= 1);
    const digest = mailOutbox.slice(beforeDigest).find((m) => m.to === 'admin@oriel.test');
    assert.ok(digest, 'digest to admin');
    assert.match(digest!.subject, /^Oriel : \d+ nouvelles? notifications?$/);
    assert.match(digest!.text, /Votre résumé du jour/);
    assert.ok(!mailOutbox.slice(beforeDigest).some((m) => m.to === 'victor@oriel.test'), 'immediate users get no digest');
    assert.equal(await runDigestIfDue(ctx, parisMs(today, 9)), 0, 'once a day');
  });

  test('invitation accepted notifies the inviter (signup and existing account)', async () => {
    const before = (await notifications(admin, wid)).filter((n) => n.type === 'invite_accepted').length;
    await addMember(admin, wid, 'nina@oriel.test', 'Nina Simone', 'member');
    let list = (await notifications(admin, wid)).filter((n) => n.type === 'invite_accepted');
    assert.equal(list.length, before + 1);
    assert.equal(list[0]!.actor?.name, 'Nina Simone');
    assert.equal(list[0]!.role, 'member');
    // Existing account accepting a link (route of the core module).
    const invite = expectOk(await admin.post<Invite>(`/workspaces/${wid}/invites`, { role: 'viewer' }));
    expectOk(await outsider.post(`/invites/${invite.token}/accept`));
    list = (await notifications(admin, wid)).filter((n) => n.type === 'invite_accepted');
    assert.equal(list.length, before + 2);
    assert.equal(list[0]!.actor?.name, 'Olivier Dehors');
    // Accepting again (already a member) does not notify.
    expectOk(await outsider.post(`/invites/${invite.token}/accept`));
    assert.equal((await notifications(admin, wid)).filter((n) => n.type === 'invite_accepted').length, before + 2);
  });

  test('invitation by e-mail', async () => {
    const start = mailOutbox.length;
    const res = expectOk(await admin.post<EmailInviteResponse>(`/workspaces/${wid}/invites/email`, { email: 'Paul@Oriel.test', role: 'member' }));
    assert.equal(res.emailed, true);
    assert.equal(res.invite.role, 'member');
    const mail = mailOutbox.slice(start).find((m) => m.to === 'paul@oriel.test');
    assert.ok(mail);
    assert.match(mail!.subject, /vous invite à rejoindre/);
    assert.ok(mail!.text.includes(`/invite/${res.invite.token}`));
    assert.equal((await member.post(`/workspaces/${wid}/invites/email`, { email: 'x@oriel.test', role: 'member' })).status, 403);
    assert.equal((await admin.post(`/workspaces/${wid}/invites/email`, { email: 'marie@oriel.test', role: 'member' })).status, 409);
    assert.equal((await admin.post(`/workspaces/${wid}/invites/email`, { email: 'pas-un-email', role: 'member' })).status, 400);
  });

  test('test e-mail is admin-only', async () => {
    assert.equal((await member.post('/admin/mail/test')).status, 403);
    const start = mailOutbox.length;
    const res = expectOk(await admin.post('/admin/mail/test'));
    assert.equal(res.to, 'admin@oriel.test');
    assert.ok(mailOutbox.slice(start).some((m) => m.subject === 'E-mail de test Oriel'));
  });
});
