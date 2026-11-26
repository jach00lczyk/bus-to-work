import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRows, assembleTimetable } from '../lib/timetable.js';
import { prepareGeo, loadTimetable, plannedAt } from '../lib/board.js';
import { warsawToMs } from '../lib/time.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
export const config = readJson('data/config.json');
export const route = readJson('data/route-185.json');
export const geo = prepareGeo(route, config);

export function fixtureRows(stop) {
  return parseRows(readJson(`test/fixtures/odjazdy_${stop.zespol}_${stop.slupek}_185.json`));
}

export function allRows() {
  const rows = {};
  for (const d of ['praca', 'dom']) {
    const c = config.directions[d];
    rows[d] = { loop: fixtureRows(c.loop), my: fixtureRows(c.myStop), dest: fixtureRows(c.dest) };
  }
  return rows;
}

/** Czwartek 26.11.2026, godzina warszawska. */
export const at = (h, m = 0, s = 0) => warsawToMs(2026, 11, 26, h, m, s);

export const ttJson = assembleTimetable(allRows(), at(7, 0));
export const tt = loadTimetable(ttJson, geo);

/** Punkt na trasie kierunku w ciągłym indeksie przystanków (interpolacja liniowa). */
export function pointAt(dir, progress) {
  const s = geo[dir].stops;
  const i = Math.min(s.length - 2, Math.floor(progress));
  const f = progress - i;
  return { lat: s[i].lat + f * (s[i + 1].lat - s[i].lat), lon: s[i].lon + f * (s[i + 1].lon - s[i].lon) };
}

/** Pozycja w formacie odpowiedzi /positions. */
export function pos(brigade, dir, progress, timeMs) {
  const p = pointAt(dir, progress);
  return { brigade, vehicle: '1000', lat: p.lat, lon: p.lon, time: timeMs };
}

/** Pierwszy kurs kierunku od godziny h, którego brygada ma kurs wcześniej (w drugą stronę). */
export function pickCourse(dir, h) {
  for (const C of tt.trips[dir]) {
    if (C.dep < at(h)) continue;
    const bt = tt.byBrigade.get(C.brigade);
    const i = bt.indexOf(C);
    if (i > 0 && bt[i - 1].dir !== dir) return { C, prev: bt[i - 1] };
  }
  throw new Error('brak kursu');
}

export { plannedAt };
