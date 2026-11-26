#!/usr/bin/env node
// GTFS (mkuran.pl) -> data/timetable.json: kursy 185 na wszystkie dni z pliku (zwykle ok. 9 dni naprzód).
// Uruchamiany codziennie przez GitHub Actions przed publikacją strony; nie wymaga tokenu ani API miasta.
//
//   node scripts/build-timetable.mjs                     # pobiera mkuran.pl/gtfs/warsaw.zip
//   node scripts/build-timetable.mjs /ścieżka/gtfs [out]  # rozpakowany GTFS albo plik .zip
//
// Format mkuran: stop_id = zespół + słupek, brygada w trips.block_short_name, wariant w variant_code.

import { createReadStream, existsSync, mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { daysFromStopEvents } from '../lib/timetable.js';
import { warsawDate, addDays } from '../lib/time.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(ROOT, 'data/config.json'), 'utf8'));
const SOURCE = 'https://mkuran.pl/gtfs/warsaw.zip';
const DAYS_AHEAD = 14; // zapas, gdyby codzienna akcja na GitHubie przez kilka dni nie ruszyła

function parseCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Strumień wierszy CSV z pliku w katalogu albo prosto z .zip (bez rozpakowywania na dysk). */
async function eachRow(src, name, fn) {
  const input = src.zip
    ? spawn('unzip', ['-p', src.zip, name], { stdio: ['ignore', 'pipe', 'inherit'] }).stdout
    : createReadStream(join(src.dir, name), 'utf8');
  const rl = createInterface({ input, crlfDelay: Infinity });
  let head = null;
  for await (const line of rl) {
    if (!line) continue;
    if (!head) { head = parseCsvLine(line.replace(/^﻿/, '')); continue; }
    if (fn.filter && !fn.filter(line)) continue;
    const v = parseCsvLine(line);
    const row = {};
    head.forEach((h, i) => { row[h] = v[i]; });
    fn(row);
  }
}

const ymd = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

async function main() {
  let [arg, outPath = join(ROOT, 'data/timetable.json')] = process.argv.slice(2);
  let src;
  if (!arg) {
    const tmp = mkdtempSync(join(tmpdir(), 'gtfs-'));
    console.error('Pobieram', SOURCE, '…');
    execFileSync('curl', ['-sSL', '--fail', '--retry', '3', '-o', join(tmp, 'warsaw.zip'), SOURCE], { stdio: 'inherit' });
    src = { zip: join(tmp, 'warsaw.zip') };
  } else if (statSync(arg).isDirectory()) src = { dir: arg };
  else src = { zip: arg };

  const routeIds = new Set();
  await eachRow(src, 'routes.txt', (r) => { if (r.route_short_name === config.line) routeIds.add(r.route_id); });
  if (!routeIds.size) throw new Error(`Brak linii ${config.line} w GTFS`);

  const services = new Map(); // service_id -> [daty]
  await eachRow(src, 'calendar_dates.txt', (r) => {
    if (r.exception_type !== '1') return;
    if (!services.has(r.service_id)) services.set(r.service_id, []);
    services.get(r.service_id).push(ymd(r.date));
  });

  const trips = new Map();
  await eachRow(src, 'trips.txt', (r) => {
    if (!routeIds.has(r.route_id)) return;
    trips.set(r.trip_id, {
      dates: services.get(r.service_id) ?? [],
      brygada: r.block_short_name || r.block_id || '',
      trasa: r.variant_code || null,
      kierunek: r.trip_headsign || null
    });
  });

  const wanted = new Set();
  for (const c of Object.values(config.directions)) for (const s of [c.loop, c.myStop, c.dest]) wanted.add(s.zespol + s.slupek);

  const events = [];
  const onStopTime = (r) => {
    const t = trips.get(r.trip_id);
    if (!t || !wanted.has(r.stop_id)) return;
    for (const date of t.dates) {
      events.push({ date, stop: r.stop_id, brygada: t.brygada, czas: r.departure_time || r.arrival_time, trasa: t.trasa, kierunek: t.kierunek });
    }
  };
  // Szybki filtr na surowej linii: tylko wiersze z jednym z sześciu słupków.
  onStopTime.filter = (line) => { for (const w of wanted) if (line.includes(',' + w + ',')) return true; return false; };
  await eachRow(src, 'stop_times.txt', onStopTime);

  let feedVersion = null;
  try { await eachRow(src, 'feed_info.txt', (r) => { feedVersion = r.feed_version || null; }); } catch {}

  const from = addDays(warsawDate(Date.now()), -1);
  const to = addDays(from, DAYS_AHEAD + 1);
  const days = daysFromStopEvents(events.filter((e) => e.date >= from && e.date <= to), config);
  const dates = Object.keys(days);
  if (!dates.length) throw new Error('Brak kursów w GTFS');
  for (const d of dates) {
    if (!days[d].praca.length || !days[d].dom.length) console.error(`Uwaga: ${d} praca ${days[d].praca.length}, dom ${days[d].dom.length}`);
  }
  const out = { line: config.line, generated: new Date().toISOString(), source: SOURCE, feedVersion, days };
  writeFileSync(outPath, JSON.stringify(out));
  console.error(`Zapisano ${outPath}: ${dates[0]} … ${dates.at(-1)} (${dates.length} dni), ${Math.round(JSON.stringify(out).length / 1024)} KB`);
}

main().catch((e) => { console.error(e); process.exit(1); });
