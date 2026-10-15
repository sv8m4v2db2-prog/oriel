// QA (security review): the MCP package (mcp/src) — API paths built from model-provided ids, size of tool
// results, URL allow-list of written content (Markdown and JSON blocks), color / equation placeholders,
// prop types of JSON blocks, Streamable HTTP transport. Each QA-MCP-xx test first reproduced the flaw on
// the code under review; the others document hypotheses checked and ruled out.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { Page, View } from '@oriel/shared';
import { OrielApiError, OrielClient } from '../src/client.js';
import { isSafeLinkHref, isSafeMediaUrl } from '../src/content/links.js';
import { blocksToMarkdown, markdownToBlocks, sanitizeBlocks, type ImportContext } from '../src/content/markdown.js';
import { blocksToUpdate, updateToBlocks, type Blk } from '../src/content/editor.js';
import { startHttpServer } from '../src/http.js';
import { connectMcp, createPage, createToken, expectOk, setupAdmin, startTestServer, type HttpClient, type Mcp, type TestServer } from './helpers.js';

const ictx: ImportContext = {
  pageId: 'P',
  currentUserId: 'u1',
  serverOrigin: 'https://notes.example.fr',
  resolvePage: async () => null,
  isMember: async (id) => id === 'u1',
  resolveSynced: async () => false,
};
const ectx = { title: () => undefined, userName: () => undefined };
const MARKER_RE = /[-]/;
const text = (t: string, styles: Record<string, unknown> = {}) => ({ type: 'text', text: t, styles });

/** Every string reachable from `v` (links, props, nested blocks). */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
}

/** URL-bearing values (link targets, media / embed / bookmark URLs, button actions) that are not safe. */
function dangerous(blocks: unknown): string[] {
  const out: string[] = [];
  const norm = (v: string) => v.toLowerCase().replace(/[\s\u0000-\u001f]/g, '');
  const check = (v: unknown) => {
    if (typeof v !== 'string' || !v) return;
    const n = norm(v);
    if (/(javascript|vbscript|data):|&#106;|^\/\//.test(n) || n.includes('"url":"//')) out.push(v);
  };
  const walk = (x: unknown) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== 'object') return;
    const o = x as Record<string, unknown>;
    check(o.href);
    const props = o.props as Record<string, unknown> | undefined;
    if (props) for (const k of ['url', 'image', 'favicon', 'actions']) check(props[k]);
    Object.values(o).forEach(walk);
  };
  walk(blocks);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Offline checks
// ---------------------------------------------------------------------------------------------

