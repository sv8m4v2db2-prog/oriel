// QA (injection / SSRF): link preview fetcher and HTML parser, FTS5 search, page content API,
// templates. Every test reproduces a suspected flaw against in-process servers bound to 127.0.0.1
// (mocked DNS, local fixture sites): nothing leaves the machine.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import * as Y from 'yjs';
import { PreviewError, editorTestHooks, extractMetadata, fetchHtml, isBlockedAddress, type FetchOptions } from '../src/routes/editor.js';
import { Client, addMember, createPage, expectOk, setupAdmin, startTestServer, type TestServer } from './helpers.js';

// ---------------------------------------------------------------------------
// Link preview: fetcher robustness against hostile sites
// ---------------------------------------------------------------------------

describe('QA injection: link preview fetcher', () => {
  let site: http.Server;
  let port = 0;

  before(async () => {
    site = http.createServer((req, res) => {
      const url = req.url ?? '/';
      if (url === '/gzip-abort' || url === '/plain-abort' || url === '/deflate-abort' || url === '/br-abort') {
        // Starts a (compressed) HTML answer, then drops the connection mid-body.
        const html = Buffer.from(`<html><head><title>Coupé</title></head><body>${'x'.repeat(200_000)}</body></html>`);
        const enc = url.slice(1, url.indexOf('-'));
        const body =
          enc === 'gzip' ? zlib.gzipSync(html) : enc === 'deflate' ? zlib.deflateSync(html) : enc === 'br' ? zlib.brotliCompressSync(html) : html;
        res.writeHead(200, { 'Content-Type': 'text/html', ...(enc === 'plain' ? {} : { 'Content-Encoding': enc }), 'Content-Length': String(body.length) });
        res.write(body.subarray(0, Math.floor(body.length / 2)), () => setTimeout(() => res.socket?.destroy(), 20));
      } else if (url === '/slowloris') {
        // Valid headers, then one byte every 100 ms, forever.
        res.writeHead(200, { 'Content-Type': 'text/html' });
        const timer = setInterval(() => res.write(' '), 100);
        res.on('close', () => clearInterval(timer));
      } else if (url === '/bomb') {
        // ~20 MB of whitespace compressed to a few KB.
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
        res.end(zlib.gzipSync(Buffer.concat([Buffer.from('<title>Bombe</title>'), Buffer.alloc(20 * 1024 * 1024, 0x20)])));
      } else if (url.startsWith('/redirect/')) {
        res.writeHead(302, { Location: decodeURIComponent(url.slice('/redirect/'.length)) });
        res.end();
      } else if (url === '/ok') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<title>OK</title>');
      } else {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<title>404</title>');
      }
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
    port = (site.address() as AddressInfo).port;
  });
  after(async () => {
    site.closeAllConnections();
    await new Promise<void>((r) => site.close(() => r()));
  });

  // "site.test" is the local fixture (treated as public for the test), everything else uses the real policy.
  const resolveCalls: string[] = [];
  const opts = (extra: Partial<FetchOptions> = {}): FetchOptions => ({
    resolve: async (host) => {
      resolveCalls.push(host);
      if (host === 'site.test') return [{ address: '127.0.0.1', family: 4 }];
      throw new Error('ENOTFOUND');
    },
    isBlocked: (ip) => ip !== '127.0.0.1' && isBlockedAddress(ip),
    ...extra,
  });
  const base = () => `http://site.test:${port}`;

  /** Settles within `ms` or reports a hang (the original promise is left behind). */
  const settle = <T>(p: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false; error: unknown } | 'hang'> =>
    Promise.race([
      p.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      new Promise<'hang'>((r) => setTimeout(() => r('hang'), ms).unref()),
    ]);

  test('QA-INJ-04: the default policy only contacts web ports (no scan of a public host, e.g. the server’s own public IP)', async () => {
    // timeoutMs: 0 → a vetted request gives up before connecting: nothing leaves the machine. "timeout" means the
    // endpoint passed the policy (the server would have connected to 93.184.216.34:6379), "blocked" that it did not.
    const code = async (url: string, extra: FetchOptions = {}) =>
      fetchHtml(url, { timeoutMs: 0, ...extra }).then(
        () => 'fetched',
        (e: unknown) => (e instanceof PreviewError ? e.code : String(e)),
      );
    for (const port of [22, 25, 2375, 3000, 5432, 6379, 8000, 9200, 11211]) {
      assert.equal(await code(`http://93.184.216.34:${port}/`), 'blocked', `port ${port}`);
      assert.equal(await code(`https://93.184.216.34:${port}/`), 'blocked', `port ${port} (https)`);
    }
    const publicDns: FetchOptions = { resolve: async () => [{ address: '93.184.216.34', family: 4 }] };
    assert.equal(await code('http://public.test:6379/', publicDns), 'blocked');
    // Redirect hops go through the same check (see fetchHtml), standard ports stay allowed.
    for (const url of ['http://93.184.216.34/', 'https://93.184.216.34/', 'http://93.184.216.34:443/', 'https://public.test:443/']) {
      assert.equal(await code(url, publicDns), 'timeout', url);
    }
  });

  test('QA-INJ-05: the answer does not tell whether a host name resolves to an internal address (internal DNS enumeration)', async () => {
    // Mocked resolver standing for the server's own (docker / corporate) DNS: no lookup leaves the machine.
    const lookups: string[] = [];
    const internalDns: FetchOptions = {
      resolve: async (host) => {
        lookups.push(host);
        if (host === 'redis' || host === 'intranet.corp.test') return [{ address: '172.18.0.4', family: 4 }];
        throw new Error('ENOTFOUND');
      },
      timeoutMs: 0,
    };
    const code = (url: string) =>
      fetchHtml(url, internalDns).then(
        () => 'fetched',
        (e: unknown) => (e instanceof PreviewError ? `${e.code}: ${e.message}` : String(e)),
      );
    assert.equal(await code('http://redis/'), await code('http://nothing-here/'));
    assert.equal(await code('http://intranet.corp.test/'), await code('http://nothing.corp.test/'));
    assert.equal(await code('http://redis/'), 'unreachable: Site introuvable.');
    // What the URL itself says is still refused as such: literal addresses, and ports (before any lookup).
    assert.match(await code('http://172.18.0.4/'), /^blocked:/);
    lookups.length = 0;
    assert.equal(await code('http://redis:6379/'), await code('http://nothing-here:6379/'));
    assert.match(await code('http://redis:6379/'), /^blocked:/);
    assert.deepEqual(lookups, [], 'no DNS lookup for a refused port');
  });

  test('QA-INJ-02: a compressed answer cut mid-body fails fast instead of hanging forever', async () => {
    for (const path of ['/plain-abort', '/gzip-abort', '/deflate-abort', '/br-abort']) {
      const started = Date.now();
      const out = await settle(fetchHtml(`${base()}${path}`, opts({ timeoutMs: 1000 })), 3000);
      assert.notEqual(out, 'hang', `${path}: the fetch never settles (not even after its own 1 s deadline)`);
      assert.ok(out !== 'hang' && !out.ok && out.error instanceof PreviewError, `${path}: rejected with a PreviewError`);
      assert.ok(Date.now() - started < 2500, path);
    }
  });

  test('close-delimited bodies (no Content-Length, no chunking) are still read to the end', async () => {
    const raw = net.createServer((socket) => {
      socket.once('data', (d) => {
        const gzip = d.toString('latin1').includes('/gz ');
        const body = gzip ? zlib.gzipSync('<title>Fin de flux</title>') : Buffer.from('<title>Fin de flux</title>');
        socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n${gzip ? 'Content-Encoding: gzip\r\n' : ''}Connection: close\r\n\r\n`);
        socket.end(body);
      });
    });
    await new Promise<void>((r) => raw.listen(0, '127.0.0.1', () => r()));
    try {
      const rawPort = (raw.address() as AddressInfo).port;
      for (const path of ['/gz', '/plain']) {
        const out = await fetchHtml(`http://site.test:${rawPort}${path}`, opts());
        assert.equal(extractMetadata(out.html, out.url).title, 'Fin de flux', path);
      }
    } finally {
      await new Promise<void>((r) => raw.close(() => r()));
    }
  });

  test('slowloris body is cut by the overall deadline', async () => {
    const started = Date.now();
    const out = await settle(fetchHtml(`${base()}/slowloris`, opts({ timeoutMs: 500 })), 3000);
    assert.ok(out !== 'hang' && !out.ok && out.error instanceof PreviewError);
    assert.ok(Date.now() - started < 2000);
  });

  test('decompression bomb: output is capped at maxBytes', async () => {
    const started = Date.now();
    const out = await fetchHtml(`${base()}/bomb`, opts({ maxBytes: 64 * 1024 }));
    assert.ok(out.html.length <= 64 * 1024 + 16 * 1024, String(out.html.length));
    assert.match(out.html, /Bombe/);
    assert.ok(Date.now() - started < 2000);
  });

  test('redirects to non-http schemes or internal hosts (all notations) are refused', async () => {
    const to = (target: string) => `${base()}/redirect/${encodeURIComponent(target)}`;
    const cases: Array<[string, PreviewError['code']]> = [
      ['file:///etc/passwd', 'invalid_url'],
      ['data:text/html,<title>x</title>', 'invalid_url'],
      ['gopher://127.0.0.1:6379/_INFO', 'invalid_url'],
      ['javascript:alert(1)', 'invalid_url'],
      [`//127.0.0.2:${port}/ok`, 'blocked'], // protocol-relative
      // (127.0.0.1 itself is the fixture here, so the numeric forms target 127.0.0.2 / 10.0.0.1)
      [`http://0177.0.0.2:${port}/ok`, 'blocked'],
      [`http://127.2:${port}/ok`, 'blocked'],
      [`http://0x7f000002:${port}/ok`, 'blocked'],
      [`http://2130706434:${port}/ok`, 'blocked'],
      [`http://012.0.0.1:${port}/ok`, 'blocked'],
      [`http://0xa.1:${port}/ok`, 'blocked'],
      [`http://[::ffff:127.0.0.1]:${port}/ok`, 'blocked'],
      [`http://[::ffff:7f00:1]:${port}/ok`, 'blocked'],
      [`http://[::127.0.0.1]:${port}/ok`, 'blocked'],
      [`http://[64:ff9b::7f00:1]:${port}/ok`, 'blocked'],
      [`http://[2002:7f00:1::1]:${port}/ok`, 'blocked'],
      [`http://[::]:${port}/ok`, 'blocked'],
      [`http://0.0.0.0:${port}/ok`, 'blocked'],
      [`http://[fe80::1]:${port}/ok`, 'blocked'],
      [`http://[fd00::1]:${port}/ok`, 'blocked'],
      ['http://169.254.169.254/latest/meta-data/', 'blocked'],
      ['http://[::ffff:a9fe:a9fe]/latest/meta-data/', 'blocked'],
      ['http://100.100.100.200/latest/meta-data/', 'blocked'], // Alibaba metadata (CGNAT range)
      ['http://metadata.google.internal/', 'blocked'],
      [`http://user:pw@site.test:${port}/ok`, 'invalid_url'],
    ];
    for (const [target, code] of cases) {
      await assert.rejects(fetchHtml(to(target), opts()), (e: unknown) => e instanceof PreviewError && e.code === code, target);
    }
  });

  test('DNS is resolved once per hop and the connection uses the vetted address (no rebinding window)', async () => {
    resolveCalls.length = 0;
    let calls = 0;
    // First answer public (the fixture), any later answer internal: a rebinding resolver.
    const rebinding: FetchOptions = {
      resolve: async (host) => {
        calls++;
        resolveCalls.push(host);
        return calls === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.0.0.1', family: 4 }];
      },
      isBlocked: (ip) => ip !== '127.0.0.1' && isBlockedAddress(ip),
    };
    const out = await fetchHtml(`http://rebind.test:${port}/ok`, rebinding);
    assert.match(out.html, /OK/);
    assert.equal(calls, 1, 'a single resolution, reused for the connection');
  });

  test('https connections are pinned to the vetted address too (SNI keeps the name)', async () => {
    // A raw TCP listener: records the TLS ClientHello, then hangs up (no certificate needed).
    const hellos: Buffer[] = [];
    const tcp = net.createServer((socket) => {
      socket.once('data', (d) => {
        hellos.push(d);
        socket.destroy();
      });
    });
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', () => r()));
    try {
      const tlsPort = (tcp.address() as AddressInfo).port;
      await assert.rejects(
        fetchHtml(`https://pinned.test:${tlsPort}/`, opts({ resolve: async () => [{ address: '127.0.0.1', family: 4 }] })),
        (e: unknown) => e instanceof PreviewError && e.code === 'unreachable',
      );
      assert.equal(hellos.length, 1, 'the TLS handshake reached the pinned 127.0.0.1');
      assert.ok(hellos[0]!.includes(Buffer.from('pinned.test')), 'SNI carries the original host name');
    } finally {
      await new Promise<void>((r) => tcp.close(() => r()));
    }
  });
});

// ---------------------------------------------------------------------------
// Link preview: HTML metadata parser (ReDoS)
// ---------------------------------------------------------------------------

describe('QA injection: link preview HTML parser', () => {
  test('QA-INJ-01: crafted HTML without closing ">" is parsed in linear time (no ReDoS)', () => {
    const url = new URL('https://x.test/');
    // ~160 KB each; quadratic scanning takes seconds here and minutes on the 1 MB a site may send.
    const n = 160 * 1024;
    const inputs: Array<[string, string]> = [
      ...['<meta', '<link', '<title>', '<meta a="', '<title></title', '<META', '<link rel=icon href='].map(
        (unit) => [unit, unit.repeat(Math.floor(n / unit.length))] as [string, string],
      ),
      // One huge tag: the attribute parser must stay linear too.
      ...['a="b" ', "a='", 'a=', '= ', ' ', '&amp', '&#x41;'].map((unit) => [`<meta ${unit}…>`, `<meta ${unit.repeat(Math.floor(n / unit.length))}>`] as [string, string]),
      ['<meta content="&…', `<meta property="og:title" content="${'&a'.repeat(n / 2)}">`],
    ];
    for (const [label, html] of inputs) {
      const started = performance.now();
      extractMetadata(html, url);
      const ms = performance.now() - started;
      assert.ok(ms < 500, `${label}: ${Math.round(ms)} ms`);
    }
  });

  test('extraction semantics are kept (first tag wins, attributes, entities, title fallback)', () => {
    const url = new URL('https://x.test/a/');
    const m = extractMetadata(
      `<html><head><TITLE lang=fr>Mon &amp; titre</TITLE><title>Second</title>
       <META property="og:description" content='Desc &eacute;'><meta property="og:description" content="Autre">
       <meta name=og:site_name content=Site>
       <link rel="apple-touch-icon" href="/t.png"><LINK REL="icon" href="i.png"></head></html>`,
      url,
    );
    assert.equal(m.title, 'Mon & titre');
    assert.equal(m.description, 'Desc é');
    assert.equal(m.siteName, 'Site');
    assert.equal(m.favicon, 'https://x.test/a/i.png');
    // Unclosed <title>: no title from it, host fallback.
    assert.equal(extractMetadata('<title>sans fin', url).title, 'x.test');
    // A <meta without ">" ends the scan but earlier tags are kept.
    assert.equal(extractMetadata('<meta property="og:title" content="Avant"><meta property="x"', url).title, 'Avant');
    // "<metadata>" is not a <meta> tag.
    assert.equal(extractMetadata('<metadata property="og:title" content="Non">', url).title, 'x.test');
  });
});


// ---------------------------------------------------------------------------
// Page content API: malformed Yjs payloads
// ---------------------------------------------------------------------------

/** BlockNote-shaped document: blockGroup > blockContainer > paragraph per line. */
function blocksDoc(lines: string[], extraInline: (paragraph: Y.XmlElement) => void = () => {}): Y.Doc {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('blocknote');
  doc.transact(() => {
    const group = new Y.XmlElement('blockGroup');
    fragment.insert(0, [group]);
    for (const line of lines) {
      const container = new Y.XmlElement('blockContainer');
      container.setAttribute('id', crypto.randomUUID());
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, line);
      paragraph.insert(0, [text]);
      container.insert(0, [paragraph]);
      group.insert(group.length, [container]);
      extraInline(paragraph);
    }
  });
  return doc;
}
const encodeDoc = (doc: Y.Doc) => Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
function decodeDoc(update: string): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(update, 'base64'));
  return doc;
}

