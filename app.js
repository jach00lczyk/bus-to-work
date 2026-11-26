// UI, odpytywanie i stan. Cała logika kursów jest w lib/ (bez DOM).

import {
  DIRS, prepareGeo, loadTimetable, updateTracks, newestTime, buildBoard, reconcilePins,
  togglePin, effectiveDir, manualDir, tileView
} from './lib/board.js';
import { hhmm, MIN } from './lib/time.js';

const POLL_MS = 15_000;
const STALE_WARN_MS = 2 * MIN;
const KEYS = { dir: 'bus185.dir', pins: 'bus185.pins', appKey: 'bus185.appKey', tt: 'bus185.tt' };

// ---------- localStorage (Safari potrafi wyczyścić dane nieużywanej strony) ----------

const store = {
  get(k) { try { const v = localStorage.getItem(k); return v == null ? null : JSON.parse(v); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};

// ---------- stan ----------

const S = {
  config: null, geo: null, proxy: null,
  appKey: store.get(KEYS.appKey),
  tt: null,
  tracks: new Map(),
  gpsKnown: false,
  newest: null,            // najnowszy Time (ms) z pozycji
  lastNewAt: Date.now(),   // kiedy ostatnio przyszły nowsze pozycje
  dirStored: store.get(KEYS.dir),
  pins: { praca: null, dom: null, ...(store.get(KEYS.pins) ?? {}) },
  expanded: { praca: false, dom: false },
  spins: 0,
  locked: false,
  pollTimer: null,
  inflight: { positions: false, timetable: false },
  error: null              // ostatni błąd do pokazania w stopce (diagnostyka na telefonie)
};

const $ = (id) => document.getElementById(id);
const app = $('app');

// ---------- sieć ----------

async function api(path) {
  if (!S.appKey) { lock(); return null; }
  let res;
  try {
    res = await fetch(S.proxy + path, { headers: { 'X-App-Key': S.appKey }, cache: 'no-store' });
  } catch (e) {
    S.error = `Brak połączenia z proxy (${e?.message ?? e})`;
    return null;
  }
  if (res.status === 401) { S.error = 'Zły klucz aplikacji'; lock(); return null; }
  if (!res.ok && res.status !== 502) { S.error = `Proxy: HTTP ${res.status}`; return null; }
  try {
    const data = await res.json();
    if (res.status === 502) S.error = 'API miasta nie odpowiada';
    if (data && !data.error) { if (res.ok) S.error = null; return data; } // 502 z ostatnią dobrą odpowiedzią też się liczy
    return null;
  } catch {
    S.error = `Proxy: zła odpowiedź (HTTP ${res.status})`;
    return null;
  }
}

async function fetchPositions() {
  if (S.inflight.positions) return;
  S.inflight.positions = true;
  try {
    const data = await api('/positions');
    if (!data) return;
    S.gpsKnown = true;
    S.tracks = updateTracks(S.tracks, data.positions);
    const n = newestTime(data.positions);
    if (n != null && (S.newest == null || n > S.newest)) { S.newest = n; S.lastNewAt = Date.now(); }
  } finally {
    S.inflight.positions = false;
    render();
  }
}

async function fetchTimetable() {
  if (S.inflight.timetable) return;
  S.inflight.timetable = true;
  try {
    const data = await api('/timetable');
    if (data && Array.isArray(data.praca)) {
      S.tt = loadTimetable(data, S.geo);
      store.set(KEYS.tt, data); // rozkład dnia na wypadek zawodnego API przy następnym otwarciu
    }
  } finally {
    S.inflight.timetable = false;
    render();
  }
}

function needTimetable() {
  return !S.tt || (S.tt.validUntil && Date.now() >= S.tt.validUntil);
}

function poll() {
  if (S.locked) return;
  if (needTimetable()) fetchTimetable();
  fetchPositions();
}

function startPolling() {
  stopPolling();
  poll();
  S.pollTimer = setInterval(poll, POLL_MS);
}

function stopPolling() {
  if (S.pollTimer) clearInterval(S.pollTimer);
  S.pollTimer = null;
}

// ---------- klucz aplikacji ----------

function lock() {
  if (S.locked) return;
  S.locked = true;
  stopPolling();
  app.classList.add('locked');
  $('keyform').hidden = false;
  $('appkey').value = '';
}

$('keyform').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('appkey').value.trim();
  if (!v) return;
  S.appKey = v;
  store.set(KEYS.appKey, v);
  S.locked = false;
  app.classList.remove('locked');
  $('keyform').hidden = true;
  $('appkey').blur();
  if (!document.hidden) startPolling();
});

