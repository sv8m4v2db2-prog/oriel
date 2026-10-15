// Editor module: link previews (SSRF guards, parsing, cache, rate limit), page templates, welcome seed.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import type { LinkPreview, Page, PageDetailResponse, RecentResponse, TreeResponse } from '@oriel/shared';
import {
  PreviewError,
  editorTestHooks,
  extractMetadata,
  fetchHtml,
  isBlockedAddress,
  parseIpv6,
  type FetchOptions,
} from '../src/routes/editor.js';
import { Client, addMember, createPage, expectOk, setupAdmin, signup, startTestServer, type TestServer } from './helpers.js';

// ---------------------------------------------------------------------------
// Address policy
// ---------------------------------------------------------------------------

describe('link preview: address policy', () => {
  test('blocks private, loopback, link-local, multicast and reserved IPv4', () => {
    for (const ip of [
      '0.0.0.0',
      '10.1.2.3',
      '100.64.0.1',
      '127.0.0.1',
      '127.255.255.254',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.0.0.8',
      '192.0.2.1',
      '192.168.1.1',
      '198.18.0.1',
      '224.0.0.1',
      '239.255.255.250',
      '240.0.0.1',
      '255.255.255.255',
    ]) {
      assert.equal(isBlockedAddress(ip), true, ip);
    }
  });

  test('allows public IPv4', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.128.0.1']) {
      assert.equal(isBlockedAddress(ip), false, ip);
    }
  });

  test('blocks special IPv6 ranges, including embedded IPv4 forms', () => {
    for (const ip of [
      '::',
      '::1',
      '[::1]',
      'fe80::1',
      'fe80::1%lo0',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      'fec0::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:10.0.0.1',
      '::127.0.0.1',
      '64:ff9b::a9fe:a9fe', // NAT64 → 169.254.169.254
      '2002:7f00:1::', // 6to4 → 127.0.0.1
      '2001:db8::1',
      '2001::1', // Teredo
      '100::1',
      'not-an-ip',
    ]) {
      assert.equal(isBlockedAddress(ip), true, ip);
    }
  });

  test('allows global unicast IPv6', () => {
    for (const ip of ['2606:4700:4700::1111', '2a00:1450:4007:80e::200e', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1']) {
      assert.equal(isBlockedAddress(ip), false, ip);
    }
  });

  test('parses IPv6 forms', () => {
    assert.deepEqual(parseIpv6('::1')?.slice(14), [0, 1]);
    assert.deepEqual(parseIpv6('::ffff:1.2.3.4')?.slice(10), [0xff, 0xff, 1, 2, 3, 4]);
    assert.equal(parseIpv6('1:2:3:4:5:6:7:8:9'), null);
    assert.equal(parseIpv6('127.0.0.1'), null);
  });
});

// ---------------------------------------------------------------------------
// Fetching with mocked DNS against local servers
// ---------------------------------------------------------------------------

