#!/usr/bin/env node
// Lokalny podgląd bez tokenu miasta: serwuje stronę i udaje proxy pod /mock.
//   node scripts/dev-server.mjs [port]     -> http://localhost:8185
// Rozkład = nagrane odpowiedzi z test/fixtures przeliczone na dziś; pozycje = symulacja jazdy
// z losowym opóźnieniem brygady. Część brygad celowo bez GPS. Klucz aplikacji: dowolny.

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRows, assembleTimetable } from '../lib/timetable.js';
import { prepareGeo, loadTimetable, plannedAt } from '../lib/board.js';
import { warsaw, MIN } from '../lib/time.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] ?? 8185);
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const config = read('data/config.json');
const geo = prepareGeo(read('data/route-185.json'), config);

const rows = {};
for (const d of ['praca', 'dom']) {
  const c = config.directions[d];
  const f = (s) => parseRows(read(`test/fixtures/odjazdy_${s.zespol}_${s.slupek}_185.json`));
  rows[d] = { loop: f(c.loop), my: f(c.myStop), dest: f(c.dest) };
}
let ttJson = null;
const timetable = () => {
  const now = Date.now();
  if (!ttJson || now >= ttJson.validUntil) ttJson = assembleTimetable(rows, now);
  return ttJson;
};

const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const pad = (n) => String(n).padStart(2, '0');
const apiTime = (ms) => { const p = warsaw(ms); return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`; };

function pointAt(g, progress) {
  const s = g.stops;
  const i = Math.max(0, Math.min(s.length - 2, Math.floor(progress)));
  const f = Math.max(0, Math.min(1, progress - i));
  return { lat: s[i].lat + f * (s[i + 1].lat - s[i].lat), lon: s[i].lon + f * (s[i + 1].lon - s[i].lon) };
}

/** Postęp kursu w chwili t (bisekcja po planowym czasie). */
function progressAt(trip, g, t) {
  let lo = 0, hi = g.stops.length - 1;
  for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (plannedAt(trip, m, g) < t) lo = m; else hi = m; }
  return lo;
}

function positions() {
  const now = Date.now();
  const tt = loadTimetable(timetable(), geo);
  const out = [];
  for (const [b, trips] of tt.byBrigade) {
    const h = hash(b);
    if (h % 6 === 0) continue;                      // brak GPS
    const delay = ((h >> 3) % 7) * MIN;             // 0–6 min opóźnienia
    const lag = 5000 + ((h >> 5) % 20) * 1000;      // GPS 5–25 s za rzeczywistością
    const t = now - lag - delay;
    let pt = null;
    for (let i = 0; i < trips.length; i++) {
      const tr = trips[i], g = geo[tr.dir];
      const start = plannedAt(tr, 0, g), end = plannedAt(tr, g.stops.length - 1, g);
      if (t >= start && t <= end) { pt = pointAt(g, progressAt(tr, g, t)); break; }
      const next = trips[i + 1];
      if (next && t > end && t < plannedAt(next, 0, geo[next.dir])) { pt = pointAt(geo[next.dir], geo[next.dir].loopIdx); break; }
    }
    if (!pt) continue;
    out.push({ brigade: b, vehicle: String(8500 + (h % 99)), lat: +pt.lat.toFixed(6), lon: +pt.lon.toFixed(6), time: apiTime(now - lag) });
  }
  return { fetchedAt: now, positions: out };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/mock/')) {
    if (!req.headers['x-app-key']) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"unauthorized"}'); }
    const body = url.pathname === '/mock/positions' ? positions() : url.pathname === '/mock/timetable' ? timetable() : null;
    if (!body) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(body));
  }
  let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (p.endsWith('/')) p += 'index.html';
  const file = join(ROOT, p);
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(readFileSync(file));
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