// ---------- DOM: panele i kafle ----------

const panels = {};
const tplPanel = $('tpl-panel');
const tplTile = $('tpl-tile');

function makePanel(dir) {
  const el = tplPanel.content.firstElementChild.cloneNode(true);
  el.dataset.dir = dir;
  el.setAttribute('aria-label', S.config.directions[dir].title);
  const p = {
    el,
    groupWrap: el.querySelector('.group-wrap'),
    box: el.querySelector('.box'),
    head: el.querySelector('.box-head'),
    title: el.querySelector('.box-title'),
    innerWrap: el.querySelector('.inner-wrap'),
    lists: { inner: el.querySelector('.inner-list'), outer: el.querySelector('.outer-list') },
    tiles: { inner: new Map(), outer: new Map() }
  };
  p.head.addEventListener('click', () => {
    S.expanded[dir] = !S.expanded[dir];
    render();
  });
  $('panels').append(el);
  panels[dir] = p;
}

function makeTile(dir, id) {
  const el = tplTile.content.firstElementChild.cloneNode(true);
  const q = (s) => el.querySelector(s);
  const t = {
    el, card: q('.card'), ring: q('.ring'), ringVal: q('.ring-val'), dep: q('.t-dep'), arr: q('.t-arr'),
    cap: q('.mins-cap'), num: q('.mins-num'), old: q('.old'), state: q('.state'), chip: q('.chip'),
    place: q('.place'), pin: q('.pin'), last: {}
  };
  t.pin.addEventListener('click', () => {
    S.pins = togglePin(S.pins, dir, id);
    store.set(KEYS.pins, S.pins);
    S.expanded[dir] = false; // zmiana przypięcia zwija kontener
    render();
  });
  return t;
}

/** Ustawia tylko to, co się zmieniło (żeby nie przerywać animacji). */
function set(t, key, value, apply) {
  if (t.last[key] === value) return;
  t.last[key] = value;
  apply(value);
}

const FLAG_TEXT = { petla: 'NA PĘTLI', dojazd: 'DOJEŻDŻA DO PĘTLI', brak: 'BRAK GPS' };

function fillTile(t, item, v, pinned) {
  set(t, 'dep', v.dep, (x) => { t.dep.textContent = x; });
  set(t, 'arr', v.arr, (x) => { t.arr.textContent = x; });
  set(t, 'first', v.arrivalFirst, (x) => {
    t.dep.className = 't-dep ' + (x ? 'small' : 'big');
    t.arr.className = 't-arr ' + (x ? 'big' : 'small');
  });
  set(t, 'cap', v.minCaption, (x) => { t.cap.textContent = x; });
  set(t, 'num', v.minutes, (x) => { t.num.textContent = x + '′'; });
  set(t, 'minColor', v.minColor, (x) => { t.num.style.color = x; });
  set(t, 'old', v.oldTimes ?? '', (x) => { t.old.textContent = x; });
  set(t, 'state', v.stateText, (x) => { t.state.textContent = x; });
  set(t, 'stateColor', v.stateColor, (x) => { t.state.style.color = x; });
  set(t, 'stateBold', v.stateBold, (x) => { t.state.classList.toggle('bold', x); });
  set(t, 'flag', v.flag ?? '', (x) => { t.chip.textContent = FLAG_TEXT[x] ?? ''; t.chip.className = 'chip ' + x; });
  set(t, 'place', v.place, (x) => { t.place.textContent = x; t.place.title = x; });
  set(t, 'ring', v.ring ? Math.round(v.ring.value * 100) : -1, (x) => {
    t.card.classList.toggle('has-ring', x >= 0);
    if (x >= 0) {
      t.ringVal.setAttribute('stroke-dasharray', `${x} 100`);
      t.ring.setAttribute('aria-label', `przejechane ${v.ring.passed} z ${v.ring.total} przystanków`);
    }
  });
  set(t, 'pinned', pinned, (x) => {
    t.card.classList.toggle('pinned', x);
    t.pin.setAttribute('aria-pressed', String(x));
  });
  set(t, 'pinLabel', (pinned ? 'Odepnij ' : 'Przypnij ') + hhmm(item.planDep), (x) => { t.pin.setAttribute('aria-label', x); });
}

