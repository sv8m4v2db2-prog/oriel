/// <reference types="node" />
// Run: node --test --import tsx web/src/editor/embeds.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EMBED_FRAME_ORIGINS } from '@oriel/shared';
import { asLoneUrl, detectProvider, embedSource, isKnownEmbeddable } from './embeds';

const src = (url: string) => embedSource(url, detectProvider(url)!.provider);

describe('embed providers', () => {
  test('YouTube (watch, short link, shorts, start time, playlist)', () => {
    assert.equal(src('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s'), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90');
    assert.equal(src('https://youtu.be/dQw4w9WgXcQ?t=42'), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42');
    assert.equal(src('https://youtube.com/shorts/abcdefghijk'), 'https://www.youtube-nocookie.com/embed/abcdefghijk');
    assert.equal(src('https://www.youtube.com/playlist?list=PL123abc'), 'https://www.youtube-nocookie.com/embed/videoseries?list=PL123abc');
  });

  test('Vimeo (public and unlisted)', () => {
    assert.equal(src('https://vimeo.com/76979871'), 'https://player.vimeo.com/video/76979871');
    assert.equal(src('https://vimeo.com/76979871/af1234cd56'), 'https://player.vimeo.com/video/76979871?h=af1234cd56');
  });

  test('Loom, Figma, Spotify', () => {
    assert.equal(src('https://www.loom.com/share/0123456789abcdef0123456789abcdef'), 'https://www.loom.com/embed/0123456789abcdef0123456789abcdef');
    assert.match(src('https://www.figma.com/design/AbC123/Maquette?node-id=1-2')!, /^https:\/\/www\.figma\.com\/embed\?embed_host=oriel&url=https%3A%2F%2Fwww\.figma\.com%2Fdesign%2FAbC123/);
    assert.equal(src('https://open.spotify.com/intl-fr/track/4uLU6hMCjMI75M1A2tKUQC?si=x'), 'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC');
    assert.equal(detectProvider('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')!.defaultHeight, 352);
  });

  test('Google Docs / Sheets / Slides / Drive / Maps', () => {
    assert.equal(src('https://docs.google.com/document/d/1AbC_dEf/edit'), 'https://docs.google.com/document/d/1AbC_dEf/preview');
    assert.equal(detectProvider('https://docs.google.com/spreadsheets/d/1AbC/edit#gid=0')!.provider, 'google-sheets');
    assert.equal(src('https://docs.google.com/presentation/d/1AbC/edit'), 'https://docs.google.com/presentation/d/1AbC/preview');
    assert.equal(src('https://drive.google.com/file/d/1XyZ/view?usp=sharing'), 'https://drive.google.com/file/d/1XyZ/preview');
    assert.equal(
      src('https://www.google.com/maps/place/Tour+Eiffel/@48.8583701,2.2944813,17z/data=x'),
      'https://maps.google.com/maps?q=Tour%20Eiffel&z=17&output=embed',
    );
    assert.equal(src('https://www.google.com/maps/embed?pb=!1m18!1m12'), 'https://www.google.com/maps/embed?pb=!1m18!1m12');
  });

  test('Frame.io is not embeddable; generic https pages are', () => {
    assert.equal(detectProvider('https://app.frame.io/reviews/abc')!.provider, 'frameio');
    assert.equal(embedSource('https://f.io/abc', 'frameio'), null);
    assert.equal(isKnownEmbeddable('https://f.io/abc'), false);
    assert.equal(detectProvider('https://exemple.fr/page')!.provider, 'generic');
    assert.equal(detectProvider('http://exemple.fr/page'), null);
    assert.equal(embedSource('http://exemple.fr/page', 'generic'), null);
  });

  test('the iframe source never leaves the provider origins (CSP frame-src)', () => {
    const urls = [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://vimeo.com/76979871',
      'https://www.loom.com/share/0123456789abcdef0123456789abcdef',
      'https://www.figma.com/file/AbC/x',
      'https://www.google.com/maps/@48.85,2.29,12z',
      'https://docs.google.com/document/d/1AbC/edit',
      'https://drive.google.com/file/d/1XyZ/view',
      'https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3',
    ];
    for (const url of urls) {
      const s = src(url)!;
      assert.ok(EMBED_FRAME_ORIGINS.includes(new URL(s).origin), `${url} → ${s}`);
    }
    // A provider name cannot be used to frame another site.
    assert.equal(embedSource('https://evil.example/watch?v=dQw4w9WgXcQ', 'youtube'), null);
    assert.equal(embedSource('javascript:alert(1)', 'generic'), null);
  });

  test('lone URL detection for paste', () => {
    assert.equal(asLoneUrl('  https://exemple.fr/a?b=1  '), 'https://exemple.fr/a?b=1');
    assert.equal(asLoneUrl('voir https://exemple.fr'), null);
    assert.equal(asLoneUrl('https://localhost'), null);
    assert.equal(asLoneUrl('ftp://exemple.fr'), null);
  });
});
