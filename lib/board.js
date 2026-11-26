// Kursy, stany autobusów, opóźnienia, ukryte i przypięte. Czysta logika bez DOM.

import { serviceSecToMs, apiTimeToMs, hhmm, autoDir, nextDirBoundary, warsawDate, addDays, warsawToMs, MIN } from './time.js';
import { project, distance, typicalAt } from './geo.js';
import { normBrigade } from './timetable.js';

export { normBrigade };

export const DIRS = ['praca', 'dom'];
export const POS_MAX_AGE = 5 * MIN;   // starsza pozycja = BRAK GPS
export const LOOP_RADIUS = 200;       // NA PĘTLI: do 200 m od pętli
export const UPCOMING = 6;            // tyle najbliższych odjazdów
export const GONE_AFTER = 10 * MIN;   // bez pozycji kurs znika 10 min po planowym przyjeździe
const MAX_MATCH = 90 * MIN;           // większa rozbieżność z rozkładem = to nie ten kurs
const MOVE_EPS = 0.02;                // ruch wzdłuż trasy (w indeksach przystanków)
const MOVE_MIN_M = 15;                // mniejsze przesunięcie traktujemy jak postój

// ---------- trasa ----------

/** Geometria kierunków: indeksy pętli, mojego przystanku i celu na liście z route-185.json. */
export function prepareGeo(route, config) {
  const geo = {};
  for (const k of DIRS) {
    const c = config.directions[k];
    const stops = route.directions[k].stops;
    const idx = (s) => stops.findIndex((x) => x.zespol === s.zespol && x.slupek === s.slupek);
    const myIdx = idx(c.myStop), destIdx = idx(c.dest);
    let loopIdx = idx(c.loop);
    if (myIdx < 0 || destIdx < 0 || destIdx <= myIdx) throw new Error(`route-185.json nie pasuje do config.json (${k})`);
    if (loopIdx < 0 || loopIdx > myIdx) loopIdx = 0;
    geo[k] = { key: k, cfg: c, stops, loopIdx, myIdx, destIdx };
  }
  const all = DIRS.flatMap((k) => geo[k].stops);
  for (const k of DIRS) {
    const z = geo[k].cfg.loop.zespol;
    geo[k].loopZone = all.filter((s) => s.zespol === z);
    geo[k].opposite = k === 'praca' ? 'dom' : 'praca';
  }
  return geo;
}

// ---------- rozkład ----------

/** Odpowiedź /timetable (jeden dzień) -> kursy z czasami w ms, posortowane, plus kursy każdej brygady (oba kierunki). */
export function loadTimetable(tt, geo) {
  return loadDays([tt], geo, { serviceDate: tt?.serviceDate ?? null, validUntil: tt?.validUntil ?? null });
}

/** Kilka dni rozkładowych naraz ([{serviceDate, praca, dom}]): kursy po północy i jutro rano w jednej liście. */
export function loadDays(days, geo, meta = {}) {
  const trips = { praca: [], dom: [] };
  const byBrigade = new Map();
  for (const day of days) {
    for (const k of DIRS) {
      const g = geo[k];
      const loopToMy = (g.stops[g.myIdx].t - g.stops[g.loopIdx].t) * 1000;
      for (const c of day?.[k] ?? []) {
        const dep = serviceSecToMs(day.serviceDate, c.dep);
        const arr = serviceSecToMs(day.serviceDate, c.arr);
        const loop = c.loop != null ? serviceSecToMs(day.serviceDate, c.loop) : dep - loopToMy;
        const t = { id: c.id, dir: k, brigade: normBrigade(c.brigade), loop, dep, arr, loopEstimated: c.loop == null };
        trips[k].push(t);
        // Kursy brygady ze wszystkich dni w jednej liście po czasie: ostatni kurs wczoraj poprzedza pierwszy dziś.
        if (!byBrigade.has(t.brigade)) byBrigade.set(t.brigade, []);
        byBrigade.get(t.brigade).push(t);
      }
    }
  }
  for (const k of DIRS) trips[k].sort((a, b) => a.dep - b.dep);
  for (const a of byBrigade.values()) a.sort((x, y) => x.loop - y.loop);
  return { serviceDate: meta.serviceDate ?? null, validUntil: meta.validUntil ?? null, trips, byBrigade };
}