let firstPaint = true;

/** Synchronizuje listę (wewnątrz kontenera albo pod nim) z kursami; `visible(i)` mówi, gdzie kafel ma być widoczny. */
function syncList(dir, which, items, views, pinId, visible) {
  const p = panels[dir];
  const list = p.lists[which];
  const map = p.tiles[which];
  const ids = new Set(items.map((x) => x.id));

  for (const [id, t] of map) {
    if (ids.has(id) || t.leaving) continue;
    t.leaving = true;
    t.el.classList.remove('show');
    setTimeout(() => { t.el.remove(); map.delete(id); }, firstPaint ? 0 : 460);
  }

  let prev = null;
  items.forEach((item, i) => {
    let t = map.get(item.id);
    const isNew = !t || t.leaving;
    if (isNew) {
      if (t) t.el.remove();
      t = makeTile(dir, item.id);
      map.set(item.id, t);
    }
    const ref = prev ? prev.el.nextElementSibling : list.firstElementChild;
    if (ref !== t.el) list.insertBefore(t.el, ref);
    fillTile(t, item, views[i], item.id === pinId);
    const show = visible(i);
    if (isNew && show && !firstPaint) {
      // pojawia się z animacją
      t.el.getBoundingClientRect();
      requestAnimationFrame(() => t.el.classList.toggle('show', visible(i)));
    } else t.el.classList.toggle('show', show);
    prev = t;
  });
}

// ---------- rysowanie ----------

function render() {
  if (!S.geo) return;
  const now = Date.now();
  const dir = effectiveDir(S.dirStored, now);

  // nagłówek
  const c = S.config.directions[dir];
  if ($('route').textContent !== c.title) $('route').textContent = c.title;
  const age = S.newest == null ? null : Math.max(0, Math.floor((now - S.newest) / 1000));
  const ageText = age == null ? '–′––″' : `${Math.floor(age / 60)}′${String(age % 60).padStart(2, '0')}″`;
  if ($('age').textContent !== ageText) $('age').textContent = ageText;
  $('refresh').setAttribute('aria-label', age == null ? 'Odśwież dane' : `Odśwież dane, ostatnie sprzed ${Math.floor(age / 60)} min ${age % 60} s`);
  $('stale').hidden = S.locked || now - S.lastNewAt < STALE_WARN_MS;
  showError((S.error && (now - S.lastNewAt >= 20_000 || !S.gpsKnown)) ? S.error : null);

  // przełącznik
  const seg = $('seg');
  if (seg.dataset.dir !== dir) {
    seg.dataset.dir = dir;
    for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.dir === dir));
  }

  if (!S.tt) {
    for (const d of DIRS) { panels[d].el.classList.toggle('active', d === dir); }
    return;
  }

  let board = buildBoard({ geo: S.geo, tt: S.tt, tracks: S.tracks, now, pins: S.pins });
  const pins = reconcilePins(S.pins, board, S.tt.serviceDate);
  if (pins.praca !== S.pins.praca || pins.dom !== S.pins.dom) {
    S.pins = pins;
    store.set(KEYS.pins, pins);
    board = buildBoard({ geo: S.geo, tt: S.tt, tracks: S.tracks, now, pins });
  }

  for (const d of DIRS) {
    const p = panels[d];
    const b = board[d];
    const active = d === dir;
    p.el.classList.toggle('active', active);
    p.el.setAttribute('aria-hidden', String(!active));
    p.el.inert = !active;

    const g = S.geo[d];
    const views = b.items.map((it) => tileView(it, g, now, S.gpsKnown));
    const hidden = b.hiddenCount;
    p.groupWrap.classList.toggle('show', hidden > 0);
    const open = S.expanded[d] && hidden > 0;
    p.innerWrap.classList.toggle('show', open);
    p.box.classList.toggle('open', open);
    p.head.setAttribute('aria-expanded', String(open));
    if (hidden > 0) {
      const title = `Ukryte wcześniejsze · ${hidden}`;
      if (p.title.textContent !== title) p.title.textContent = title;
    }
    syncList(d, 'inner', b.items, views, b.pinId, (i) => i < hidden);
    syncList(d, 'outer', b.items, views, b.pinId, (i) => i >= hidden);
  }

  if (firstPaint) {
    firstPaint = false;
    requestAnimationFrame(() => requestAnimationFrame(() => app.classList.remove('noanim')));
  }
}

