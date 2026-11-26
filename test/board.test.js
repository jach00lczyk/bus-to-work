import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  updateTracks, courseTile, buildBoard, reconcilePins, togglePin, effectiveDir, manualDir,
  tileView, newestTime, activeTrip, UPCOMING
} from '../lib/board.js';
import { parsePositions } from '../lib/timetable.js';
import { MIN, warsawToMs } from '../lib/time.js';
import { geo, tt, at, pos, pickCourse, plannedAt, readJson } from './helpers.js';

const ctxFor = (positionsSets, now) => {
  let tracks = new Map();
  for (const ps of positionsSets) tracks = updateTracks(tracks, ps);
  return { geo, tt, tracks, now, actCache: new Map() };
};

/** Autobus brygady C jedzie kursem trip po trasie: dwie pozycje (ruch do przodu), ostatnia `lateMin` po rozkładzie. */
function driving(trip, progress, lateMin = 0) {
  const g = geo[trip.dir];
  const now = plannedAt(trip, progress, g) + lateMin * MIN;
  const p1 = pos(trip.brigade, trip.dir, progress - 0.4, now - 30_000);
  const p2 = pos(trip.brigade, trip.dir, progress, now - 5_000);
  return { now, sets: [[p1], [p2]] };
}

test('JEDZIE DO MNIE: przystanki do mnie, bieżący przystanek, opóźnienie', () => {
  const { C } = pickCourse('praca', 8);
  const g = geo.praca;
  const { now, sets } = driving(C, g.myIdx - 2.5, 3);
  const t = courseTile(C, ctxFor(sets, now));
  assert.equal(t.state, 'jedzie');
  assert.equal(t.phase, 'before');
  assert.equal(t.stopsToMe, 3);
  assert.equal(t.at, g.stops[g.myIdx - 3].name);
  assert.equal(t.delay, 3);
  assert.equal(t.progDep, C.dep + 3 * MIN);
  const v = tileView(t, g, now);
  assert.equal(v.stateText, '+3 min');
  assert.ok(v.oldTimes.includes('→'));
  assert.equal(v.place, `3 przyst. do Ciebie · teraz ${g.stops[g.myIdx - 3].name}`);
  assert.equal(v.minCaption, 'odjazd za');
  assert.equal(v.arrivalFirst, false);
});

test('o czasie i przed czasem: „o czasie”', () => {
  const { C } = pickCourse('praca', 9);
  for (const late of [0, -2]) {
    const { now, sets } = driving(C, geo.praca.myIdx - 3.5, late);
    const t = courseTile(C, ctxFor(sets, now));
    assert.equal(t.state, 'jedzie');
    assert.equal(t.delay, 0);
    assert.equal(tileView(t, geo.praca, now).stateText, 'o czasie');
    assert.equal(tileView(t, geo.praca, now).oldTimes, null);
  }
});

test('NA PĘTLI: stoi na pętli przed odjazdem, potem opóźnienie rośnie', () => {
  const { C } = pickCourse('praca', 10);
  const g = geo.praca;
  const p = pos(C.brigade, 'praca', g.loopIdx, 0);
  for (const [offset, delay] of [[-4, 0], [3, 3]]) {
    const now = C.loop + offset * MIN;
    const t = courseTile(C, ctxFor([[{ ...p, time: now - 10_000 }]], now));
    assert.equal(t.state, 'petla', `offset ${offset}`);
    assert.equal(t.delay, delay);
    assert.equal(t.stopsToMe, g.myIdx - g.loopIdx);
    const v = tileView(t, g, now);
    assert.equal(v.flag, 'petla');
    assert.match(v.place, /^\d+ przyst\. do Ciebie · rusza \d+:\d\d$/);
  }
});

test('NA PĘTLI: brygada właśnie dojechała poprzednim kursem na pętlę', () => {
  const { C, prev } = pickCourse('dom', 13);
  const gp = geo[prev.dir];
  const { sets } = driving(prev, gp.stops.length - 1.2, 0);
  const now = Math.min(C.loop - 2 * MIN, plannedAt(prev, gp.stops.length - 1, gp) + MIN);
  const t = courseTile(C, ctxFor(sets.map((s) => s.map((x) => ({ ...x, time: x.time - (x.time - now) - 1000 }))), now));
  assert.equal(t.state, 'petla');
});