describe('qa-mcp: written content (offline)', () => {
  test('QA-MCP-01: the API client refuses paths that leave the intended route (dot segments, backslashes, fragments)', async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const client = new OrielClient('https://notes.example.fr', 'or_x', { fetch: fake });
    for (const path of [
      '/pages/../me/tokens',
      '/pages/./x',
      '/pages/%2e%2e/workspaces/w/ai/briefs',
      '/pages/.%2E/x',
      '/pages/x/..',
      '/pages/a\\..\\b',
      '/pages/x#/trash',
      '/pages/a\nb',
    ]) {
      await assert.rejects(client.post(path), (err: unknown) => err instanceof OrielApiError && err.status === 400, path);
    }
    assert.deepEqual(calls, [], 'nothing was sent');
    await client.get('/pages/abc-123?visit=0');
    await client.get(`/pages/${encodeURIComponent('x/../y')}/content`);
    assert.equal(calls.length, 2);
  });

  test('QA-MCP-03: same-origin paths that browsers read as another host, and file paths that leave /api/files/, are refused', async () => {
    for (const href of ['/\\evil.example', '/\\/evil.example', '/\t/evil.example', '/\n/evil.example', '\\\\evil.example', '/ /evil.example']) {
      assert.equal(isSafeLinkHref(href), false, JSON.stringify(href));
    }
    for (const href of ['/w/abc/p/def', '/share/abc', '#titre', 'https://exemple.fr', 'mailto:a@b.fr', 'tel:+33100000000']) {
      assert.equal(isSafeLinkHref(href), true, href);
    }
    for (const url of ['/api/files/../me/tokens', '/api/files/x/../../me/tokens', '/api/files/%2e%2e/me', '/api/files/x\\..\\..\\me', '/api/files/']) {
      assert.equal(isSafeMediaUrl(url), false, url);
    }
    assert.equal(isSafeMediaUrl('/api/files/0f8fad5b-d9cb-469f-a165-70867728950e/plan%20de%20projet.png'), true);
    // Through the JSON write path.
    const { blocks } = await sanitizeBlocks(
      [
        { type: 'paragraph', content: [{ type: 'link', href: '/\\evil.example/login', content: [text('connexion')] }] },
        { type: 'image', props: { url: '/api/files/../me/tokens', name: 'x' } },
        { type: 'pdf', props: { url: '/api/files/../../api/me/tokens', name: 'x' } },
      ],
      ictx,
    );
    assert.ok(!strings(blocks).some((s) => s.includes('evil.example') || s.includes('..')), JSON.stringify(blocks));
  });

  test('hypothesis ruled out: dangerous URL schemes are refused everywhere (Markdown and JSON, case, controls, entities, spaces)', async () => {
    const bad = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\nscript:alert(1)', 'java\tscript:alert(1)', '&#106;avascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', '//evil.example/x'];
    for (const href of bad) {
      const { blocks } = await sanitizeBlocks(
        [
          { type: 'paragraph', content: [{ type: 'link', href, content: [text('lien')] }] },
          { type: 'image', props: { url: href } },
          { type: 'video', props: { url: href } },
          { type: 'audio', props: { url: href } },
          { type: 'file', props: { url: href } },
          { type: 'embed', props: { url: href, provider: 'generic', height: 400 } },
          { type: 'bookmark', props: { url: href, title: 't', image: href, favicon: href } },
          { type: 'pdf', props: { url: href } },
          { type: 'button', props: { label: 'b', actions: JSON.stringify([{ type: 'open', url: href }]) } },
        ],
        ictx,
      );
      assert.deepEqual(dangerous(blocks), [], `${href}: ${JSON.stringify(blocks)}`);
    }
    const md = bad
      .filter((h) => !/\s/.test(h))
      .map((h) => `[lien](${h}) ![image](${h}) [x](oriel://embed?url=${encodeURIComponent(h)}) [y](oriel://bookmark?url=${encodeURIComponent(h)})`)
      .join('\n\n');
    const { blocks } = await markdownToBlocks(md, ictx);
    assert.deepEqual(dangerous(blocks), [], JSON.stringify(blocks));
  });

  test('QA-MCP-04: private-use placeholder characters in user text cannot forge colors or equations', async () => {
    // Import: a Markdown text carrying the placeholders of the color / equation conversions.
    const md = 'Texte 0 et ' + '0vert et I0\n\nRouge <span data-text-color="red">r</span> $x^2$ <!-- oriel:color background=yellow -->';
    const { blocks } = await markdownToBlocks(md, ictx);
    const first = blocks[0]!;
    assert.equal(first.props?.backgroundColor ?? 'default', 'default', 'block color forged');
    const items = first.content as Array<{ type: string; styles?: Record<string, unknown> }>;
    assert.ok(!items.some((i) => i.type === 'inlineEquation'), 'equation forged');
    assert.ok(!items.some((i) => i.styles?.textColor), 'text color forged');
    // Export: page text containing the placeholders never turns into tags or equations.
    const page: Blk[] = [
      { type: 'paragraph', content: [text('a 0b c I0 d ')] },
      { type: 'paragraph', content: [text('rouge', { textColor: 'red' }), { type: 'inlineEquation', props: { tex: 'y' } }] },
    ];
    const { markdown } = await blocksToMarkdown(updateToBlocks(blocksToUpdate(page)).blocks, ectx);
    assert.equal(markdown.split('<span').length - 1, 1, markdown);
    assert.equal(markdown.split('</span>').length - 1, 1, markdown);
    assert.equal(markdown.split('$y$').length - 1, 1, markdown);
    assert.doesNotMatch(markdown, MARKER_RE);
  });

  test('QA-MCP-05: JSON blocks keep only known color names and the prop types of the schema', async () => {
    const { blocks } = await sanitizeBlocks(
      [
        {
          type: 'paragraph',
          props: { textColor: 'red" onmouseover="alert(1)', backgroundColor: { evil: true } },
          content: [text('x', { textColor: 'url(javascript:alert(1))', backgroundColor: 'yellow', bold: true })],
        },
        { type: 'callout', props: { emoji: { toString: 1 }, backgroundColor: 'blue' }, content: [text('c')] },
        { type: 'heading', props: { level: 9, isToggleable: 'oui' }, content: [text('h')] },
      ],
      ictx,
    );
    const update = blocksToUpdate(blocks);
    const back = updateToBlocks(update).blocks;
    const [p, callout, heading] = back;
    assert.equal(p!.props!.textColor, 'default');
    assert.equal(p!.props!.backgroundColor, 'default');
    const styles = (p!.content as Array<{ styles: Record<string, unknown> }>)[0]!.styles;
    assert.equal(styles.textColor, undefined);
    assert.equal(styles.backgroundColor, 'yellow');
    assert.equal(styles.bold, true);
    assert.equal(typeof callout!.props!.emoji, 'string');
    assert.equal(callout!.props!.backgroundColor, 'blue');
    assert.ok(Number(heading!.props!.level) >= 1 && Number(heading!.props!.level) <= 4);
    assert.equal(typeof heading!.props!.isToggleable, 'boolean');
  });
});

