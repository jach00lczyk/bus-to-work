import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { mem } from '../worker/index.js';
import { readJson } from './helpers.js';

const env = { WAW_TOKEN: 'tok.en.x', APP_KEY: 'sekret-aplikacji', ALLOWED_ORIGINS: 'https://jach00lczyk.github.io' };
const ORIGIN = 'https://jach00lczyk.github.io';
let calls, mode;

beforeEach(() => {
  calls = [];
  mode = 'ok';
  mem.positions = null; mem.timetable = null; mem.stops = {}; mem.lastGood = {};
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://mkuran.pl/')) {
      calls.push({ action: 'mkuran' });
      if (mode !== 'mkuran-ok') return new Response('down', { status: 503 });
      const body = readJson('test/fixtures/mkuran-vehicles.json');
      return Response.json({ ...body, time: new Date(Date.now() - 5000).toISOString() });
    }
    const action = String(url).split('/').at(-1);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ action, body, auth: init.headers.Authorization });
    if (mode === 'down') return new Response('{"message":"Service unavailable"}', { status: 500 });
    if (mode === 'flaky' && calls.filter((c) => c.action === action && JSON.stringify(c.body) === JSON.stringify(body)).length === 1) {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }
    if (mode === 'stop-down' && body?.busstopId === '3292') return new Response('{"message":"Service unavailable"}', { status: 500 });
    if (action === 'get_ztm_lokalizacja_pojazdow') {
      if (mode === 'positions-string-only') return Response.json(body.type === '1' ? readJson('test/fixtures/positions.json') : []);
      if (mode === 'positions-weird') return Response.json({ message: 'coś innego' });
      // Jak na nowym hoście: liczba działa, string daje pustą listę.
      return Response.json(body.type === 1 ? readJson('test/fixtures/positions.json') : []);
    }
    if (action === 'get_ztm_odjazdy_linii_z_przystanku') {
      return Response.json(readJson(`test/fixtures/odjazdy_${body.busstopId}_${body.busstopNr}_185.json`));
    }
    return new Response('{"message":"Service unavailable"}', { status: 500 });
  };
});

const cityCalls = () => calls.filter((c) => c.action !== 'mkuran');
const get = (path, headers = {}) => worker.fetch(new Request('https://proxy.example' + path, { headers: { Origin: ORIGIN, ...headers } }), env);

test('bez poprawnego X-App-Key: 401, a miasto nie jest pytane', async () => {
  assert.equal((await get('/positions')).status, 401);
  assert.equal((await get('/positions', { 'X-App-Key': 'zly-klucz' })).status, 401);
  assert.equal(calls.length, 0);
});

test('CORS tylko dla strony; OPTIONS bez klucza', async () => {
  const pre = await worker.fetch(new Request('https://proxy.example/positions', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match(pre.headers.get('Access-Control-Allow-Headers'), /X-App-Key/);
  const other = await get('/positions', { Origin: 'https://evil.example', 'X-App-Key': env.APP_KEY });
  assert.equal(other.headers.get('Access-Control-Allow-Origin'), null);
});

test('tylko GET i tylko dwie trasy', async () => {
  const post = await worker.fetch(new Request('https://proxy.example/positions', { method: 'POST', headers: { 'X-App-Key': env.APP_KEY } }), env);
  assert.equal(post.status, 405);
  assert.equal((await get('/get_ztm_przystanki_komunikacji_miejskiej', { 'X-App-Key': env.APP_KEY })).status, 404);
});

test('/positions: token surowy, type jako liczba, tylko linia 185, cache 10 s', async () => {
  const r = await get('/positions', { 'X-App-Key': env.APP_KEY });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.positions.length, 3);
  assert.deepEqual(Object.keys(data.positions[0]).sort(), ['brigade', 'lat', 'lon', 'time', 'vehicle']);
  assert.equal(cityCalls()[0].auth, env.WAW_TOKEN);
  assert.deepEqual(cityCalls()[0].body, { type: 1 });
  assert.equal(data.total, 5);
  const n = calls.length;
  await get('/positions', { 'X-App-Key': env.APP_KEY });
  assert.equal(calls.length, n, 'druga odpowiedź z pamięci');
});

test('/timetable: 6 słupków, kursy obu kierunków', async () => {
  const r = await get('/timetable', { 'X-App-Key': env.APP_KEY });
  assert.equal(r.status, 200);
  const tt = await r.json();
  assert.equal(calls.length, 6);
  assert.ok(calls.every((c) => c.body.line === '185' && typeof c.body.busstopId === 'string'));
  assert.ok(tt.praca.length > 60 && tt.dom.length > 60);
  assert.ok(tt.validUntil > Date.now());
  await get('/timetable', { 'X-App-Key': env.APP_KEY });
  assert.equal(calls.length, 6, 'rozkład z pamięci do 05:00');
});

test('awaria miasta: 502 z ostatnią dobrą odpowiedzią, jedna ponowna próba', async () => {
  const ok = await (await get('/positions', { 'X-App-Key': env.APP_KEY })).json();
  mem.positions = null;
  mode = 'down';
  calls = [];
  const r = await get('/positions', { 'X-App-Key': env.APP_KEY });
  assert.equal(r.status, 502);
  assert.equal(cityCalls().length, 3, 'trzy próby');
  const body = await r.json();
  assert.equal(body.stale, true);
  assert.deepEqual(body.positions, ok.positions);
  mem.lastGood = {};
  const r2 = await get('/positions', { 'X-App-Key': env.APP_KEY });
  assert.equal(r2.status, 502);
  assert.deepEqual(await r2.json(), { error: 'upstream' });
});

test('/positions: pusta lista przy liczbie -> jedna próba ze stringiem', async () => {
  mode = 'positions-string-only';
  const data = await (await get('/positions', { 'X-App-Key': env.APP_KEY })).json();
  assert.equal(data.positions.length, 3);
  assert.deepEqual(cityCalls().map((c) => c.body), [{ type: 1 }, { type: '1' }]);
});

test('/positions: odpowiedź, która nie jest listą, to błąd (502), nie pusta lista', async () => {
  mode = 'positions-weird';
  const r = await get('/positions', { 'X-App-Key': env.APP_KEY });
  assert.equal(r.status, 502);
});

test('zawodne API: zawieszone zapytanie ponawiane, odpowiedź przychodzi', async () => {
  mode = 'flaky';
  const r = await get('/positions', { 'X-App-Key': env.APP_KEY });
  assert.equal(r.status, 200);
  assert.equal(cityCalls().length, 2);
});

test('rozkład: udane słupki zapamiętane, kolejna próba dociąga tylko brakujący', async () => {
  mode = 'stop-down';
  const r = await get('/timetable', { 'X-App-Key': env.APP_KEY });
  assert.equal(r.status, 502);
  const okStops = new Set(calls.filter((c) => c.body.busstopId !== '3292').map((c) => c.body.busstopId + c.body.busstopNr));
  assert.equal(okStops.size, 5);
  mode = 'ok';
  calls = [];
  const r2 = await get('/timetable', { 'X-App-Key': env.APP_KEY });
  assert.equal(r2.status, 200);
  assert.deepEqual(calls.map((c) => c.body.busstopId + '/' + c.body.busstopNr), ['3292/04']);
});

test('/positions: najpierw feed mkuran, bez pytania miasta', async () => {
  mode = 'mkuran-ok';
  const r = await get('/positions', { 'X-App-Key': env.APP_KEY });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.source, 'mkuran');
  assert.ok(data.positions.length >= 1);
  assert.equal(cityCalls().length, 0);
});
