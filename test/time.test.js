import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  warsawToMs, serviceSecToMs, clockToSec, apiTimeToMs, defaultServiceDate, nextFlip,
  nextDirBoundary, autoDir, hhmm, warsawDate, addDays
} from '../lib/time.js';

test('czas warszawski zimą to UTC+1, latem UTC+2', () => {
  assert.equal(warsawToMs(2026, 11, 26, 8, 0), Date.UTC(2026, 10, 26, 7, 0));
  assert.equal(warsawToMs(2026, 7, 1, 8, 0), Date.UTC(2026, 6, 1, 6, 0));
});

test('24:xx to następny dzień kalendarzowy', () => {
  assert.equal(clockToSec('24:15:00'), 24 * 3600 + 15 * 60);
  assert.equal(serviceSecToMs('2026-11-26', clockToSec('24:15:00')), warsawToMs(2026, 11, 27, 0, 15));
  assert.equal(serviceSecToMs('2026-11-30', clockToSec('28:54')), warsawToMs(2026, 12, 1, 4, 54));
  assert.equal(hhmm(serviceSecToMs('2026-11-26', clockToSec('24:15:00'))), '0:15');
});

test('Time z API pozycji', () => {
  assert.equal(apiTimeToMs('2026-11-26 07:54:12'), warsawToMs(2026, 11, 26, 7, 54, 12));
  assert.ok(Number.isNaN(apiTimeToMs('zły')));
});

test('dzień rozkładowy zmienia się o 05:00, nie o północy', () => {
  assert.equal(defaultServiceDate(warsawToMs(2026, 11, 27, 0, 30)), '2026-11-26');
  assert.equal(defaultServiceDate(warsawToMs(2026, 11, 27, 4, 59)), '2026-11-26');
  assert.equal(defaultServiceDate(warsawToMs(2026, 11, 27, 5, 0)), '2026-11-27');
  assert.equal(nextFlip(warsawToMs(2026, 11, 26, 14, 0)), warsawToMs(2026, 11, 27, 5, 0));
  assert.equal(nextFlip(warsawToMs(2026, 11, 27, 3, 0)), warsawToMs(2026, 11, 27, 5, 0));
});

test('granice kierunku: 12:00 i północ', () => {
  assert.equal(autoDir(warsawToMs(2026, 11, 26, 11, 59)), 'praca');
  assert.equal(autoDir(warsawToMs(2026, 11, 26, 12, 0)), 'dom');
  assert.equal(nextDirBoundary(warsawToMs(2026, 11, 26, 9, 0)), warsawToMs(2026, 11, 26, 12, 0));
  assert.equal(nextDirBoundary(warsawToMs(2026, 11, 26, 15, 0)), warsawToMs(2026, 11, 27, 0, 0));
});

test('daty', () => {
  assert.equal(warsawDate(Date.UTC(2026, 10, 26, 23, 30)), '2026-11-27');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});