// ---------------------------------------------------------------------------------------------
// End to end (real server, in-memory MCP client)
// ---------------------------------------------------------------------------------------------

describe('qa-mcp: tools against a real server', () => {
  let srv: TestServer;
  let admin: HttpClient;
  let wid: string;
  let mcp: Mcp;
  let readOnly: Mcp;

  before(async () => {
    srv = await startTestServer();
    ({ admin, wid } = await setupAdmin(srv.base));
    mcp = await connectMcp(srv.base, (await createToken(admin, { name: 'écriture', scope: 'write' })).token);
    readOnly = await connectMcp(srv.base, (await createToken(admin, { name: 'lecture', scope: 'read' })).token);
  });
  after(async () => {
    await mcp?.close();
    await readOnly?.close();
    await srv?.stop();
  });

  test('QA-MCP-01: a page id cannot steer a tool to another route (restore → trash, duplicate → view, move)', async () => {
    const victim = await createPage(admin, wid, { title: 'Ne pas jeter' });
    const res = await mcp.call('oriel_restore_page', { pageId: `../pages/${victim.id}/trash?x=` }, { allowError: true });
    assert.equal(res.isError, true, res.texts.join('\n'));
    assert.equal(expectOk(await admin.get<{ page: Page }>(`/pages/${victim.id}`)).page.trashedAt, null, 'the restore tool trashed a page');

    const dbPage = await createPage(admin, wid, { kind: 'database', title: 'Base' });
    const views = expectOk(await admin.get<{ views: View[] }>(`/databases/${dbPage.id}`)).views;
    const dup = await mcp.call('oriel_duplicate_page', { pageId: `../views/${views[0]!.id}` }, { allowError: true });
    assert.equal(dup.isError, true, dup.texts.join('\n'));
    assert.equal(expectOk(await admin.get<{ views: View[] }>(`/databases/${dbPage.id}`)).views.length, views.length);

    const moved = await mcp.call('oriel_move_page', { pageId: `%2e%2e/pages/${victim.id}/trash?`, parent: { type: 'workspace' } }, { allowError: true });
    assert.equal(moved.isError, true);
    assert.equal(expectOk(await admin.get<{ page: Page }>(`/pages/${victim.id}`)).page.trashedAt, null);
  });

  test('QA-MCP-02: tool results are bounded (a huge page cannot flood the conversation)', async () => {
    const line = `${'Lorem ipsum dolor sit amet, '.repeat(160)}fin.`;
    const md = Array.from({ length: 70 }, (_, i) => `${i} ${line}`).join('\n\n');
    assert.ok(md.length > 300_000);
    const page = await mcp.json('oriel_create_page', { parent: { type: 'workspace' }, title: 'Très longue', markdown: md });
    for (const format of ['markdown', 'blocks']) {
      const read = await readOnly.call('oriel_read_page', { pageId: page.id, format });
      const total = read.texts.reduce((n, t) => n + t.length, 0);
      assert.ok(total <= 210_000, `${format}: ${total} characters`);
      assert.match(read.texts.join('\n'), /tronqué/);
      assert.match(read.texts.join('\n'), /replace/, 'the note warns against rewriting the page from a truncated read');
    }
    // Small results are untouched.
    const small = await readOnly.call('oriel_whoami');
    assert.doesNotMatch(small.texts.join(''), /tronqué/);
  });

  test('hypothesis ruled out: a read-only token mutates nothing, whatever the tool', async () => {
    const page = await createPage(admin, wid, { title: 'Intacte' });
    const before = expectOk(await admin.get<{ page: Page }>(`/pages/${page.id}`)).page;
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['oriel_create_page', { parent: { type: 'workspace' }, title: 'x' }],
      ['oriel_update_page', { pageId: page.id, title: 'modifié' }],
      ['oriel_write_page_content', { pageId: page.id, markdown: 'x', mode: 'replace' }],
      ['oriel_move_page', { pageId: page.id, parent: { type: 'workspace' }, after: null }],
      ['oriel_trash_page', { pageId: page.id }],
      ['oriel_duplicate_page', { pageId: page.id }],
      ['oriel_add_comment', { pageId: page.id, text: 'x' }],
      ['oriel_create_database', { parent: { type: 'workspace' }, title: 'x' }],
    ];
    for (const [name, args] of attempts) {
      const res = await readOnly.call(name, args, { allowError: true });
      assert.equal(res.isError, true, `${name} succeeded with a read-only token`);
    }
    const after = expectOk(await admin.get<{ page: Page }>(`/pages/${page.id}`)).page;
    assert.equal(after.version, before.version);
    assert.equal(after.trashedAt, null);
  });

  test('hypothesis ruled out: add/update_view never publish a form', async () => {
    const created = await mcp.json('oriel_create_database', { parent: { type: 'workspace' }, title: 'Inscriptions' });
    const res = await mcp.call(
      'oriel_update_database_schema',
      { databaseId: created.id, operations: [{ action: 'add_view', name: 'Form', type: 'form', form: { title: 'Inscription', isPublic: true } }] },
      { allowError: true },
    );
    const views = expectOk(await admin.get<{ views: View[] }>(`/databases/${created.id}`)).views;
    assert.ok(!views.some((v) => v.config.form?.isPublic), `${res.texts.join('\n')}`);
  });
});