/**
 * Plik data/timetable.json (z GTFS, budowany codziennie na GitHubie) -> rozkład wczoraj + dziś + jutro.
 * null, gdy w pliku nie ma dzisiejszego dnia (np. przestarzały plik) – wtedy rozkład z Workera.
 */
export function loadGtfsFile(file, geo, now) {
  const today = warsawDate(now);
  if (!file?.days?.[today]) return null;
  const dates = [addDays(today, -1), today, addDays(today, 1)].filter((d) => file.days[d]);
  const [y, m, d] = today.split('-').map(Number);
  return loadDays(dates.map((date) => ({ serviceDate: date, ...file.days[date] })), geo, {
    serviceDate: today,
    validUntil: warsawToMs(y, m, d + 1, 0, 1) // po północy wybieramy dni od nowa
  });
}

const lerp = (a, b, f) => a + (b - a) * f;

/** Planowy czas kursu w ciągłym punkcie trasy: interpolacja między pętlą, moim przystankiem i celem wg typowych czasów. */
export function plannedAt(trip, progress, g) {
  const s = g.stops;
  const t = typicalAt(s, progress);
  const tL = s[g.loopIdx].t, tM = s[g.myIdx].t, tD = s[g.destIdx].t;
  if (t <= tL) return trip.loop - (tL - t) * 1000;
  if (t <= tM) return tM > tL ? lerp(trip.loop, trip.dep, (t - tL) / (tM - tL)) : trip.dep;
  if (t <= tD) return lerp(trip.dep, trip.arr, (t - tM) / (tD - tM));
  return trip.arr + (t - tD) * 1000;
}

// ---------- pozycje ----------

/**
 * Aktualizuje ślady brygad nowymi pozycjami: {brigade -> {cur, prev}}.
 * `prev` to ostatnia pozycja oddalona o co najmniej 15 m, żeby postój nie kasował kierunku jazdy.
 */