describe('link preview: fetching', () => {
  let site: http.Server;
  let port = 0;
  const hits: string[] = [];

  before(async () => {
    site = http.createServer((req, res) => {
      hits.push(`${req.headers.host}${req.url}`);
      const url = req.url ?? '/';
      if (url === '/page') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head>
          <title>Titre &amp; balise</title>
          <meta property="og:title" content="Titre Open Graph &eacute;t&eacute;">
          <meta name="description" content="Une description">
          <meta property="og:image" content="https://cdn.example.org/cover.jpg">
          <meta property="og:site_name" content="Exemple">
          <link rel="icon" href="/favicon.png">
        </head><body>…</body></html>`);
      } else if (url === '/gzip') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
        res.end(zlib.gzipSync('<html><head><title>Compressé</title></head></html>'));
      } else if (url === '/latin1') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=iso-8859-1' });
        res.end(Buffer.from('<title>Caf\xe9</title>', 'latin1'));
      } else if (url.startsWith('/redirect/')) {
        res.writeHead(302, { Location: decodeURIComponent(url.slice('/redirect/'.length)) });
        res.end();
      } else if (url.startsWith('/chain/')) {
        const n = Number(url.slice('/chain/'.length));
        res.writeHead(301, { Location: n > 0 ? `/chain/${n - 1}` : '/page' });
        res.end();
      } else if (url === '/json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      } else if (url === '/huge') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.write('<html><head><title>Énorme</title></head><body>');
        const chunk = 'x'.repeat(64 * 1024);
        let sent = 0;
        const pump = () => {
          while (sent < 50 * 1024 * 1024) {
            sent += chunk.length;
            if (!res.write(chunk)) return void res.once('drain', pump);
          }
          res.end();
        };
        res.on('close', () => (sent = Infinity));
        pump();
      } else if (url === '/slow') {
        // Never answers.
      } else {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<title>Introuvable</title>');
      }
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
    port = (site.address() as AddressInfo).port;
  });
  after(async () => {
    site.closeAllConnections();
    await new Promise<void>((r) => site.close(() => r()));
  });

  // Mocked DNS: "site.test" is our local server (treated as public for the test), "evil.test" an internal host.
  const opts = (extra: Partial<FetchOptions> = {}): FetchOptions => ({
    resolve: async (host) => {
      if (host === 'site.test') return [{ address: '127.0.0.1', family: 4 }];
      if (host === 'evil.test') return [{ address: '10.0.0.5', family: 4 }];
      if (host === 'mixed.test') return [{ address: '127.0.0.1', family: 4 }, { address: '192.168.0.10', family: 4 }];
      if (host === 'v6.test') return [{ address: '::1', family: 6 }];
      throw new Error('ENOTFOUND');
    },
    isBlocked: (ip) => ip !== '127.0.0.1' && isBlockedAddress(ip),
    ...extra,
  });
  const base = () => `http://site.test:${port}`;

  const rejects = async (p: Promise<unknown>, code: PreviewError['code']) => {
    await assert.rejects(p, (e: unknown) => e instanceof PreviewError && e.code === code);
  };
  /** Exactly the error of an unknown name (see 'unknown hosts are unreachable'), cacheability included. */
  const refusedName = async (p: Promise<unknown>) => {
    await assert.rejects(p, (e: unknown) => e instanceof PreviewError && e.code === 'unreachable' && e.message === 'Site introuvable.' && e.cacheable);
  };

  test('parses Open Graph metadata through the pinned address', async () => {
    const { url, html } = await fetchHtml(`${base()}/page`, opts());
    assert.equal(url.hostname, 'site.test');
    const meta = extractMetadata(html, url);
    assert.equal(meta.title, 'Titre Open Graph été');
    assert.equal(meta.description, 'Une description');
    assert.equal(meta.image, 'https://cdn.example.org/cover.jpg');
    assert.equal(meta.siteName, 'Exemple');
    // Favicon resolved against an http page → not https → dropped.
    assert.equal(meta.favicon, '');
    assert.ok(hits.includes(`site.test:${port}/page`), 'Host header keeps the original name');
  });

  test('decompresses and decodes charsets', async () => {
    const gz = await fetchHtml(`${base()}/gzip`, opts());
    assert.match(gz.html, /Compressé/);
    const latin = await fetchHtml(`${base()}/latin1`, opts());
    assert.match(latin.html, /Café/);
  });

  test('refuses non-http schemes, credentials and internal hosts', async () => {
    await rejects(fetchHtml('ftp://site.test/', opts()), 'invalid_url');
    await rejects(fetchHtml('file:///etc/passwd', opts()), 'invalid_url');
    await rejects(fetchHtml(`http://user:pw@site.test:${port}/page`, opts()), 'invalid_url');
    // Names resolving to an internal address (even among public ones) are refused as if they did not
    // exist, not as "blocked": a distinct answer would let members enumerate internal DNS names (QA-INJ-05).
    await refusedName(fetchHtml(`http://evil.test:${port}/page`, opts()));
    await refusedName(fetchHtml(`http://mixed.test:${port}/page`, opts()));
    await refusedName(fetchHtml(`http://v6.test:${port}/page`, opts()));
    // What the URL itself says (internal names, literal addresses) stays "blocked".
    await rejects(fetchHtml(`http://localhost:${port}/page`, opts()), 'blocked');
    await rejects(fetchHtml(`http://127.0.0.2:${port}/page`, opts()), 'blocked');
    await rejects(fetchHtml(`http://[::1]:${port}/page`, opts()), 'blocked');
    await rejects(fetchHtml('http://169.254.169.254/latest/meta-data/', opts()), 'blocked');
    // Numeric host forms are normalised by the URL parser before the check.
    await rejects(fetchHtml(`http://2130706434:${port}/`, opts()), 'blocked');
  });

  test('re-checks every redirect hop', async () => {
    const to = (target: string) => `${base()}/redirect/${encodeURIComponent(target)}`;
    await refusedName(fetchHtml(to(`http://evil.test:${port}/page`), opts()));
    await rejects(fetchHtml(to(`http://127.0.0.2:${port}/page`), opts()), 'blocked');
    await rejects(fetchHtml(to('http://169.254.169.254/'), opts()), 'blocked');
    await rejects(fetchHtml(to('gopher://site.test/'), opts()), 'invalid_url');
    const ok = await fetchHtml(to(`${base()}/page`), opts());
    assert.equal(ok.url.pathname, '/page');
  });

  test('follows at most 3 redirects', async () => {
    const ok = await fetchHtml(`${base()}/chain/2`, opts()); // 3 redirects
    assert.equal(ok.url.pathname, '/page');
    await rejects(fetchHtml(`${base()}/chain/3`, opts()), 'too_many_redirects'); // 4 redirects
  });

  test('accepts HTML only, enforces the size cap and the timeout', async () => {
    await rejects(fetchHtml(`${base()}/json`, opts()), 'not_html');
    await rejects(fetchHtml(`${base()}/missing`, opts()), 'http_status');
    const big = await fetchHtml(`${base()}/huge`, opts({ maxBytes: 256 * 1024 }));
    assert.ok(big.html.length <= 256 * 1024 + 16);
    assert.match(big.html, /Énorme/);
    const started = Date.now();
    await rejects(fetchHtml(`${base()}/slow`, opts({ timeoutMs: 300 })), 'timeout');
    assert.ok(Date.now() - started < 3000);
  });

  test('unknown hosts are unreachable', async () => {
    await assert.rejects(
      fetchHtml('http://nowhere.test/', opts()),
      (e: unknown) => e instanceof PreviewError && e.code === 'unreachable' && e.message === 'Site introuvable.' && e.cacheable,
    );
  });
});

describe('link preview: metadata extraction', () => {
  test('falls back to <title>, twitter tags and the host', () => {
    const url = new URL('https://www.exemple.fr/article');
    const m = extractMetadata(
      `<head><title> Article  du jour </title><meta name="twitter:description" content='Résumé'>
       <meta name="twitter:image" content="/img/a.png"><link rel="shortcut icon" href="https://cdn.exemple.fr/i.ico"></head>`,
      url,
    );
    assert.equal(m.title, 'Article du jour');
    assert.equal(m.description, 'Résumé');
    assert.equal(m.image, 'https://www.exemple.fr/img/a.png');
    assert.equal(m.favicon, 'https://cdn.exemple.fr/i.ico');
    assert.equal(m.siteName, 'exemple.fr');
    const bare = extractMetadata('<p>rien</p>', url);
    assert.equal(bare.title, 'www.exemple.fr');
    assert.equal(bare.favicon, 'https://www.exemple.fr/favicon.ico');
    assert.equal(bare.image, '');
  });

  test('drops non-https and javascript image URLs', () => {
    const m = extractMetadata(
      '<meta property="og:image" content="javascript:alert(1)"><link rel="icon" href="http://x.fr/f.ico">',
      new URL('https://x.fr/'),
    );
    assert.equal(m.image, '');
    assert.equal(m.favicon, 'https://x.fr/favicon.ico');
  });
});

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

describe('editor routes', () => {
  let srv: TestServer;
  let site: http.Server;
  let sitePort = 0;
  let siteHits = 0;
  let admin: Client;
  let wid: string;
  let member: Client;
  let viewer: Client;

  before(async () => {
    site = http.createServer((_req, res) => {
      siteHits++;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<title>Site public</title><meta property="og:description" content="Bonjour">');
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
    sitePort = (site.address() as AddressInfo).port;
    srv = await startTestServer();
    ({ admin, wid } = await setupAdmin(srv.base));
    ({ client: member } = await addMember(admin, wid, 'membre@oriel.test', 'Marc Membre', 'member'));
    ({ client: viewer } = await addMember(admin, wid, 'lecteur@oriel.test', 'Léa Lectrice', 'viewer'));
  });
  after(async () => {
    delete editorTestHooks.fetchOptions;
    await srv.stop();
    site.closeAllConnections();
    await new Promise<void>((r) => site.close(() => r()));
  });

  test('link preview requires a session and refuses internal addresses (real DNS policy)', async () => {
    const anon = new Client(srv.base);
    assert.equal((await anon.get(`/link-preview?url=${encodeURIComponent('https://example.org')}`)).status, 401);
    for (const target of [
      `http://127.0.0.1:${srv.server.port}/api/health`,
      `http://localhost:${srv.server.port}/`,
      'http://[::1]/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/',
      'http://0x7f.1/',
    ]) {
      const res = await member.get(`/link-preview?url=${encodeURIComponent(target)}`);
      assert.equal(res.status, 400, target);
      assert.equal(res.body.error.code, 'blocked_url', target);
    }
    const bad = await member.get(`/link-preview?url=${encodeURIComponent('javascript:alert(1)')}`);
    assert.equal(bad.status, 400);
  });

  test('link preview: fetch, cache and per-user rate limit (mocked DNS)', async () => {
    editorTestHooks.fetchOptions = {
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
      isBlocked: (ip) => ip !== '127.0.0.1',
    };
    const url = `http://public.test:${sitePort}/a`;
    const first = expectOk(await member.get<LinkPreview>(`/link-preview?url=${encodeURIComponent(url)}`));
    assert.equal(first.title, 'Site public');
    assert.equal(first.description, 'Bonjour');
    const before = siteHits;
    const again = expectOk(await viewer.get<LinkPreview>(`/link-preview?url=${encodeURIComponent(url)}`));
    assert.deepEqual(again, first);
    assert.equal(siteHits, before, 'served from cache');
    // 20 network fetches per minute per user.
    let limited = false;
    for (let i = 0; i < 25 && !limited; i++) {
      const res = await member.get(`/link-preview?url=${encodeURIComponent(`http://public.test:${sitePort}/n${i}`)}`);
      if (res.status === 429) limited = true;
      else expectOk(res);
    }
    assert.ok(limited, 'rate limited');
    // Another user is not affected.
    expectOk(await admin.get(`/link-preview?url=${encodeURIComponent(`http://public.test:${sitePort}/other`)}`));
    delete editorTestHooks.fetchOptions;
  });

  test('a user without workspace cannot use the preview service', async () => {
    // Signups are closed after the first account: create a member then remove them from the workspace.
    const { client, user } = await addMember(admin, wid, 'parti@oriel.test', 'Paul Parti', 'member');
    expectOk(await admin.del(`/workspaces/${wid}/members/${user.id}`));
    const res = await client.get(`/link-preview?url=${encodeURIComponent('https://example.org')}`);
    assert.equal(res.status, 403);
  });

  test('templates: mark, list, instantiate with sub-pages and inline databases, recent', async () => {
    const tpl = await createPage(admin, wid, { title: 'Modèle projet', icon: '🎬' });
    const sub = expectOk(await admin.post<Page>(`/workspaces/${wid}/pages`, { parentType: 'page', parentId: tpl.id, title: 'Rétro-planning' }));
    const db = expectOk(
      await admin.post<Page>(`/workspaces/${wid}/pages`, { parentType: 'page', parentId: tpl.id, kind: 'database', isInline: true, title: 'Tâches' }),
    );

    // Viewers cannot mark templates.
    assert.equal((await viewer.put(`/pages/${tpl.id}/template`, { isTemplate: true })).status, 403);
    // Only templates can be instantiated.
    assert.equal((await member.post(`/pages/${tpl.id}/instantiate`, { parentType: 'workspace', parentId: wid })).status, 400);

    expectOk(await member.put<Page>(`/pages/${tpl.id}/template`, { isTemplate: true }));
    const tree = expectOk(await member.get<TreeResponse>(`/workspaces/${wid}/tree`)).nodes;
    assert.equal(tree.find((n) => n.id === tpl.id)?.isTemplate, true);
    assert.equal(tree.find((n) => n.id === sub.id)?.isTemplate, undefined);
    const list = expectOk(await member.get<{ templates: Array<{ id: string }> }>(`/workspaces/${wid}/templates`));
    assert.deepEqual(
      list.templates.map((t) => t.id),
      [tpl.id],
    );

    // Templates are excluded from "recent".
    expectOk(await member.get<PageDetailResponse>(`/pages/${tpl.id}`));
    const recent = expectOk(await member.get<RecentResponse>(`/workspaces/${wid}/recent`));
    assert.ok(!recent.pages.some((p) => p.id === tpl.id));

    // Viewers cannot create pages from a template.
    assert.equal((await viewer.post(`/pages/${tpl.id}/instantiate`, { parentType: 'workspace', parentId: wid })).status, 403);

    // Instantiate into a page of the private section.
    const host = await createPage(member, wid, { title: 'Mes projets', visibility: 'private' });
    const copy = expectOk(await member.post<Page>(`/pages/${tpl.id}/instantiate`, { parentType: 'page', parentId: host.id }));
    assert.equal(copy.title, 'Modèle projet');
    assert.equal(copy.icon, '🎬');
    assert.equal(copy.parentId, host.id);
    assert.equal(copy.visibility, 'private');
    const tree2 = expectOk(await member.get<TreeResponse>(`/workspaces/${wid}/tree`)).nodes;
    const copyNode = tree2.find((n) => n.id === copy.id)!;
    assert.equal(copyNode.isTemplate, undefined, 'the copy is not a template');
    const children = tree2.filter((n) => n.parentId === copy.id);
    assert.deepEqual(children.map((c) => c.title).sort(), ['Rétro-planning', 'Tâches']);
    assert.ok(children.every((c) => c.visibility === 'private'));
    const dbCopy = children.find((c) => c.kind === 'database')!;
    assert.notEqual(dbCopy.id, db.id);
    const rows = expectOk(await member.get<{ rows: Page[] }>(`/databases/${dbCopy.id}/rows`));
    assert.equal(rows.rows.length, 3, 'database rows are copied');
    // Not visible to other members (private).
    assert.equal((await admin.get(`/pages/${copy.id}`)).status, 404);

    // Instantiate at the workspace root.
    const rootCopy = expectOk(await admin.post<Page>(`/pages/${tpl.id}/instantiate`, { parentType: 'workspace', parentId: wid, visibility: 'workspace' }));
    assert.equal(rootCopy.parentType, 'workspace');
    assert.equal(rootCopy.visibility, 'workspace');
    // Invalid destinations.
    assert.equal((await admin.post(`/pages/${tpl.id}/instantiate`, { parentType: 'page', parentId: host.id })).status, 404);
    assert.equal((await admin.post(`/pages/${tpl.id}/instantiate`, { parentType: 'workspace', parentId: 'autre' })).status, 400);

    // Unmark.
    expectOk(await member.put(`/pages/${tpl.id}/template`, { isTemplate: false }));
    const tree3 = expectOk(await member.get<TreeResponse>(`/workspaces/${wid}/tree`)).nodes;
    assert.equal(tree3.find((n) => n.id === tpl.id)?.isTemplate, undefined);
    // Database rows cannot be templates.
    const row = expectOk(await admin.post<Page>(`/databases/${db.id}/rows`, { title: 'Ligne' }));
    assert.equal((await admin.put(`/pages/${row.id}/template`, { isTemplate: true })).status, 400);
  });

  test('page options are accepted in format; the welcome page carries the seed flag', async () => {
    const page = await createPage(member, wid, { title: 'Options' });
    const updated = expectOk(await member.patch<Page>(`/pages/${page.id}`, { format: { font: 'serif', locked: true, smallText: true } }));
    assert.deepEqual(updated.format, { font: 'serif', locked: true, smallText: true });
    assert.equal((await member.patch(`/pages/${page.id}`, { format: { font: 'comic' } })).status, 400);
    const cleared = expectOk(await member.patch<Page>(`/pages/${page.id}`, { format: { locked: null, font: null } }));
    assert.deepEqual(cleared.format, { smallText: true });

    const fresh = await startTestServer();
    try {
      const { client, session } = await signup(fresh.base, 'nouveau@oriel.test', 'Nina Nouvelle');
      const w = session.workspaces[0]!.id;
      const nodes = expectOk(await client.get<TreeResponse>(`/workspaces/${w}/tree`)).nodes;
      const welcome = expectOk(await client.get<PageDetailResponse>(`/pages/${nodes[0]!.id}`)).page;
      assert.deepEqual(welcome.format, { seed: 'welcome' });
      const done = expectOk(await client.patch<Page>(`/pages/${welcome.id}`, { format: { seed: null } }));
      assert.deepEqual(done.format, {});
    } finally {
      await fresh.stop();
    }
  });

  test('GET /pages/:pid?visit=0 reads a page without recording a visit', async () => {
    const page = await createPage(admin, wid, { title: 'Lien seulement' });
    expectOk(await member.get<PageDetailResponse>(`/pages/${page.id}?visit=0`));
    let recent = expectOk(await member.get<RecentResponse>(`/workspaces/${wid}/recent`));
    assert.ok(!recent.pages.some((p) => p.id === page.id));
    expectOk(await member.get<PageDetailResponse>(`/pages/${page.id}`));
    recent = expectOk(await member.get<RecentResponse>(`/workspaces/${wid}/recent`));
    assert.ok(recent.pages.some((p) => p.id === page.id));
  });

  test('the SPA CSP restricts frames to the supported embed providers', async () => {
    const res = await fetch(`${srv.base}/w/x`);
    const csp = res.headers.get('content-security-policy') ?? '';
    const frame = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('frame-src'))!;
    assert.ok(frame.includes('https://www.youtube-nocookie.com'));
    assert.ok(frame.includes('https://player.vimeo.com'));
    assert.ok(!/\shttps:(\s|$)/.test(frame), 'no blanket https: source');
    assert.ok(!frame.includes('http://'));
  });
});
