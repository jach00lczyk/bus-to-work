import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysFromStopEvents, parseRows } from '../lib/timetable.js';
import { loadGtfsFile, buildBoard } from '../lib/board.js';
import { warsawToMs } from '../lib/time.js';
import { config, geo, readJson, ttJson } from './helpers.js';

// Zdarzenia GTFS zbudowane z tych samych danych co nagrane odjazdy, na dwa dni.
function events(dates) {
  const out = [];
  for (const d of ['praca', 'dom']) {
    const c = config.directions[d];
    for (const s of [c.loop, c.myStop, c.dest]) {
      const rows = parseRows(readJson(`test/fixtures/odjazdy_${s.zespol}_${s.slupek}_185.json`));
      for (const date of dates) for (const r of rows) out.push({ date, stop: s.zespol + s.slupek, ...r });
    }
  }
  return out;
}

test('GTFS daje te same kursy co odjazdy z API', () => {
  const days = daysFromStopEvents(events(['2026-11-26']), config);
  assert.deepEqual(days['2026-11-26'].praca, ttJson.praca);
  assert.deepEqual(days['2026-11-26'].dom, ttJson.dom);
});

test('plik z wieloma dniami: wczoraj + dziś + jutro, kursy po północy i jutro rano', () => {
  const file = { days: daysFromStopEvents(events(['2026-11-26', '2026-11-27']), config) };
  // 23:50 w czwartek: na liście kursy 24:xx z czwartku i poranne z piątku
  const now = warsawToMs(2026, 11, 26, 23, 50);
  const tt = loadGtfsFile(file, geo, now);
  const b = buildBoard({ geo, tt, tracks: new Map(), now, pins: {} });
  const ids = b.praca.items.map((t) => t.id);
  assert.ok(ids.some((id) => id.startsWith('2026-11-26_')), 'późne kursy czwartku');
  assert.ok(ids.some((id) => id.startsWith('2026-11-27_')), 'poranne kursy piątku');
  assert.ok(tt.validUntil > now && tt.validUntil <= warsawToMs(2026, 11, 27, 0, 2));
});

test('plik bez dzisiejszego dnia -> null (wtedy rozkład z Workera)', () => {
  const file = { days: daysFromStopEvents(events(['2026-11-26']), config) };
  assert.equal(loadGtfsFile(file, geo, warsawToMs(2026, 11, 28, 9, 0)), null);
});
