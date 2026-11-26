// Proxy dla strony 185: dokłada token miasta i jako jedyne rozmawia z dane.um.warszawa.pl.
// Trasy: GET /positions, GET /timetable. Wymaga nagłówka X-App-Key.
// Sekrety (wrangler secret put): WAW_TOKEN – token miasta, APP_KEY – klucz aplikacji.
// Zmienne (wrangler.toml): ALLOWED_ORIGINS – originy strony, rozdzielone przecinkami.

import config from '../data/config.json' with { type: 'json' };
import { parseRows, parsePositions, parseMkuranPositions, assembleTimetable } from '../lib/timetable.js';
import { nextFlip } from '../lib/time.js';

const API = 'https://dane.um.warszawa.pl/api/action/';
// Miasto z Cloudflare odpowiada bardzo zawodnie (26.11.2026: niemal wszystko wisi do limitu czasu).
// Pozycje bierzemy więc najpierw z feedu mkuran.pl (ten sam źródłowy strumień z API miasta), a miasto pytamy awaryjnie.
const MKURAN_VEHICLES = 'https://mkuran.pl/gtfs/warsaw/vehicles.json';
const MKURAN_MAX_AGE_MS = 2 * 60_000;
// Miasto potrafi „zgubić” połączenie z Cloudflare: zapytanie wisi, a ponowione przechodzi w ułamku sekundy.
// Dlatego krótki limit i kilka prób (normalnie API odpowiada w 30–110 ms).
const TIMEOUT_MS = 2500;
const ATTEMPTS = 3;
const POSITIONS_TTL_MS = 10_000;

// Pamięć izolatu: przeżywa między zapytaniami tego samego egzemplarza Workera.
// stops: udane odjazdy pojedynczych słupków do zmiany dnia rozkładowego, żeby przy zawodnym API
// kolejne próby dociągały tylko brakujące słupki.
export const mem = { positions: null, positionsAt: 0, timetable: null, stops: {}, lastGood: {} };

class CityError extends Error {}

async function city(env, action, body) {
  const init = {
    method: 'POST',
    headers: { Authorization: env.WAW_TOKEN, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  };
  let lastErr;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const res = await fetch(API + action, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const text = await res.text();
      if (!res.ok) throw new CityError(`${action}: HTTP ${res.status} ${text.slice(0, 80)}`);
      return text === '' ? null : JSON.parse(text);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof CityError ? lastErr : new CityError(`${action}: ${lastErr?.name ?? 'błąd'} ${lastErr?.message ?? ''}`);
}

async function mkuranPositions(now) {
  const res = await fetch(`${MKURAN_VEHICLES}?t=${Math.floor(now / 5000)}`, {
    cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new CityError(`mkuran: HTTP ${res.status}`);
  const body = await res.json();
  const feedTime = Date.parse(body?.time);
  if (!Number.isFinite(feedTime) || now - feedTime > MKURAN_MAX_AGE_MS) throw new CityError(`mkuran: stary feed ${body?.time}`);
  return { fetchedAt: now, source: 'mkuran', positions: parseMkuranPositions(body, config.line), total: body.positions?.length ?? 0 };
}

async function getPositions(env, now) {
  if (mem.positions && now - mem.positionsAt < POSITIONS_TTL_MS) return mem.positions;
  try {
    const out = await mkuranPositions(now);
    mem.positions = out;
    mem.positionsAt = now;
    return out;
  } catch (e) {
    console.log('mkuran error', String(e?.message ?? e));
  }
  return cityPositions(env, now);
}

async function cityPositions(env, now) {
  // Uwaga: ta akcja chce LICZBY ({"type": 1}, jak w dokumentacji miasta); "1" daje pustą listę.
  // Pozostałe akcje chcą stringów. Pusta lista mimo to -> jedna próba ze stringiem, na wypadek zmiany API.
  let body = await city(env, 'get_ztm_lokalizacja_pojazdow', { type: 1 });
  if (Array.isArray(body) && body.length === 0) body = await city(env, 'get_ztm_lokalizacja_pojazdow', { type: '1' });
  const rows = Array.isArray(body) ? body : Array.isArray(body?.result) ? body.result : null;
  if (!rows) throw new CityError(`get_ztm_lokalizacja_pojazdow: nieoczekiwana odpowiedź ${JSON.stringify(body).slice(0, 120)}`);
  const out = { fetchedAt: now, source: 'city', positions: parsePositions(rows, config.line), total: rows.length };
  mem.positions = out;
  mem.positionsAt = now;
  return out;
}

async function departures(env, stop) {
  const body = await city(env, 'get_ztm_odjazdy_linii_z_przystanku', {
    busstopId: stop.zespol, busstopNr: stop.slupek, line: config.line
  });
  return parseRows(body);
}

async function stopDepartures(env, stop, now) {
  const key = stop.zespol + '/' + stop.slupek;
  const hit = mem.stops[key];
  if (hit && now < hit.until) return hit.rows;
  const rows = await departures(env, stop);
  mem.stops[key] = { rows, until: nextFlip(now) };
  return rows;
}

async function getTimetable(env, now) {
  if (mem.timetable && now < mem.timetable.validUntil) return mem.timetable;
  // Po kolei, nie równolegle: mniej jednoczesnych połączeń do miasta. Udane słupki zostają w pamięci.
  const rows = {};
  let failed = null;
  for (const d of ['praca', 'dom']) {
    const c = config.directions[d];
    rows[d] = {};
    for (const [k, stop] of [['loop', c.loop], ['my', c.myStop], ['dest', c.dest]]) {
      try {
        rows[d][k] = await stopDepartures(env, stop, now);
      } catch (e) {
        failed ??= e;
      }
    }
  }
  if (failed) throw failed;
  const tt = assembleTimetable(rows, now);
  mem.timetable = tt;
  return tt;
}

function allowedOrigin(env, origin) {
  const list = String(env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return origin && list.includes(origin) ? origin : null;
}

function cors(env, req) {
  const origin = allowedOrigin(env, req.headers.get('Origin'));
  const h = { Vary: 'Origin' };
  if (origin) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'X-App-Key';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
  });
}

async function keyOk(env, given) {
  if (!env.APP_KEY || !given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(env.APP_KEY))
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export default {
  async fetch(req, env) {
    const h = cors(env, req);
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    if (req.method !== 'GET') return json({ error: 'method' }, 405, { ...h, Allow: 'GET, OPTIONS' });

    const routes = { '/positions': getPositions, '/timetable': getTimetable };
    const handler = routes[url.pathname];
    if (!handler) return json({ error: 'not found' }, 404, h);
    if (!(await keyOk(env, req.headers.get('X-App-Key')))) return json({ error: 'unauthorized' }, 401, h);

    const now = Date.now();
    try {
      const data = await handler(env, now);
      mem.lastGood[url.pathname] = data;
      return json(data, 200, h);
    } catch (e) {
      console.log('city error', String(e?.message ?? e));
      const stale = mem.lastGood[url.pathname];
      return json(stale ? { ...stale, stale: true } : { error: 'upstream' }, 502, h);
    }
  }
};