test('DOJEŻDŻA DO PĘTLI: brygada jedzie jeszcze poprzedni kurs w drugą stronę', () => {
  const { C, prev } = pickCourse('praca', 11);
  const gp = geo[prev.dir];
  const { now, sets } = driving(prev, 30.5, 2);
  const t = courseTile(C, ctxFor(sets, now));
  assert.equal(t.state, 'dojazd');
  assert.equal(t.delay, null);
  const eta = plannedAt(prev, gp.stops.length - 1, gp) + 2 * MIN;
  assert.ok(Math.abs(t.loopEta - eta) < MIN, 'ETA na pętli');
  const v = tileView(t, geo.praca, now);
  assert.equal(v.flag, 'dojazd');
  assert.equal(v.stateText, 'wg rozkładu');
  assert.match(v.place, /^na pętli ok\. \d+:\d\d$/);
});

test('W TRASIE: minął mój przystanek, kółko postępu, przyjazd za', () => {
  const { C } = pickCourse('praca', 8);
  const g = geo.praca;
  const { now, sets } = driving(C, g.myIdx + 5.5, 1);
  const t = courseTile(C, ctxFor(sets, now));
  assert.equal(t.state, 'trasa');
  assert.equal(t.phase, 'after');
  assert.equal(t.stopsToDest, g.destIdx - (g.myIdx + 5));
  assert.equal(t.passed, 5);
  assert.equal(t.total, g.destIdx - g.myIdx);
  assert.equal(t.delay, 1);
  const v = tileView(t, g, now);
  assert.equal(v.arrivalFirst, true);
  assert.equal(v.minCaption, 'przyjazd za');
  assert.equal(v.minColor, '#FFFFFF');
  assert.ok(v.ring && v.ring.value > 0 && v.ring.value < 1);
  assert.equal(v.place, `${t.stopsToDest} przyst. do Sielc · teraz ${g.stops[g.myIdx + 5].name}`);
});

test('BRAK GPS: brak pozycji albo starsza niż 5 min', () => {
  const { C } = pickCourse('praca', 8);
  const now = C.dep - 20 * MIN;
  const none = courseTile(C, ctxFor([], now));
  assert.equal(none.state, 'brak');
  assert.equal(none.delay, null);
  const old = courseTile(C, ctxFor([[pos(C.brigade, 'praca', 3, now - 6 * MIN)]], now));
  assert.equal(old.state, 'brak');
  const v = tileView(old, geo.praca, now);
  assert.equal(v.flag, 'brak');
  assert.equal(v.place, 'pozycja nieznana');
  assert.equal(v.stateText, 'wg rozkładu');
  // przed pierwszą odpowiedzią z pozycjami bez etykiety
  assert.equal(tileView(old, geo.praca, now, false).flag, null);
});

test('kurs znika po dojechaniu do celu albo 10 min po przyjeździe bez pozycji', () => {
  const { C } = pickCourse('praca', 8);
  const g = geo.praca;
  const { now, sets } = driving(C, g.destIdx + 1.5, 0);
  assert.equal(courseTile(C, ctxFor(sets, now)).gone, true);
  assert.equal(courseTile(C, ctxFor([], C.arr + 9 * MIN)).gone, false);
  assert.equal(courseTile(C, ctxFor([], C.arr + 11 * MIN)).gone, true);
});

test('bez GPS po planowym odjeździe kurs liczy się jako w trasie', () => {
  const { C } = pickCourse('praca', 8);
  const t = courseTile(C, ctxFor([], C.dep + 2 * MIN));
  assert.equal(t.phase, 'after');
});

test('kolor minut do odjazdu', () => {
  const { C } = pickCourse('praca', 8);
  const t = courseTile(C, ctxFor([], C.dep - 30 * MIN));
  assert.equal(tileView(t, geo.praca, C.dep - 30 * MIN).minColor, '#FFFFFF');
  assert.equal(tileView(t, geo.praca, C.dep - 10 * MIN).minColor, '#FFD60A');
  assert.equal(tileView(t, geo.praca, C.dep - 2 * MIN - 30_000).minColor, '#FF453A');
  assert.equal(tileView(t, geo.praca, C.dep - 10 * MIN - 59_000).minutes, 10);
  assert.equal(tileView(t, geo.praca, C.dep + 5 * MIN).minutes, 0);
});

test('lista: w trasie + 6 najbliższych, ukryte bez przypięcia = w trasie', () => {
  const now = at(8, 0);
  const b = buildBoard({ geo, tt, tracks: new Map(), now, pins: {} });
  for (const d of ['praca', 'dom']) {
    const before = b[d].items.filter((t) => t.phase === 'before');
    const after = b[d].items.filter((t) => t.phase === 'after');
    assert.equal(before.length, UPCOMING);
    assert.ok(after.length >= 1, `${d}: autobusy w trasie wg rozkładu`);
    assert.equal(b[d].hiddenCount, after.length);
    const deps = b[d].items.map((t) => t.planDep);
    assert.deepEqual(deps, [...deps].sort((x, y) => x - y), 'chronologicznie');
  }
});