export function updateTracks(tracks, positions) {
  const next = new Map(tracks);
  const newest = new Map();
  for (const p of positions ?? []) {
    const b = normBrigade(p.brigade);
    const time = typeof p.time === 'number' ? p.time : apiTimeToMs(p.time);
    const lat = Number(p.lat), lon = Number(p.lon);
    if (!b || !Number.isFinite(time) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const cur = newest.get(b);
    if (!cur || time > cur.time) newest.set(b, { lat, lon, time, vehicle: p.vehicle ?? null });
  }
  for (const [b, p] of newest) {
    const old = next.get(b);
    if (!old) next.set(b, { cur: p, prev: null });
    else if (p.time > old.cur.time) {
      const moved = distance(old.cur.lat, old.cur.lon, p.lat, p.lon) >= MOVE_MIN_M;
      next.set(b, { cur: p, prev: moved ? old.cur : old.prev });
    }
  }
  return next;
}

/** Najnowszy `Time` (ms) wśród pozycji odpowiedzi; null, gdy brak. */
export function newestTime(positions) {
  let best = null;
  for (const p of positions ?? []) {
    const t = typeof p.time === 'number' ? p.time : apiTimeToMs(p.time);
    if (Number.isFinite(t) && (best == null || t > best)) best = t;
  }
  return best;
}

/** Który kurs brygada jedzie teraz: rzut pozycji na trasę każdego kursu i porównanie z rozkładem. */
export function activeTrip(track, brigadeTrips, geo, now) {
  if (!track) return null;
  const { cur, prev } = track;
  let best = null;
  const projCache = {};
  for (const tr of brigadeTrips ?? []) {
    const g = geo[tr.dir];
    const pr = (projCache[tr.dir] ??= project(g.stops, cur.lat, cur.lon));
    if (!pr) continue;
    let moving = 0;
    if (prev && now - prev.time < 10 * MIN) {
      const pp = project(g.stops, prev.lat, prev.lon, pr.progress);
      if (pp) moving = pr.progress - pp.progress > MOVE_EPS ? 1 : pr.progress - pp.progress < -MOVE_EPS ? -1 : 0;
    }
    if (moving < 0) continue; // jedzie w drugą stronę
    const diff = now - plannedAt(tr, pr.progress, g);
    const score = diff >= 0 ? diff : -diff * 1.5; // wolimy spóźnienie niż jazdę przed czasem
    if (score > MAX_MATCH) continue;
    if (!best || score < best.score) best = { trip: tr, proj: pr, score, moving };
  }
  return best;
}

// ---------- stan kursu ----------

const delayMin = (ms) => Math.max(0, Math.round(ms / MIN)); // przed czasem = „o czasie”

/**
 * Stan jednego kursu. Zwraca kafel:
 * state: 'jedzie' | 'petla' | 'dojazd' | 'trasa' | 'brak' | 'wczesniej' | 'done'
 * phase: 'before' (przed moim przystankiem) | 'after' (między moim przystankiem a celem)
 */
export function courseTile(C, ctx) {
  const { geo, tracks, tt, now } = ctx;
  const g = geo[C.dir];
  const base = { id: C.id, dir: C.dir, brigade: C.brigade, planDep: C.dep, planArr: C.arr, planLoop: C.loop };
  const track = tracks?.get(C.brigade);
  const fresh = track && now - track.cur.time <= POS_MAX_AGE;

  const schedule = (state, extra = {}) => {
    const phase = now >= C.dep && state === 'brak' ? 'after' : 'before';
    const gone = now > C.arr + GONE_AFTER;
    return { ...base, state, phase, gone, delay: null, progDep: C.dep, progArr: C.arr, ...extra };
  };
  if (!fresh) return schedule('brak');

  const bt = tt.byBrigade.get(C.brigade) ?? [C];
  const ci = bt.indexOf(C);
  const act = (ctx.actCache ??= new Map()).has(C.brigade)
    ? ctx.actCache.get(C.brigade)
    : ctx.actCache.set(C.brigade, activeTrip(track, bt, geo, now)).get(C.brigade);
  const ai = act ? bt.indexOf(act.trip) : -1;

  const nearLoop = g.loopZone.some((s) => distance(s.lat, s.lon, track.cur.lat, track.cur.lon) <= LOOP_RADIUS);
  const firstOpen = bt.find((t) => t.arr > now) === C;
  if (nearLoop && ((ai === ci && act.proj.progress <= g.loopIdx + 0.5) || (ai >= 0 && ai === ci - 1) || (ai < 0 && firstOpen))) {
    const delay = now > C.loop ? delayMin(now - C.loop) : 0;
    return {
      ...base, state: 'petla', phase: 'before', gone: false, delay,
      progDep: C.dep + delay * MIN, progArr: C.arr + delay * MIN,
      stopsToMe: g.myIdx - g.loopIdx
    };
  }
  if (ai < 0) return schedule('brak');

  if (ai === ci) {
    const p = act.proj;
    if (p.lastPassed >= g.destIdx) return { ...base, state: 'done', phase: 'after', gone: true };
    const delay = delayMin(now - plannedAt(C, p.progress, g));
    const at = g.stops[p.lastPassed]?.name ?? '';
    const common = { ...base, gone: false, delay, progDep: C.dep + delay * MIN, progArr: C.arr + delay * MIN, at, lastPassed: p.lastPassed };
    if (p.lastPassed < g.myIdx) return { ...common, state: 'jedzie', phase: 'before', stopsToMe: g.myIdx - p.lastPassed };
    const total = g.destIdx - g.myIdx;
    const passed = p.lastPassed - g.myIdx;
    return { ...common, state: 'trasa', phase: 'after', stopsToDest: g.destIdx - p.lastPassed, passed, total, ring: passed / total, gone: now > C.arr + 60 * MIN };
  }
  if (ai === ci - 1) {
    // Brygada kończy poprzedni kurs w przeciwnym kierunku, który kończy się na naszej pętli.
    const T = act.trip, gT = geo[T.dir];
    const lateT = Math.max(0, now - plannedAt(T, act.proj.progress, gT));
    const eta = Math.max(now, plannedAt(T, gT.stops.length - 1, gT) + lateT);
    return schedule('dojazd', { loopEta: eta });
  }
  if (ai < ci) return schedule('wczesniej');
  // Brygada jest już na późniejszym kursie: ten się skończył.
  if (now > C.arr - 20 * MIN) return { ...base, state: 'done', phase: 'after', gone: true };
  return schedule('brak');
}

// ---------- lista kierunku ----------

/**
 * Lista jednego kierunku: autobusy w trasie + 6 najbliższych odjazdów, chronologicznie.
 * Ukryte: bez przypięcia – te w trasie; z przypięciem – wszystko przed przypiętym.
 */
export function buildPanel(dir, ctx, pinId) {
  const { tt, now } = ctx;
  const all = (tt?.trips?.[dir] ?? []).filter((C) => C.arr + 70 * MIN > now && C.dep < now + 8 * 3600 * 1000);
  const tiles = all.map((C) => courseTile(C, ctx)).filter((t) => !t.gone);
  const after = tiles.filter((t) => t.phase === 'after');
  const before = tiles.filter((t) => t.phase === 'before').slice(0, UPCOMING);
  const items = [...after, ...before];
  const pinIdx = pinId ? items.findIndex((t) => t.id === pinId) : -1;
  return { items, hiddenCount: pinIdx >= 0 ? pinIdx : after.length, pinId: pinIdx >= 0 ? pinId : null };
}

/** Oba kierunki naraz, żeby przełączanie było natychmiastowe. */
export function buildBoard({ geo, tt, tracks, now, pins }) {
  const ctx = { geo, tt, tracks, now, actCache: new Map() };
  const out = {};
  for (const d of DIRS) out[d] = buildPanel(d, ctx, pins?.[d] ?? null);
  return out;
}

/**
 * Odpina kursy, które zniknęły z listy (dojazd do celu, koniec dnia rozkładowego – id zawiera datę dnia).
 * Wywoływać tylko z wczytanym rozkładem.
 */
export function reconcilePins(pins, board) {
  const out = { praca: pins?.praca ?? null, dom: pins?.dom ?? null };
  for (const d of DIRS) if (out[d] && board[d].pinId !== out[d]) out[d] = null;
  return out;
}

/** Kliknięcie pinezki: jeden przypięty na kierunek, ponowne kliknięcie odpina. */
export function togglePin(pins, dir, id) {
  return { ...pins, [dir]: pins?.[dir] === id ? null : id };
}

// ---------- kierunek ----------

/** Kierunek: ręczny wybór do najbliższej granicy (12:00 albo północ), potem automat. */
export function effectiveDir(stored, now) {
  if (stored && DIRS.includes(stored.dir) && Number(stored.until) > now) return stored.dir;
  return autoDir(now);
}

export function manualDir(dir, now) {
  return { dir, until: nextDirBoundary(now) };
}

// ---------- widok kafla (teksty i kolory) ----------

export const COLORS = {
  red: '#FF453A', yellow: '#FFD60A', white: '#FFFFFF', green: '#30D158', gray: '#8E8E93'
};

const st = (n) => `${n} przyst.`;

/** Teksty kafla zgodnie z kanwą. `gpsKnown` = przyszła już choć jedna odpowiedź z pozycjami. */
export function tileView(t, g, now, gpsKnown = true) {
  const after = t.phase === 'after';
  const minutes = Math.max(0, Math.floor(((after ? t.progArr : t.progDep) - now) / MIN));
  let stateText = 'o czasie', stateColor = COLORS.green, stateBold = false;
  if (t.delay == null) { stateText = 'wg rozkładu'; stateColor = COLORS.gray; }
  else if (t.delay >= 1) { stateText = `+${t.delay} min`; stateColor = COLORS.red; stateBold = true; }
  let flag = null, place = '';
  switch (t.state) {
    case 'jedzie': place = `${st(t.stopsToMe)} do Ciebie · teraz ${t.at}`; break;
    case 'trasa': place = `${st(t.stopsToDest)} do ${g.cfg.destName} · teraz ${t.at}`; break;
    case 'petla': flag = 'petla'; place = `${st(t.stopsToMe)} do Ciebie · rusza ${hhmm(t.planLoop)}`; break;
    case 'dojazd': flag = 'dojazd'; place = `na pętli ok. ${hhmm(t.loopEta)}`; break;
    case 'wczesniej': place = 'kończy wcześniejszy kurs'; break;
    default: flag = gpsKnown ? 'brak' : null; place = gpsKnown ? 'pozycja nieznana' : '';
  }
  let minColor = COLORS.white;
  if (!after && minutes <= 10) minColor = COLORS.yellow;
  if (!after && minutes <= 2) minColor = COLORS.red;
  return {
    dep: hhmm(t.progDep), arr: hhmm(t.progArr),
    oldTimes: t.delay >= 1 ? `${hhmm(t.planDep)} → ${hhmm(t.planArr)}` : null,
    arrivalFirst: after,
    minutes, minCaption: after ? 'przyjazd za' : 'odjazd za', minColor,
    stateText, stateColor, stateBold,
    flag, place,
    ring: t.state === 'trasa' ? { value: t.ring, passed: t.passed, total: t.total } : null
  };
}
