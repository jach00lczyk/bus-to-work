// Czas warszawski, godziny 24:xx i dzień rozkładowy. Bez DOM, działa w Node i w przeglądarce.

export const TZ = 'Europe/Warsaw';
export const MIN = 60_000;
const DAY_S = 86_400;

let fmt;
function parts(ms) {
  fmt ??= new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const o = {};
  for (const p of fmt.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o;
}

/** Części daty w Warszawie: {year, month, day, hour, minute, second}. */
export function warsaw(ms) { return parts(ms); }

/** Przesunięcie Warszawy względem UTC w ms dla danej chwili. */
function offsetAt(ms) {
  const p = parts(ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** Czas lokalny w Warszawie -> ms epoki. Miesiąc 1–12; dzień i godziny mogą wychodzić poza zakres. */
export function warsawToMs(year, month, day, hour = 0, minute = 0, second = 0) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  let ms = naive - offsetAt(naive);
  ms = naive - offsetAt(ms);
  return ms;
}

/** "YYYY-MM-DD" bieżącej daty w Warszawie. */
export function warsawDate(ms) {
  const p = parts(ms);
  return ymd(p.year, p.month, p.day);
}

function ymd(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** "HH:MM:SS" albo "HH:MM" (także 24:xx i więcej) -> sekundy od północy dnia rozkładowego. */
export function clockToSec(s) {
  const [h, m, sec] = String(s).trim().split(':').map(Number);
  if (![h, m].every(Number.isFinite)) return NaN;
  return h * 3600 + m * 60 + (sec || 0);
}

/** Sekundy dnia rozkładowego -> ms epoki. 24:xx i więcej to następny dzień kalendarzowy. */
export function serviceSecToMs(serviceDate, sec) {
  const days = Math.floor(sec / DAY_S);
  const rest = sec - days * DAY_S;
  const [y, m, d] = addDays(serviceDate, days).split('-').map(Number);
  return warsawToMs(y, m, d, Math.floor(rest / 3600), Math.floor(rest / 60) % 60, rest % 60);
}

/** `Time` z API pozycji ("YYYY-MM-DD HH:MM:SS", czas warszawski) -> ms epoki. */
export function apiTimeToMs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s));
  if (!m) return NaN;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  return warsawToMs(y, mo, d, h, mi, se);
}

/** Godzina przełączenia dnia rozkładowego (nowe API: ok. 04:51, przyjmujemy 05:00). */
export const SERVICE_DAY_FLIP_HOUR = 5;

/** Domyślny dzień rozkładowy: przed 05:00 to jeszcze poprzedni dzień. */
export function defaultServiceDate(now) {
  const p = parts(now);
  const today = ymd(p.year, p.month, p.day);
  return p.hour < SERVICE_DAY_FLIP_HOUR ? addDays(today, -1) : today;
}

/** Najbliższa 05:00 czasu warszawskiego po `now`. */
export function nextFlip(now) {
  const p = parts(now);
  let t = warsawToMs(p.year, p.month, p.day, SERVICE_DAY_FLIP_HOUR);
  if (t <= now) t = warsawToMs(p.year, p.month, p.day + 1, SERVICE_DAY_FLIP_HOUR);
  return t;
}

/** Najbliższa granica ręcznego wyboru kierunku: 12:00 albo północ. */
export function nextDirBoundary(now) {
  const p = parts(now);
  const noon = warsawToMs(p.year, p.month, p.day, 12);
  return now < noon ? noon : warsawToMs(p.year, p.month, p.day + 1, 0);
}

/** Kierunek automatyczny: przed 12:00 „praca”, od 12:00 „dom”. */
export function autoDir(now) {
  return parts(now).hour < 12 ? 'praca' : 'dom';
}

/** ms -> "H:MM" w Warszawie (bez zera wiodącego w godzinie, jak w Zegarze). */
export function hhmm(ms) {
  const p = parts(ms);
  return `${p.hour}:${String(p.minute).padStart(2, '0')}`;
}