describe('QA injection: page content API', () => {
  let srv: TestServer;
  let admin: Client;
  let wid: string;

  before(async () => {
    srv = await startTestServer();
    ({ admin, wid } = await setupAdmin(srv.base));
  });
  after(async () => {
    await srv.stop();
  });

  const malformed = (): Array<[string, Y.Doc]> => {
    const asArray = new Y.Doc();
    asArray.getArray('blocknote').insert(0, ['texte brut', 42, { a: 1 }]);
    const withMap = blocksDoc(['a']);
    (withMap.getXmlFragment('blocknote').get(0) as Y.XmlElement).insert(1, [new Y.Map() as unknown as Y.XmlElement]);
    const rootMap = new Y.Doc();
    rootMap.getXmlFragment('blocknote').insert(0, [new Y.Map() as unknown as Y.XmlElement]);
    const withText = blocksDoc(['b'], (p) => p.insert(1, [new Y.Text('pas du XmlText') as unknown as Y.XmlText]));
    const withHook = new Y.Doc();
    withHook.getXmlFragment('blocknote').insert(0, [new Y.XmlHook('crochet') as unknown as Y.XmlElement]);
    const deep = new Y.Doc();
    deep.transact(() => {
      let parent: Y.XmlFragment | Y.XmlElement = deep.getXmlFragment('blocknote');
      for (let i = 0; i < 20_000; i++) {
        const el = new Y.XmlElement(i % 2 ? 'blockContainer' : 'blockGroup');
        parent.insert(0, [el]);
        parent = el;
      }
    });
    const wide = new Y.Doc();
    wide.transact(() => {
      const group = new Y.XmlElement('blockGroup');
      wide.getXmlFragment('blocknote').insert(0, [group]);
      group.insert(0, Array.from({ length: 200_000 }, () => new Y.XmlElement('blockContainer')));
    });
    return [
      ['fragment written as a Y.Array of raw values', asArray],
      ['200 000 siblings', wide],
      ['Y.Map inside a block group', withMap],
      ['Y.Map at the fragment root', rootMap],
      ['Y.Text inside a paragraph', withText],
      ['Y.XmlHook at the fragment root', withHook],
      ['20 000 nested elements', deep],
    ];
  };

  test('QA-INJ-03: non-XML shared types and absurd nesting are refused with 400 (no 500, nothing written)', async () => {
    const page = await createPage(admin, wid, { title: 'Malformé' });
    expectOk(await admin.put(`/pages/${page.id}/content`, { update: encodeDoc(blocksDoc(['Intact'])), mode: 'replace' }));
    const wrong: string[] = [];
    for (const mode of ['replace', 'append'] as const) {
      for (const [label, doc] of malformed()) {
        const res = await admin.put(`/pages/${page.id}/content`, { update: encodeDoc(doc), mode });
        if (res.status !== 400) wrong.push(`${mode} / ${label}: ${res.status}`);
      }
    }
    assert.deepEqual(wrong, []);
    const read = expectOk(await admin.get<{ update: string }>(`/pages/${page.id}/content`));
    const blocknote = decodeDoc(read.update).getXmlFragment('blocknote');
    assert.equal(blocknote.toString().includes('Intact'), true);
    const stack: unknown[] = blocknote.toArray();
    while (stack.length) {
      const n = stack.pop();
      assert.ok(n instanceof Y.XmlElement || n instanceof Y.XmlText, 'only XML nodes in the stored fragment');
      if (n instanceof Y.XmlElement) stack.push(...n.toArray());
    }
    expectOk(await admin.get('/auth/me'));
  });

  test('legitimately nested content (200 levels) is still accepted', async () => {
    const page = await createPage(admin, wid, { title: 'Imbriqué' });
    const doc = new Y.Doc();
    doc.transact(() => {
      let parent: Y.XmlFragment | Y.XmlElement = doc.getXmlFragment('blocknote');
      for (let i = 0; i < 200; i++) {
        const el = new Y.XmlElement(i % 2 ? 'blockContainer' : 'blockGroup');
        parent.insert(0, [el]);
        parent = el;
      }
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'tout au fond');
      p.insert(0, [t]);
      parent.insert(0, [p]);
    });
    expectOk(await admin.put(`/pages/${page.id}/content`, { update: encodeDoc(doc), mode: 'replace' }));
    const read = expectOk(await admin.get<{ update: string }>(`/pages/${page.id}/content`));
    assert.match(decodeDoc(read.update).getXmlFragment('blocknote').toString(), /tout au fond/);
  });
});