// ---------------------------------------------------------------------------------------------
// Streamable HTTP transport
// ---------------------------------------------------------------------------------------------

function rawPost(port: number, headers: Record<string, string>, body: string): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, method: 'POST', path: '/mcp', headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('qa-mcp: Streamable HTTP transport', () => {
  let srv: TestServer;
  let admin: HttpClient;
  let token: string;

  before(async () => {
    srv = await startTestServer();
    ({ admin } = await setupAdmin(srv.base));
    token = (await createToken(admin, { name: 'http', scope: 'read' })).token;
  });
  after(async () => {
    await srv?.stop();
  });

  const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
  const accept = 'application/json, text/event-stream';

  test('QA-MCP-06: DNS rebinding — a loopback server refuses browser requests of another origin', async () => {
    const http = await startHttpServer({ url: srv.base, token, workspace: null, host: '127.0.0.1', port: 0 });
    try {
      const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept };
      const rebound = await rawPost(http.port, { ...auth, host: `evil.example:${http.port}`, origin: `http://evil.example:${http.port}` }, init);
      assert.equal(rebound.status, 403, `rebound page → ${rebound.status}`);
      const foreignOrigin = await rawPost(http.port, { ...auth, origin: 'https://evil.example' }, init);
      assert.equal(foreignOrigin.status, 403, `Origin evil.example → ${foreignOrigin.status}`);
      assert.equal((await rawPost(http.port, { ...auth, origin: 'null' }, init)).status, 403);
      // MCP clients (no Origin), directly or through a reverse proxy that keeps its public Host.
      const proxied = await rawPost(http.port, { ...auth, host: 'mcp.mondomaine.fr' }, init);
      assert.equal(proxied.status, 200, proxied.body);
      const local = await rawPost(http.port, { ...auth, origin: `http://localhost:${http.port}` }, init);
      assert.equal(local.status, 200, local.body);
      const ok = await rawPost(http.port, auth, init);
      assert.equal(ok.status, 200, ok.body);
      // Never any CORS header, never the token in a response.
      assert.equal(ok.headers['access-control-allow-origin'], undefined);
      assert.ok(!ok.body.includes(token));
    } finally {
      await http.close();
    }
  });

  test('hypothesis ruled out: no token, a wrong token or an oversized body never opens a session', async () => {
    const http = await startHttpServer({ url: srv.base, token, workspace: null, host: '127.0.0.1', port: 0 });
    try {
      const base = { 'content-type': 'application/json', accept };
      assert.equal((await rawPost(http.port, base, init)).status, 401);
      assert.equal((await rawPost(http.port, { ...base, authorization: `Bearer or_${'z'.repeat(43)}` }, init)).status, 401);
      assert.equal((await rawPost(http.port, { ...base, authorization: 'Basic YTpi' }, init)).status, 401);
      // 413, or the connection is cut while the client is still sending: either way no session.
      const big = await rawPost(http.port, { ...base, authorization: `Bearer ${token}` }, `{"x":"${'a'.repeat(4 * 1024 * 1024 + 10)}"}`).catch(() => ({ status: 0, body: '' }));
      assert.ok(big.status === 413 || big.status === 0, String(big.status));
      const err = await rawPost(http.port, { ...base, authorization: `Bearer ${token}` }, '{');
      assert.ok(!err.body.includes(token));
    } finally {
      await http.close();
    }
  });
});
