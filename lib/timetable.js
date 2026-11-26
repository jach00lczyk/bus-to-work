// Składanie kursów z odjazdów linii z trzech słupków (pętla, mój przystanek, cel).
// Używane przez Workera (GET /timetable); czysta logika, testowana w Node.

import { clockToSec, defaultServiceDate, warsawDate, addDays, serviceSecToMs, nextFlip, MIN } from './time.js';

/** Brygady porównujemy bez zer wiodących: "05" = "5". */
export const normBrigade = (b) => String(b ?? '').trim().replace(/^0+(?=.)/, '');

const nullish = (v) => (v == null || v === 'null' ? null : v);

/**
 * Odpowiedź `get_ztm_odjazdy_linii_z_przystanku` -> [{brygada, kierunek, trasa, czas, symbol_1, symbol_2}].
 * Nowe API: goła lista wierszy, każdy wiersz to lista par {key, value}; `null`, gdy linia dziś nie kursuje.
 * Dla pewności przyjmujemy też wiersze `{values:[…]}` i starą kopertę `{result: …}`.
 */
export function parseRows(body) {
  if (body && !Array.isArray(body) && typeof body === 'object' && 'result' in body) body = body.result;
  if (!Array.isArray(body)) return [];
  const out = [];
  for (const row of body) {
    const pairs = Array.isArray(row) ? row : Array.isArray(row?.values) ? row.values : null;
    if (!pairs) continue;
    const o = {};
    for (const p of pairs) if (p && typeof p.key === 'string') o[p.key] = nullish(p.value);
    out.push(o);
  }
  return out;
}

/** Odpowiedź `get_ztm_lista_linii_na_przystanku` -> ["185", …]. */
export function parseLines(body) {
  return parseRows(body).map((r) => r.linia).filter(Boolean);
}

const LOOK = 3 * 3600; // maks. 3 h między pętlą a moim przystankiem i między moim przystankiem a celem

function byBrigade(rows) {
  const m = new Map();
  for (const r of rows) {
    const sec = clockToSec(r.czas);
    if (!Number.isFinite(sec) || r.brygada == null) continue;
    const b = normBrigade(r.brygada);
    if (!m.has(b)) m.set(b, []);
    m.get(b).push({ sec, kierunek: r.kierunek ?? null, trasa: r.trasa ?? null });
  }
  for (const a of m.values()) a.sort((x, y) => x.sec - y.sec);
  return m;
}

const pad = (n) => String(n).padStart(2, '0');
const secToId = (s) => pad(Math.floor(s / 3600)) + pad(Math.floor(s / 60) % 60);

/**
 * Kursy jednego kierunku.
 *  1. Każdy wiersz z mojego przystanku to kurs (planowy odjazd, brygada).
 *  2. Planowy przyjazd = najwcześniejszy wiersz w celu tej samej brygady po odjeździe
 *     (i przed jej następnym odjazdem z mojego przystanku).
 *  3. Planowy odjazd z pętli = najpóźniejszy wiersz na pętli tej samej brygady przed odjazdem
 *     (i po jej poprzednim odjeździe z mojego przystanku); brak -> null.
 *  4. Id kursu = dzień rozkładowy + brygada + planowy odjazd.
 * Kursy, które nie dojeżdżają do celu (np. skrócone), pomijamy.
 * Czasy w sekundach od północy dnia rozkładowego (mogą przekraczać 24 h).
 */
export function buildCourses({ loopRows, myRows, destRows, serviceDate }) {
  const loop = byBrigade(loopRows ?? []);
  const mine = byBrigade(myRows ?? []);
  const dest = byBrigade(destRows ?? []);
  const out = [];
  for (const [b, deps] of mine) {
    deps.forEach((d, i) => {
      const next = deps[i + 1]?.sec ?? Infinity;
      const prev = deps[i - 1]?.sec ?? -Infinity;
      const arr = (dest.get(b) ?? []).find((x) => x.sec > d.sec && x.sec < next && x.sec - d.sec <= LOOK);
      if (!arr) return;
      const lp = (loop.get(b) ?? []).filter((x) => x.sec <= d.sec && x.sec > prev && d.sec - x.sec <= LOOK).at(-1);
      out.push({
        id: `${serviceDate}_${b}_${secToId(d.sec)}`,
        brigade: b,
        loop: lp ? lp.sec : null,
        dep: d.sec,
        arr: arr.sec,
        kierunek: d.kierunek,
        trasa: d.trasa
      });
    });
  }
  out.sort((x, y) => x.dep - y.dep || (x.brigade < y.brigade ? -1 : 1));
  return out;
}