// ---------------------------------------------------------------------------
// Link preview route: hanging fetches, cache, errors
// ---------------------------------------------------------------------------

describe('QA injection: link preview route', () => {
  let srv: TestServer;
  let site: http.Server;
  let sitePort = 0;
  let admin: Client;
  let wid: string;
  let member: Client;

  before(async () => {
    site = http.createServer((req, res) => {
      if (req.url === '/gzip-abort') {
        const body = zlib.gzipSync(`<title>Coupé</title>${'x'.repeat(100_000)}`);
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip', 'Content-Length': String(body.length) });
        res.write(body.subarray(0, body.length >> 1), () => setTimeout(() => res.socket?.destroy(), 20));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<title>Page ${req.url}</title><meta property="og:image" content="javascript:alert(1)"><link rel=icon href="data:image/png;base64,AA">`);
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
    sitePort = (site.address() as AddressInfo).port;
    srv = await startTestServer();
    ({ admin, wid } = await setupAdmin(srv.base));
    ({ client: member } = await addMember(admin, wid, 'membre@oriel.test', 'Marc Membre', 'member'));
    // "*.test" names are the local fixture, treated as public; every other address keeps the real policy.
    editorTestHooks.fetchOptions = {
      resolve: async (host) => {
        if (host.endsWith('.test')) return [{ address: '127.0.0.1', family: 4 }];
        throw new Error('ENOTFOUND');
      },
      isBlocked: (ip) => ip !== '127.0.0.1' && isBlockedAddress(ip),
      timeoutMs: 1000,
    };
  });
  after(async () => {
    delete editorTestHooks.fetchOptions;
    await srv.stop();
    site.closeAllConnections();
    await new Promise<void>((r) => site.close(() => r()));
  });

  const preview = (c: Client, url: string) =>
    Promise.race([
      c.get(`/link-preview?url=${encodeURIComponent(url)}`),
      new Promise<'hang'>((r) => setTimeout(() => r('hang'), 4000).unref()),
    ]);

  test('QA-INJ-02 (route): a site cutting a compressed answer does not hang the request nor every later request of that URL', async () => {
    const url = `http://coupe.test:${sitePort}/gzip-abort`;
    const first = await preview(member, url);
    assert.notEqual(first, 'hang', 'first request hangs');
    assert.equal(first !== 'hang' && first.status, 422);
    // Another user, same URL: served from the (failure) cache, not stuck on a never-settling shared fetch.
    const second = await preview(admin, url);
    assert.notEqual(second, 'hang', 'second request hangs');
    assert.equal(second !== 'hang' && second.status, 422);
  });

  test('returned image / favicon URLs never carry javascript: or data: schemes', async () => {
    const res = await preview(member, `http://schemes.test:${sitePort}/x`);
    assert.ok(res !== 'hang');
    const body = expectOk(res);
    assert.equal(body.image, '');
    assert.equal(body.favicon, '');
    assert.equal(body.title, 'Page /x');
  });

  test('errors do not leak internal details; blocked targets are refused before any connection', async () => {
    for (const target of [
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:7f00:2]/',
      'http://0177.0.0.2/',
      'http://127.2/',
      'http://[::]/',
      'http://0.0.0.0/',
      'http://[fd00::1]/',
      'http://[64:ff9b::a9fe:a9fe]/',
      'http://100.100.100.200/',
      'http://intranet.local/',
      'http://metadata.google.internal/',
    ]) {
      const res = await preview(member, target);
      assert.ok(res !== 'hang', target);
      assert.equal(res.status, 400, target);
      assert.equal(res.body.error.code, 'blocked_url', target);
      assert.doesNotMatch(JSON.stringify(res.body), /ECONN|ENOTFOUND|stack|at\s/, target);
    }
  });

  test('QA-INJ-05 (route): a name resolving to an internal address answers exactly like an unknown name, cache included', async () => {
    const saved = editorTestHooks.fetchOptions;
    const lookups: string[] = [];
    // Mocked internal DNS (real address policy): "redis.corp" is an internal host, other names do not exist.
    editorTestHooks.fetchOptions = {
      resolve: async (host) => {
        lookups.push(host);
        if (host === 'redis.corp') return [{ address: '172.18.0.4', family: 4 }];
        throw new Error('ENOTFOUND');
      },
      timeoutMs: 1000,
    };
    try {
      const answer = async (url: string) => {
        const res = await preview(admin, url);
        assert.ok(res !== 'hang', url);
        return { status: res.status, body: res.body };
      };
      const internal = await answer('http://redis.corp/');
      const unknown = await answer('http://nothing.corp/');
      assert.equal(internal.status, 422);
      assert.deepEqual(internal, unknown);
      // A literal address is still refused as such.
      const literal = await answer('http://172.18.0.4/');
      assert.equal(literal.status, 400);
      assert.equal(literal.body.error.code, 'blocked_url');
      // Both are cached as failures: a fresh lookup for one and a cache hit for the other would tell them apart.
      lookups.length = 0;
      assert.deepEqual(await answer('http://redis.corp/'), internal);
      assert.deepEqual(await answer('http://nothing.corp/'), unknown);
      assert.deepEqual(lookups, []);
    } finally {
      editorTestHooks.fetchOptions = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// Search (FTS5), templates, cross-workspace references
// ---------------------------------------------------------------------------

describe('QA injection: search, templates and references across workspaces', () => {
  let srv: TestServer;
  let admin: Client;
  let wid: string;
  let member: Client;
  let viewer: Client;
  let outsider: Client;
  let otherWid: string;

  before(async () => {
    srv = await startTestServer();
    ({ admin, wid } = await setupAdmin(srv.base));
    ({ client: member } = await addMember(admin, wid, 'membre@oriel.test', 'Marc Membre', 'member'));
    ({ client: viewer } = await addMember(admin, wid, 'lecteur@oriel.test', 'Léa Lectrice', 'viewer'));
    expectOk(await admin.patch('/admin/settings', { signupMode: 'open' }));
    outsider = new Client(srv.base);
    const session = expectOk(
      await outsider.post<{ workspaces: Array<{ id: string }> }>('/auth/signup', { email: 'dehors@oriel.test', name: 'Oscar', password: 'motdepasse-solide' }),
    );
    otherWid = session.workspaces[0]!.id;
  });
  after(async () => {
    await srv.stop();
  });

  const putText = async (c: Client, pageId: string, lines: string[]) =>
    expectOk(await c.put(`/pages/${pageId}/content`, { update: encodeDoc(blocksDoc(lines)), mode: 'replace' }));
  const search = async (c: Client, w: string, q: string) => {
    const res = await c.get<{ results: Array<{ page: { id: string; title: string }; snippet: string }> }>(
      `/workspaces/${w}/search?q=${encodeURIComponent(q)}`,
    );
    return res;
  };
  const ids = async (c: Client, w: string, q: string) => expectOk(await search(c, w, q)).results.map((r) => r.page.id);

  test('FTS5 operators, column filters and quoting never error, widen the filter or match other pages', async () => {
    const shared = await createPage(admin, wid, { title: 'Partagée' });
    await putText(admin, shared.id, ['morse oriel publique']);
    const secret = await createPage(admin, wid, { title: 'Secrète', visibility: 'private' });
    await putText(admin, secret.id, ['phoque confidentiel zzsecret']);
    const foreign = await createPage(outsider, otherWid, { title: 'Ailleurs' });
    await putText(outsider, foreign.id, ['zzailleurs inaccessible']);

    const payloads = [
      'zzsecret',
      'title:zzsecret',
      '{body}: zzsecret',
      'body:zzsecret',
      'workspace_id:*',
      'page_id:*',
      'zzsecret OR morse',
      'morse OR zzsecret',
      'NOT morse',
      'morse NOT oriel',
      '- morse',
      '"zzsecret" OR "morse"',
      'NEAR(zzsecret morse, 10)',
      '^zzsecret',
      'zz*',
      '*',
      'z*',
      '"',
      '""',
      "'",
      '(',
      ')',
      'morse)',
      'morse AND',
      'AND',
      '+morse',
      'col:',
      ':',
      'zzailleurs',
      'zz\u0000secret',
      '\ufffdmorse',
      'a'.repeat(500),
      'x '.repeat(250),
      '"morse" "oriel" "publique" "a" "b" "c" "d" "e" "f" "g" "h" "i" "j" "k"',
    ];
    for (const q of payloads) {
      const res = await search(member, wid, q);
      assert.equal(res.status, 200, q);
      for (const r of res.body.results) {
        assert.ok(r.page.id !== secret.id && r.page.id !== foreign.id, `${q} → leaked ${r.page.title}`);
      }
    }
    // Invalid UTF-8 / lone surrogates in the raw query string.
    for (const raw of ['%ED%A0%80morse', '%FF%FE', '%C0%80zzsecret']) {
      const res = await member.get<{ results: Array<{ page: { id: string } }> }>(`/workspaces/${wid}/search?q=${raw}`);
      assert.ok(res.status === 200 || res.status === 400, `${raw}: ${res.status}`);
      for (const r of res.status === 200 ? res.body.results : []) assert.ok(r.page.id !== secret.id && r.page.id !== foreign.id, raw);
    }
    // Sanity: the owner finds the private page, the outsider finds only theirs.
    assert.deepEqual(await ids(admin, wid, 'zzsecret'), [secret.id]);
    assert.deepEqual(await ids(outsider, otherWid, 'zzsecret'), []);
    assert.deepEqual(await ids(outsider, otherWid, 'zzailleurs'), [foreign.id]);
    assert.deepEqual(await ids(member, wid, 'zzailleurs'), []);
  });

  test('search follows visibility changes, trash and deletion (no stale index leak)', async () => {
    const root = await createPage(member, wid, { title: 'Racine mouvante' });
    const child = expectOk(await member.post<{ id: string }>(`/workspaces/${wid}/pages`, { parentType: 'page', parentId: root.id, title: 'Enfant' }));
    await putText(member, child.id, ['zzmouvant contenu']);
    assert.deepEqual(await ids(viewer, wid, 'zzmouvant'), [child.id]);
    // Moved into the member's private section: the whole subtree disappears for the others.
    expectOk(await member.post(`/pages/${root.id}/move`, { parentType: 'workspace', parentId: wid, visibility: 'private' }));
    assert.deepEqual(await ids(viewer, wid, 'zzmouvant'), []);
    assert.deepEqual(await ids(admin, wid, 'zzmouvant'), []);
    assert.deepEqual(await ids(member, wid, 'zzmouvant'), [child.id]);
    // Trashed, then deleted for good.
    expectOk(await member.post(`/pages/${root.id}/trash`));
    assert.deepEqual(await ids(member, wid, 'zzmouvant'), []);
    expectOk(await member.del(`/pages/${root.id}`));
    assert.deepEqual(await ids(member, wid, 'zzmouvant'), []);
  });

  test('snippets are plain text: markup in page content is returned verbatim, highlight markers only around matches', async () => {
    const page = await createPage(admin, wid, { title: 'Balises' });
    await putText(admin, page.id, ['<img src=x onerror=alert(1)> zzbalise ]] [[ fin']);
    const res = expectOk(await search(member, wid, 'zzbalise'));
    const snippet = res.results.find((r) => r.page.id === page.id)!.snippet;
    assert.match(snippet, /\[\[zzbalise\]\]/);
    // Nothing is HTML-decoded or turned into markup server-side (the client renders it as text).
    assert.match(snippet, /<img src=x onerror=alert\(1\)>/);
  });

  test('templates: no instantiation across workspaces, of private templates, into foreign or read-only places', async () => {
    const tpl = await createPage(admin, wid, { title: 'Modèle partagé' });
    await putText(admin, tpl.id, ['contenu du modèle']);
    expectOk(await admin.put(`/pages/${tpl.id}/template`, { isTemplate: true }));
    const privateTpl = await createPage(admin, wid, { title: 'Modèle privé', visibility: 'private' });
    expectOk(await admin.put(`/pages/${privateTpl.id}/template`, { isTemplate: true }));
    const mine = await createPage(outsider, otherWid, { title: 'Chez moi' });

    // Outsider: cannot see, list or copy templates of a workspace they are not in.
    assert.equal((await outsider.get(`/workspaces/${wid}/templates`)).status, 404);
    for (const target of [
      { parentType: 'workspace', parentId: otherWid },
      { parentType: 'page', parentId: mine.id },
      { parentType: 'workspace', parentId: wid },
    ]) {
      assert.equal((await outsider.post(`/pages/${tpl.id}/instantiate`, target)).status, 404, JSON.stringify(target));
    }
    assert.equal((await outsider.put(`/pages/${tpl.id}/template`, { isTemplate: false })).status, 404);
    // Member: someone else's private template is invisible (list + instantiate + flag).
    const listed = expectOk(await member.get<{ templates: Array<{ id: string }> }>(`/workspaces/${wid}/templates`)).templates.map((t) => t.id);
    assert.ok(listed.includes(tpl.id));
    assert.ok(!listed.includes(privateTpl.id));
    assert.equal((await member.post(`/pages/${privateTpl.id}/instantiate`, { parentType: 'workspace', parentId: wid })).status, 404);
    assert.equal((await member.put(`/pages/${privateTpl.id}/template`, { isTemplate: false })).status, 404);
    // Member: a template of this workspace cannot be copied into another workspace / a foreign page.
    assert.equal((await member.post(`/pages/${tpl.id}/instantiate`, { parentType: 'workspace', parentId: otherWid })).status, 400);
    assert.equal((await member.post(`/pages/${tpl.id}/instantiate`, { parentType: 'page', parentId: mine.id })).status, 404);
    // ...nor under someone else's private page.
    const adminPrivate = await createPage(admin, wid, { title: 'Privé admin', visibility: 'private' });
    assert.equal((await member.post(`/pages/${tpl.id}/instantiate`, { parentType: 'page', parentId: adminPrivate.id })).status, 404);
    // Viewer: read-only.
    assert.equal((await viewer.post(`/pages/${tpl.id}/instantiate`, { parentType: 'workspace', parentId: wid })).status, 403);
    // A trashed template is neither listed nor instantiable.
    expectOk(await admin.post(`/pages/${tpl.id}/trash`));
    const after = expectOk(await member.get<{ templates: Array<{ id: string }> }>(`/workspaces/${wid}/templates`)).templates.map((t) => t.id);
    assert.ok(!after.includes(tpl.id));
    assert.equal((await member.post(`/pages/${tpl.id}/instantiate`, { parentType: 'workspace', parentId: wid })).status, 400);
    // The outsider's workspace was not touched.
    const tree = expectOk(await outsider.get<{ nodes: Array<{ title: string }> }>(`/workspaces/${otherWid}/tree`)).nodes.map((n) => n.title);
    assert.ok(!tree.includes('Modèle partagé'));
  });

  test('page references written through the content API do not reach pages of another workspace', async () => {
    const victim = await createPage(admin, wid, { title: 'Cible protégée' });
    const attacker = await createPage(outsider, otherWid, { title: 'Page piège' });
    const doc = blocksDoc(['Voir '], (p) => {
      for (const name of ['pageMention', 'pageLink', 'subpage']) {
        const el = new Y.XmlElement(name);
        el.setAttribute('pageId', victim.id);
        p.insert(p.length, [el]);
      }
    });
    expectOk(await outsider.put(`/pages/${attacker.id}/content`, { update: encodeDoc(doc), mode: 'replace' }));
    const backlinks = expectOk(await admin.get<{ pages: Array<{ id: string }> }>(`/pages/${victim.id}/backlinks`)).pages;
    assert.deepEqual(backlinks, []);
    // The attacker learns nothing about the target through its own page either.
    assert.equal((await outsider.get(`/pages/${victim.id}`)).status, 404);
    assert.equal((await outsider.get(`/pages/${victim.id}/content`)).status, 404);
    // Duplicating the attacker page keeps the dangling reference as is (no resolution of foreign ids).
    const dup = expectOk(await outsider.post<{ id: string }>(`/pages/${attacker.id}/duplicate`));
    const content = expectOk(await outsider.get<{ update: string }>(`/pages/${dup.id}/content`));
    assert.match(decodeDoc(content.update).getXmlFragment('blocknote').toString(), new RegExp(victim.id));
    assert.doesNotMatch(decodeDoc(content.update).getXmlFragment('blocknote').toString(), /Cible protégée/);
  });
});