test('przypięcie: ukryte wszystko przed przypiętym, osobno dla kierunków', () => {
  const now = at(8, 0);
  const b0 = buildBoard({ geo, tt, tracks: new Map(), now, pins: {} });
  const target = b0.praca.items.at(-2);
  let pins = togglePin({ praca: null, dom: null }, 'praca', target.id);
  const b = buildBoard({ geo, tt, tracks: new Map(), now, pins });
  assert.equal(b.praca.pinId, target.id);
  assert.equal(b.praca.hiddenCount, b.praca.items.length - 2);
  assert.equal(b.dom.pinId, null);
  pins = togglePin(pins, 'dom', b.dom.items.at(-1).id);
  assert.ok(pins.praca && pins.dom);
  assert.equal(togglePin(pins, 'praca', target.id).praca, null, 'ponowne kliknięcie odpina');
});

test('przypięty zostaje w trasie, odpina się po dojechaniu i po zmianie dnia', () => {
  const { C } = pickCourse('praca', 8);
  const g = geo.praca;
  const pins = { praca: C.id, dom: null };
  // w trasie
  const { now, sets } = driving(C, g.myIdx + 3.5, 0);
  const ctx = ctxFor(sets, now);
  const b = buildBoard({ geo, tt, tracks: ctx.tracks, now, pins });
  assert.equal(b.praca.pinId, C.id);
  assert.equal(b.praca.items[b.praca.hiddenCount].state, 'trasa');
  assert.deepEqual(reconcilePins(pins, b), pins);
  // dojechał
  const d = driving(C, g.destIdx + 0.5, 0);
  const ctx2 = ctxFor(d.sets, d.now);
  const b2 = buildBoard({ geo, tt, tracks: ctx2.tracks, now: d.now, pins });
  assert.equal(b2.praca.pinId, null);
  assert.equal(reconcilePins(pins, b2).praca, null);
  // kurs z innego dnia rozkładowego nie występuje na liście
  assert.equal(reconcilePins({ praca: '2026-11-25_13_0754', dom: null }, b).praca, null);
});

test('ślady: postój nie kasuje kierunku jazdy, starsze pozycje ignorowane', () => {
  let t = updateTracks(new Map(), [pos('13', 'praca', 5, 1000)]);
  t = updateTracks(t, [pos('013', 'praca', 5.5, 2000)]);
  t = updateTracks(t, [pos('13', 'praca', 5.5, 3000)]);
  assert.equal(t.get('13').cur.time, 3000);
  assert.equal(t.get('13').prev.time, 1000);
  t = updateTracks(t, [pos('13', 'praca', 9, 500)]);
  assert.equal(t.get('13').cur.time, 3000);
});

test('kierunek jazdy z dwóch pozycji: autobus jadący w drugą stronę nie jest na tym kursie', () => {
  const { C } = pickCourse('praca', 8);
  const g = geo.praca;
  const now = plannedAt(C, g.myIdx - 2, g);
  const tracks = updateTracks(updateTracks(new Map(), [pos(C.brigade, 'praca', g.myIdx - 1.5, now - 30_000)]),
    [pos(C.brigade, 'praca', g.myIdx - 2, now - 5_000)]);
  const act = activeTrip(tracks.get(C.brigade), [C], geo, now);
  assert.equal(act, null);
});

test('wiek danych: najnowszy Time z odpowiedzi', () => {
  const ps = parsePositions(readJson('test/fixtures/positions.json'));
  assert.equal(ps.length, 3, 'tylko linia 185');
  assert.equal(newestTime(ps), warsawToMs(2026, 11, 26, 7, 52, 40));
  assert.equal(newestTime([]), null);
});

test('kierunek: automat 12:00, ręczny do granicy', () => {
  assert.equal(effectiveDir(null, at(11, 0)), 'praca');
  assert.equal(effectiveDir(null, at(12, 0)), 'dom');
  const m = manualDir('dom', at(9, 0));
  assert.equal(effectiveDir(m, at(11, 59)), 'dom');
  assert.equal(effectiveDir(m, at(12, 1)), 'dom', 'po 12:00 automat i tak daje dom');
  const m2 = manualDir('praca', at(13, 0));
  assert.equal(effectiveDir(m2, at(23, 59)), 'praca');
  assert.equal(effectiveDir(m2, warsawToMs(2026, 11, 27, 0, 1)), 'praca', 'po północy automat = praca');
  const m3 = manualDir('dom', at(23, 0));
  assert.equal(effectiveDir(m3, warsawToMs(2026, 11, 27, 0, 1)), 'praca', 'po północy wraca automat');
});
