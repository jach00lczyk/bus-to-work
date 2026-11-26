import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, distance, typicalAt } from '../lib/geo.js';
import { geo, pointAt } from './helpers.js';

test('odległość', () => {
  const d = distance(52.27453, 20.981534, 52.275723, 20.980973);
  assert.ok(d > 120 && d < 150, String(d));
});

test('rzut na trasę: między przystankami i na przystanku', () => {
  const s = geo.praca.stops;
  const mid = pointAt('praca', 10.5);
  const p = project(s, mid.lat, mid.lon);
  assert.equal(p.lastPassed, 10);
  assert.ok(Math.abs(p.progress - 10.5) < 0.05);
  const atStop = project(s, s[12].lat, s[12].lon);
  assert.equal(atStop.lastPassed, 12);
});

test('daleko od trasy = brak rzutu', () => {
  assert.equal(project(geo.praca.stops, 52.4, 21.3), null);
});

test('typowy czas rośnie wzdłuż trasy', () => {
  const s = geo.dom.stops;
  assert.equal(typicalAt(s, 0), 0);
  assert.ok(typicalAt(s, 10.5) > typicalAt(s, 10));
  assert.equal(typicalAt(s, s.length - 1), s.at(-1).t);
});