/**
 * Który dzień rozkładowy zwróciło API? Nowe API przełącza dzień ok. 04:51, a nie o północy,
 * więc sprawdzamy, przy której dacie odjazdy wypadają w oknie ±30 min od „teraz”.
 * Gdy nie da się rozstrzygnąć (brak kursów w oknie), obowiązuje zasada: przed 05:00 = poprzedni dzień.
 */
export function pickServiceDate(depSecs, now) {
  const def = defaultServiceDate(now);
  const today = warsawDate(now);
  const cands = [...new Set([def, today, addDays(today, -1)])];
  let best = def, bestN = -1;
  for (const date of cands) {
    let n = 0;
    for (const s of depSecs) {
      const t = serviceSecToMs(date, s);
      if (t >= now - 30 * MIN && t <= now + 30 * MIN) n++;
    }
    if (n > bestN || (n === bestN && date === def)) { best = date; bestN = n; }
  }
  return bestN > 0 ? best : def;
}

/**
 * Cała odpowiedź /timetable z odjazdów sześciu słupków.
 * rows = { praca: {loop, my, dest}, dom: {loop, my, dest} } – wiersze po parseRows.
 */
export function assembleTimetable(rows, now) {
  const deps = ['praca', 'dom'].flatMap((d) => rows[d].my.map((r) => clockToSec(r.czas))).filter(Number.isFinite);
  const serviceDate = pickServiceDate(deps, now);
  const out = { serviceDate, validUntil: nextFlip(now), generatedAt: now };
  for (const d of ['praca', 'dom']) {
    out[d] = buildCourses({ loopRows: rows[d].loop, myRows: rows[d].my, destRows: rows[d].dest, serviceDate });
  }
  return out;
}

/** Odpowiedź `get_ztm_lokalizacja_pojazdow` -> pozycje jednej linii w formacie /positions. */
export function parsePositions(body, line = '185') {
  if (body && !Array.isArray(body) && Array.isArray(body.result)) body = body.result;
  if (!Array.isArray(body)) return [];
  return body
    .filter((r) => String(r?.Lines ?? '').trim() === line)
    .map((r) => ({
      brigade: String(r.Brigade ?? '').trim(),
      vehicle: String(r.VehicleNumber ?? '').trim(),
      lat: Number(r.Lat),
      lon: Number(r.Lon),
      time: String(r.Time ?? '')
    }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.time);
}

/**
 * Rozkład z GTFS: zdarzenia na sześciu słupkach -> kursy każdego dnia rozkładowego.
 * events = [{ date: "YYYY-MM-DD", stop: "<zespół><słupek>", brygada, czas: "HH:MM:SS", trasa, kierunek }]
 * Zwraca { "<data>": { praca: [...], dom: [...] } } – kursy w tym samym formacie co /timetable.
 */
export function daysFromStopEvents(events, config) {
  const byDate = new Map();
  for (const e of events) {
    if (!byDate.has(e.date)) byDate.set(e.date, new Map());
    const m = byDate.get(e.date);
    if (!m.has(e.stop)) m.set(e.stop, []);
    m.get(e.stop).push({ brygada: e.brygada, czas: e.czas, trasa: e.trasa ?? null, kierunek: e.kierunek ?? null });
  }
  const key = (s) => s.zespol + s.slupek;
  const out = {};
  for (const date of [...byDate.keys()].sort()) {
    const m = byDate.get(date);
    out[date] = {};
    for (const d of ['praca', 'dom']) {
      const c = config.directions[d];
      out[date][d] = buildCourses({
        loopRows: m.get(key(c.loop)) ?? [],
        myRows: m.get(key(c.myStop)) ?? [],
        destRows: m.get(key(c.dest)) ?? [],
        serviceDate: date
      });
    }
  }
  return out;
}

/**
 * Zapasowy feed mkuran.pl/gtfs/warsaw/vehicles.json (pozycje z API miasta, odświeżane co kilkanaście s)
 * -> pozycje jednej linii w formacie /positions. Brygada jest w id: "V/<linia>/<brygada>".
 */
export function parseMkuranPositions(body, line = '185') {
  const list = Array.isArray(body?.positions) ? body.positions : [];
  const out = [];
  for (const v of list) {
    const m = /^V\/([^/]+)\/(.+)$/.exec(String(v?.id ?? ''));
    if (!m || m[1] !== line) continue;
    const lat = Number(v.lat), lon = Number(v.lon);
    // "2026-11-26T21:36:44+01:00" -> czas warszawski "2026-11-26 21:36:44" (offset to zawsze Warszawa)
    const ts = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(String(v.timestamp ?? ''));
    if (!ts || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({ brigade: m[2], vehicle: String(v.side_number ?? ''), lat, lon, time: `${ts[1]} ${ts[2]}` });
  }
  return out;
}
