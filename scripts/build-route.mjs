#!/usr/bin/env node
// GTFS -> data/route-185.json
//
// Uruchamiany ręcznie, gdy zmieni się trasa linii 185:
//   node scripts/build-route.mjs                 # pobiera mkuran.pl/gtfs/warsaw.zip do katalogu tymczasowego
//   node scripts/build-route.mjs /ścieżka/gtfs   # rozpakowany GTFS (format mkuran.pl: stop_id = zespół + słupek)
//
// Dla każdego kierunku bierze najczęstszy wariant trasy (variant_code), który przejeżdża
// przez mój przystanek i cel, i zapisuje uporządkowaną listę przystanków z typowym
// (medianowym) czasem przejazdu od pętli.

import { createReadStream, existsSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LINE = '185';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(ROOT, 'data/config.json'), 'utf8'));

function parseCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function eachRow(file, fn) {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let head = null;
  for await (let line of rl) {
    if (!line) continue;
    if (!head) { head = parseCsvLine(line.replace(/^﻿/, '')); continue; }
    const v = parseCsvLine(line);
    const row = {};
    head.forEach((h, i) => { row[h] = v[i]; });
    fn(row);
  }
}

const toSec = (t) => { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + (s || 0); };
const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

async function main() {
  let dir = process.argv[2];
  let source = dir;
  if (!dir) {
    dir = mkdtempSync(join(tmpdir(), 'gtfs-'));
    source = 'https://mkuran.pl/gtfs/warsaw.zip';
    console.error('Pobieram', source, '…');
    execFileSync('curl', ['-sSL', '--fail', '-o', join(dir, 'warsaw.zip'), source], { stdio: 'inherit' });
    execFileSync('unzip', ['-q', '-o', join(dir, 'warsaw.zip'), 'stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt', 'feed_info.txt', '-d', dir], { stdio: 'inherit' });
  }
  if (!existsSync(join(dir, 'stop_times.txt'))) throw new Error('Brak stop_times.txt w ' + dir);

  const routeIds = new Set();
  await eachRow(join(dir, 'routes.txt'), (r) => { if (r.route_short_name === LINE) routeIds.add(r.route_id); });

  const trips = new Map(); // trip_id -> {variant, headsign}
  await eachRow(join(dir, 'trips.txt'), (r) => {
    if (routeIds.has(r.route_id)) trips.set(r.trip_id, { variant: r.variant_code || r.shape_id, headsign: r.trip_headsign });
  });

  const times = new Map(); // trip_id -> [{seq, stop, t}]
  await eachRow(join(dir, 'stop_times.txt'), (r) => {
    if (!trips.has(r.trip_id)) return;
    let a = times.get(r.trip_id);
    if (!a) times.set(r.trip_id, (a = []));
    a.push({ seq: Number(r.stop_sequence), stop: r.stop_id, t: toSec(r.departure_time || r.arrival_time) });
  });

  const stops = new Map();
  await eachRow(join(dir, 'stops.txt'), (r) => { stops.set(r.stop_id, r); });

  let feedVersion = null;
  try { await eachRow(join(dir, 'feed_info.txt'), (r) => { feedVersion = r.feed_version || r.feed_start_date || null; }); } catch {}

  // Grupujemy kursy po sekwencji przystanków.
  const patterns = new Map(); // key -> {stops, trips:[times], variants:Set, headsign}
  for (const [id, st] of times) {
    st.sort((x, y) => x.seq - y.seq);
    const key = st.map((s) => s.stop).join('>');
    let p = patterns.get(key);
    if (!p) patterns.set(key, (p = { stops: st.map((s) => s.stop), runs: [], variants: new Set(), headsign: trips.get(id).headsign }));
    p.runs.push(st.map((s) => s.t));
    p.variants.add(trips.get(id).variant);
  }

  const out = { line: LINE, generated: new Date().toISOString(), source, feedVersion, directions: {} };
  for (const dirKey of ['praca', 'dom']) {
    const c = config.directions[dirKey];
    const mine = c.myStop.zespol + c.myStop.slupek;
    const dest = c.dest.zespol + c.dest.slupek;
    const cands = [...patterns.values()].filter((p) => {
      const i = p.stops.indexOf(mine), j = p.stops.indexOf(dest);
      return i >= 0 && j > i;
    }).sort((a, b) => b.runs.length - a.runs.length);
    if (!cands.length) throw new Error(`Żaden kurs ${LINE} nie jedzie z ${mine} do ${dest}`);
    const p = cands[0];
    const seg = [];
    for (let i = 0; i + 1 < p.stops.length; i++) seg.push(median(p.runs.map((r) => r[i + 1] - r[i])));
    let acc = 0;
    out.directions[dirKey] = {
      headsign: p.headsign,
      variant: [...p.variants].join(','),
      trips: p.runs.length,
      stops: p.stops.map((id, i) => {
        if (i > 0) acc += seg[i - 1];
        const s = stops.get(id);
        return { id, zespol: id.slice(0, 4), slupek: id.slice(4, 6), name: s?.stop_name ?? id, lat: Number(s?.stop_lat), lon: Number(s?.stop_lon), t: Math.round(acc) };
      })
    };
    const d = out.directions[dirKey];
    console.error(`${dirKey}: ${d.headsign} [${d.variant}], ${d.stops.length} przyst., ${d.trips} kursów, ${d.stops[0].name} → ${d.stops.at(-1).name}`);
  }

  writeFileSync(join(ROOT, 'data/route-185.json'), JSON.stringify(out, null, 1) + '\n');
  console.error('Zapisano data/route-185.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