// ---------- zdarzenia ----------

$('seg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-dir]');
  if (!b) return;
  S.dirStored = manualDir(b.dataset.dir, Date.now());
  store.set(KEYS.dir, S.dirStored);
  render();
});

$('refresh').addEventListener('click', () => {
  S.spins += 1;
  $('spin').style.transform = `rotate(${S.spins * 360}deg)`;
  if (S.locked) return;
  if (needTimetable()) fetchTimetable();
  fetchPositions();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPolling();
  else if (!S.locked) startPolling(); // po powrocie od razu jedno zapytanie
});
window.addEventListener('pageshow', (e) => { if (e.persisted && !document.hidden && !S.locked) startPolling(); });

// ---------- diagnostyka i zmiana klucza ----------

function showError(text) {
  const el = $('diag');
  const t = text ?? '';
  if (el.textContent !== t) el.textContent = t;
  el.hidden = !t;
}

window.addEventListener('error', (e) => showError('Błąd: ' + (e.message || e.error)));
window.addEventListener('unhandledrejection', (e) => showError('Błąd: ' + (e.reason?.message ?? e.reason)));

/** Adres z #klucz pokazuje formularz klucza (np. po zmianie APP_KEY w Workerze). */
function keyFromHash() {
  if (location.hash !== '#klucz') return;
  history.replaceState(null, '', location.pathname + location.search);
  S.locked = false;
  lock();
}
window.addEventListener('hashchange', keyFromHash);

// Safari na iOS ignoruje user-scalable=no; gesty szczypania blokujemy wprost.
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}

// ---------- start ----------

async function boot() {
  const [config, route] = await Promise.all([
    fetch('data/config.json').then((r) => r.json()),
    fetch('data/route-185.json').then((r) => r.json())
  ]);
  S.config = config;
  S.geo = prepareGeo(route, config);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  S.proxy = (local ? location.origin + '/mock' : config.proxyUrl).replace(/\/$/, '');
  for (const d of DIRS) makePanel(d);
  const saved = store.get(KEYS.tt);
  if (saved && Array.isArray(saved.praca) && Date.now() < Number(saved.validUntil)) {
    try { S.tt = loadTimetable(saved, S.geo); } catch { store.set(KEYS.tt, null); }
  }
  if (location.hash === '#klucz') keyFromHash();
  if (!S.appKey) lock(); // formularz przed pierwszym rysowaniem, żeby błąd w render() go nie zablokował
  render();
  setInterval(render, 1000);
  if (!S.locked && !document.hidden) startPolling();
}

boot().catch((e) => showError('Błąd startu: ' + (e?.message ?? e)));
