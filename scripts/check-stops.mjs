#!/usr/bin/env node
// Jednorazowe sprawdzenie przystanków z data/config.json w API miasta (z Maca, z polskim IP):
//   WAW_TOKEN=… node scripts/check-stops.mjs            # czy 185 staje na każdym słupku, ile odjazdów
//   WAW_TOKEN=… node scripts/check-stops.mjs --record   # do tego zapisuje prawdziwe odpowiedzi do test/fixtures
// Token czyta tylko ze zmiennej środowiskowej; nigdzie go nie zapisuje.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLines, parseRows } from '../lib/timetable.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(ROOT, 'data/config.json'), 'utf8'));
const token = process.env.WAW_TOKEN;
const record = process.argv.includes('--record');
if (!token) { console.error('Ustaw WAW_TOKEN'); process.exit(1); }

async function call(action, body) {
  const res = await fetch('https://dane.um.warszawa.pl/api/action/' + action, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${action} ${JSON.stringify(body)}: HTTP ${res.status} ${text.slice(0, 80)}`);
  return text ? JSON.parse(text) : null;
}

let ok = true;
for (const [dir, c] of Object.entries(config.directions)) {
  for (const [role, s] of [['pętla', c.loop], ['mój', c.myStop], ['cel', c.dest]]) {
    const id = { busstopId: s.zespol, busstopNr: s.slupek };
    const lines = parseLines(await call('get_ztm_lista_linii_na_przystanku', id));
    const raw = await call('get_ztm_odjazdy_linii_z_przystanku', { ...id, line: config.line });
    const rows = parseRows(raw);
    const has = lines.includes(config.line);
    ok &&= has && rows.length > 0;
    console.log(`${has ? '✓' : '✗'} ${dir.padEnd(5)} ${role.padEnd(5)} ${s.name} ${s.zespol}/${s.slupek}: ${rows.length} odjazdów` +
      (rows.length ? ` (${rows[0].czas}…, brygada „${rows[0].brygada}”, ${rows[0].trasa})` : ''));
    if (record) writeFileSync(join(ROOT, `test/fixtures/odjazdy_${s.zespol}_${s.slupek}_${config.line}.json`), JSON.stringify(raw));
  }
}
if (record) {
  const pos = await call('get_ztm_lokalizacja_pojazdow', { type: '1' });
  writeFileSync(join(ROOT, 'test/fixtures/positions-live.json'), JSON.stringify(pos.filter((r) => r.Lines === config.line)));
  console.log('Zapisano nagrania w test/fixtures');
}
process.exit(ok ? 0 : 2);
