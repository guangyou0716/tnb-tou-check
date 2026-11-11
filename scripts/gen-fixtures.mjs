#!/usr/bin/env node
// Deterministic synthetic interval data for the published worked examples (no randomness, integer Wh).
// Run `node scripts/gen-fixtures.mjs` to (re)write fixtures/*.csv. Tests check the files match.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pad = (n) => String(n).padStart(2, '0');

/** All 30-minute blocks of a month in local time, with an independent peak flag (Mon-Fri 14:00-22:00). */
export function monthBlocks(year, month, holidays = []) {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const blocks = [];
  for (let day = 1; day <= days; day++) {
    const date = `${year}-${pad(month)}-${pad(day)}`;
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const workday = weekday >= 1 && weekday <= 5 && !holidays.includes(date);
    for (let slot = 0; slot < 48; slot++) {
      const minute = slot * 30;
      blocks.push({
        timestamp: `${date} ${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`,
        peak: workday && minute >= 14 * 60 && minute < 22 * 60,
        wh: 0,
      });
    }
  }
  return blocks;
}

function spread(blocks, totalWh) {
  if (blocks.length === 0) {
    if (totalWh !== 0) throw new Error('no blocks to spread energy over');
    return;
  }
  const base = Math.floor(totalWh / blocks.length);
  const extra = totalWh - base * blocks.length;
  blocks.forEach((b, i) => {
    b.wh = base + (i < extra ? 1 : 0);
  });
}

/**
 * One month of 30-minute blocks. `fixed` pins exact Wh on given timestamps (to set maximum demand);
 * the rest of the peak and off-peak energy is spread evenly.
 */
export function buildMonth({ year, month, peakWh, offPeakWh, fixed = [], holidays = [] }) {
  const blocks = monthBlocks(year, month, holidays);
  const pinned = new Map(fixed.map((f) => [f.timestamp, f.wh]));
  let peakLeft = peakWh;
  let offLeft = offPeakWh;
  for (const b of blocks) {
    if (pinned.has(b.timestamp)) {
      b.wh = pinned.get(b.timestamp);
      if (b.peak) peakLeft -= b.wh;
      else offLeft -= b.wh;
    }
  }
  spread(blocks.filter((b) => b.peak && !pinned.has(b.timestamp)), peakLeft);
  spread(blocks.filter((b) => !b.peak && !pinned.has(b.timestamp)), offLeft);
  return blocks;
}

const kwh = (wh) => `${Math.floor(wh / 1000)}.${String(wh % 1000).padStart(3, '0')}`;

/** CSV with timestamp (interval start, local time) and kwh. 15-minute output splits each block in two. */
export function toCsv(blocks, intervalMinutes = 30) {
  const lines = ['timestamp,kwh'];
  for (const b of blocks) {
    if (intervalMinutes === 30) {
      lines.push(`${b.timestamp},${kwh(b.wh)}`);
    } else {
      const first = Math.floor(b.wh / 2);
      const [date, time] = b.timestamp.split(' ');
      const [hh, mm] = time.split(':').map(Number);
      lines.push(`${b.timestamp},${kwh(first)}`);
      lines.push(`${date} ${pad(hh)}:${pad(mm + 15)},${kwh(b.wh - first)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// September 2025: 30 days, starts on a Monday, 22 weekdays -> 352 peak blocks, 1088 off-peak blocks.
export const FIXTURES = {
  // FactoryHub LV cold room: 30,000 kWh, 7,200 kWh peak (24%).
  'lv-cold-room.csv': () =>
    toCsv(buildMonth({ year: 2025, month: 9, peakWh: 7_200_000, offPeakWh: 22_800_000 })),
  // FactoryHub MV factory A: 150,000 kWh, 45% peak, anytime MD = peak MD = 500 kW (Wed 3 Sep 15:00).
  'mv-factory-a.csv': () =>
    toCsv(
      buildMonth({
        year: 2025,
        month: 9,
        peakWh: 67_500_000,
        offPeakWh: 82_500_000,
        fixed: [{ timestamp: '2025-09-03 15:00', wh: 250_000 }],
      }),
    ),
  // FactoryHub MV factory B: 150,000 kWh, 35% peak, anytime MD 500 kW at night, peak MD 400 kW.
  'mv-factory-b.csv': () => toCsv(factoryB()),
  'mv-factory-b-15min.csv': () => toCsv(factoryB(), 15),
};

function factoryB() {
  return buildMonth({
    year: 2025,
    month: 9,
    peakWh: 52_500_000,
    offPeakWh: 97_500_000,
    fixed: [
      { timestamp: '2025-09-10 02:00', wh: 250_000 },
      { timestamp: '2025-09-11 16:30', wh: 200_000 },
    ],
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = new URL('../fixtures/', import.meta.url);
  for (const [name, make] of Object.entries(FIXTURES)) {
    writeFileSync(new URL(name, dir), make());
    console.log(`wrote fixtures/${name}`);
  }
}
