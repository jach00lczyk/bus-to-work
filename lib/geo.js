// Rzutowanie pozycji GPS na uporządkowaną listę przystanków kierunku. Bez DOM.

const R = 6_371_000;
const rad = (d) => (d * Math.PI) / 180;

/** Odległość w metrach (przybliżenie równoodległościowe, wystarczające w skali miasta). */
export function distance(lat1, lon1, lat2, lon2) {
  const x = rad(lon2 - lon1) * Math.cos(rad((lat1 + lat2) / 2));
  const y = rad(lat2 - lat1);
  return Math.sqrt(x * x + y * y) * R;
}

function toXY(lat, lon, lat0) {
  return [rad(lon) * Math.cos(rad(lat0)) * R, rad(lat) * R];
}

/** Promień, w którym przystanek uznajemy za minięty / osiągnięty. */
export const STOP_RADIUS = 150;
/** Jak daleko od linii łączącej przystanki autobus może być, żeby uznać, że jedzie tą trasą. */
export const MAX_OFF_ROUTE = 300;

/**
 * Rzutuje punkt na łamaną przystanków.
 * Zwraca { progress, lastPassed, dist } albo null, gdy punkt jest dalej niż MAX_OFF_ROUTE od trasy.
 *  - progress: ciągły indeks (np. 6.4 = 40% drogi z przystanku 6 do 7),
 *  - lastPassed: ostatni minięty przystanek (indeks); przystanek, do którego autobus jest bliżej
 *    niż ~1/4 STOP_RADIUS, uznajemy za osiągnięty,
 *  - dist: odległość od trasy w metrach.
 * `hint` (poprzedni progress) rozstrzyga, gdy trasa przechodzi kilka razy przez to samo miejsce.
 */
export function project(stops, lat, lon, hint = null) {
  if (!stops?.length || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const lat0 = stops[0].lat;
  const [px, py] = toXY(lat, lon, lat0);
  const cands = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    const [ax, ay] = toXY(stops[i].lat, stops[i].lon, lat0);
    const [bx, by] = toXY(stops[i + 1].lat, stops[i + 1].lon, lat0);
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let f = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    f = Math.max(0, Math.min(1, f));
    const qx = ax + f * dx, qy = ay + f * dy;
    const d = Math.hypot(px - qx, py - qy);
    cands.push({ i, f, d, segLen: Math.sqrt(len2) });
  }
  const best = Math.min(...cands.map((c) => c.d));
  if (best > MAX_OFF_ROUTE) return null;
  let pick = cands.filter((c) => c.d <= best + 30);
  if (hint != null && pick.length > 1) pick.sort((a, b) => Math.abs(a.i + a.f - hint) - Math.abs(b.i + b.f - hint));
  else pick.sort((a, b) => a.d - b.d);
  const c = pick[0];
  const progress = c.i + c.f;
  const toNext = (1 - c.f) * c.segLen;
  const lastPassed = toNext < STOP_RADIUS / 4 ? c.i + 1 : c.i;
  return { progress, lastPassed, dist: c.d };
}

/** Typowy czas (s od początku trasy) w ciągłym punkcie `progress`. */
export function typicalAt(stops, progress) {
  const i = Math.max(0, Math.min(stops.length - 1, Math.floor(progress)));
  if (i >= stops.length - 1) return stops[stops.length - 1].t;
  const f = progress - i;
  return stops[i].t + f * (stops[i + 1].t - stops[i].t);
}
