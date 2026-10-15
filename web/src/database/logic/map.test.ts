import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCoordinates, typedPlaceChoices } from './map';

const nbsp = (s: string) => s.replace(/\s/g, ' ');

describe('places typed by hand', () => {
  test('minus sign written as U+2212', () => {
    assert.deepEqual(parseCoordinates('47,2184 ; −1,5536'), { lat: 47.2184, lng: -1.5536 });
  });

  test('empty text: nothing offered', () => {
    assert.deepEqual(typedPlaceChoices('   ', { address: 'Lyon', lat: 45.76, lng: 4.83 }), []);
  });

  test('free address: no position, trimmed and capped', () => {
    const [c] = typedPlaceChoices('  12 rue de la Paix, Nantes ', null);
    assert.deepEqual(c!.value, { address: '12 rue de la Paix, Nantes' });
    assert.equal(c!.located, false);
    assert.equal(typedPlaceChoices('x'.repeat(600), null)[0]!.value.address.length, 500);
  });

  test('unchanged address keeps its coordinates; changed address loses them', () => {
    const current = { address: 'Quai Saint-Antoine, Lyon', lat: 45.7629, lng: 4.8301 };
    const keep = typedPlaceChoices('Quai Saint-Antoine, Lyon', current);
    assert.equal(keep.length, 1);
    assert.equal(keep[0]!.value, current);
    assert.equal(keep[0]!.located, true);
    assert.match(keep[0]!.label, /^Garder/);
    assert.deepEqual(typedPlaceChoices('Quai Saint-Antoine, Lyon 2e', current)[0]!.value, { address: 'Quai Saint-Antoine, Lyon 2e' });
    // Same text without coordinates: still an address without position.
    assert.equal(typedPlaceChoices('Bretagne', { address: 'Bretagne' })[0]!.located, false);
  });

  test('coordinates locate the current address, or stand alone', () => {
    const current = { address: 'Quelque part en Bretagne' };
    const [withAddress, alone] = typedPlaceChoices('48,1173 ; -1,6778', current);
    assert.deepEqual(withAddress!.value, { address: 'Quelque part en Bretagne', lat: 48.1173, lng: -1.6778 });
    assert.match(withAddress!.label, /Quelque part en Bretagne/);
    assert.equal(nbsp(alone!.value.address), '48,1173 ; -1,6778');
    assert.equal(alone!.value.lat, 48.1173);
    assert.ok(alone!.located);
    // No address, or an address that is itself coordinates: a single choice.
    assert.equal(typedPlaceChoices('48.1173, -1.6778', null).length, 1);
    assert.equal(typedPlaceChoices('48.1173, -1.6778', { address: '47,2 ; -1,5', lat: 47.2, lng: -1.5 }).length, 1);
  });
});
