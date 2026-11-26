import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRows, parseLines, buildCourses, pickServiceDate, normBrigade } from '../lib/timetable.js';
import { clockToSec, warsawToMs } from '../lib/time.js';
import { ttJson, allRows, readJson, at } from './helpers.js';

test('parseRows: goła lista par {key,value}, null, stara koperta', () => {
  const body = [[{ value: '013', key: 'brygada' }, { value: '07:54:00', key: 'czas' }, { value: 'null', key: 'symbol_1' }]];
  assert.deepEqual(parseRows(body), [{ brygada: '013', czas: '07:54:00', symbol_1: null }]);
  assert.deepEqual(parseRows(null), []);
  assert.deepEqual(parseRows({ result: null }), []);
  assert.deepEqual(parseRows({ message: 'Service unavailable' }), []);
  assert.deepEqual(parseRows({ result: [{ values: [{ key: 'linia', value: '185' }] }] }), [{ linia: '185' }]);
});

test('parseLines: format zmierzony na nowym hoście', () => {
  const body = [{ values: [{ value: '523', key: 'linia' }] }, { values: [{ value: '185', key: 'linia' }] }];
  assert.deepEqual(parseLines(body), ['523', '185']);
});

test('brygady bez zer wiodących', () => {
  assert.equal(normBrigade('05'), '5');
  assert.equal(normBrigade('5'), '5');
  assert.equal(normBrigade('013'), '13');
  assert.equal(normBrigade('0'), '0');
});

test('kursy z nagranych odjazdów: przyjazd po odjeździe, pętla przed, id', () => {
  for (const d of ['praca', 'dom']) {
    const cs = ttJson[d];
    assert.ok(cs.length > 60, `${d}: ${cs.length} kursów`);
    for (const c of cs) {
      assert.ok(c.arr > c.dep, 'przyjazd po odjeździe');
      const ride = (c.arr - c.dep) / 60;
      assert.ok(ride >= 15 && ride <= 50, `${d} ${c.id}: przejazd ${ride} min`);
      if (c.loop != null) assert.ok(c.loop <= c.dep && c.dep - c.loop < 45 * 60, `${c.id}: pętla`);
      assert.match(c.id, /^2026-11-26_\d+_\d{4}$/);
      assert.ok(!c.brigade.startsWith('0'));
    }
    assert.equal(new Set(cs.map((c) => c.id)).size, cs.length, 'id unikalne');
  }
  // Większość kursów ma odjazd z pętli z rozkładu.
  assert.ok(ttJson.praca.filter((c) => c.loop != null).length > 60);
});

test('kurs skrócony (nie dojeżdża do celu) jest pominięty', () => {
  const rows = allRows().dom;
  const myCount = rows.my.length;
  // W GTFS na 26.11 jest kurs TX-PLW kończący się na Pl. Wilsona – nie dojeżdża do Marymontu.
  assert.ok(rows.my.some((r) => r.trasa === 'TX-PLW'));
  assert.ok(ttJson.dom.length < myCount);
  assert.ok(!ttJson.dom.some((c) => c.trasa === 'TX-PLW'));
});

test('godziny 24:xx w kursach', () => {
  const late = ttJson.praca.filter((c) => c.arr >= 24 * 3600);
  assert.ok(late.length >= 1);
});

test('buildCourses: przyjazd nie jest brany z następnego kursu brygady', () => {
  const r = (b, czas) => ({ brygada: b, czas });
  const cs = buildCourses({
    loopRows: [r('1', '07:50:00'), r('1', '10:20:00')],
    myRows: [r('1', '08:00:00'), r('01', '10:30:00')],
    destRows: [r('1', '11:00:00')],
    serviceDate: '2026-11-26'
  });
  assert.equal(cs.length, 1);
  assert.equal(cs[0].dep, clockToSec('10:30'));
  assert.equal(cs[0].loop, clockToSec('10:20'));
  assert.equal(cs[0].id, '2026-11-26_1_1030');
});

test('dzień rozkładowy rozpoznany po danych', () => {
  const deps = allRows().praca.my.map((r) => clockToSec(r.czas));
  assert.equal(pickServiceDate(deps, at(14, 0)), '2026-11-26');
  // 00:30: jeszcze stary dzień (są kursy 24:xx)
  assert.equal(pickServiceDate(deps, warsawToMs(2026, 11, 27, 0, 10)), '2026-11-26');
  // 03:00: nic nie jeździ, obowiązuje zasada 05:00
  assert.equal(pickServiceDate(deps, warsawToMs(2026, 11, 27, 3, 0)), '2026-11-26');
  // 04:55: API już przełączyło (odjazdy ok. 05:00 pasują do nowej daty)
  assert.equal(pickServiceDate(deps, warsawToMs(2026, 11, 27, 4, 55)), '2026-11-27');
});

test('odpowiedź pozycji w formacie API', () => {
  const rows = readJson('test/fixtures/positions.json');
  assert.ok(rows.some((r) => r.Lines === '185'));
});
