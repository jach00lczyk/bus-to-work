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
  mem.positions = null; mem.timetable = null; mem.lastGood = {};
  globalThis.fetch = async (url, init) => {
    const action = String(url).split('/').at(-1);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ action, body, auth: init.headers.Authorization });
    if (mode === 'down') return new Response('{"message":"Service unavailable"}', { status: 500 });
    if (action === 'get_ztm_lokalizacja_pojazdow') return Response.json(readJson('test/fixtures/positions.json'));
    if (action === 'get_ztm_odjazdy_linii_z_przystanku') {
      return Response.json(readJson(`test/fixtures/odjazdy_${body.busstopId}_${body.busstopNr}_185.json`));
    }
    return new Response('{"message":"Service unavailable"}', { status: 500 });
  };
});

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

test('/positions: token surowy, wartości jako stringi, tylko linia 185, cache 10 s', async () => {
  const r = await get('/positions', { 'X-App-Key': env.APP_KEY });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.positions.length, 3);
  assert.deepEqual(Object.keys(data.positions[0]).sort(), ['brigade', 'lat', 'lon', 'time', 'vehicle']);
  assert.equal(calls[0].auth, env.WAW_TOKEN);
  assert.deepEqual(calls[0].body, { type: '1' });
  await get('/positions', { 'X-App-Key': env.APP_KEY });
  assert.equal(calls.length, 1, 'druga odpowiedź z pamięci');
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
  assert.equal(calls.length, 2);
  const body = await r.json();
  assert.equal(body.stale, true);
  assert.deepEqual(body.positions, ok.positions);
  mem.lastGood = {};
  const r2 = await get('/positions', { 'X-App-Key': env.APP_KEY });
  assert.equal(r2.status, 502);
  assert.deepEqual(await r2.json(), { error: 'upstream' });
});
