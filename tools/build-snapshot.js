#!/usr/bin/env node
/* =============================================================================
   Computes a reading and writes dist/snapshot.js.

   This is NOT served to visitors. The live site has no embedded fallback — it
   always computes from the API, or shows an error. This output exists only so
   tools/build-standalone.js can bundle a portable offline file, and so CI can
   verify the whole pipeline still produces a sane number.

   WHY THIS IS NODE AND NOT PYTHON
   v1's code was littered with "mirror compute.py" comments, but compute.py was
   never committed, and a second implementation of the same maths in another
   language is a standing invitation for the two to drift apart silently.
   This script imports the *same* assets/engine.js the browser runs, so the
   snapshot and the live view can never disagree by construction.

   Usage:
     node tools/build-snapshot.js                    # fetch live, write snapshot
     node tools/build-snapshot.js --fixtures ./fx    # build from saved JSON
     node tools/build-snapshot.js --out /tmp/s.js    # custom output path
     node tools/build-snapshot.js --dry-run          # compute, print, write nothing
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const E = require('../assets/engine.js');

const ROOT = path.resolve(__dirname, '..');
const UPSTREAM = 'https://services.entrade.com.vn/chart-api/v2/ohlcs';

const LOOKBACK = { daily: 2200, weekly: 1950, future: 1150 };
const CONCURRENCY = 4;
const TIMEOUT_MS = 20000;

/* ------------------------------------------------------------------- args */

function parseArgs(argv) {
  const out = { fixtures: null, outPath: path.join(ROOT, 'dist', 'snapshot.js'), dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--fixtures') out.fixtures = path.resolve(argv[++i]);
    else if (argv[i] === '--out') out.outPath = path.resolve(argv[++i]);
    else if (argv[i] === '--dry-run') out.dryRun = true;
  }
  return out;
}

/* ------------------------------------------------------------------ fetch */

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url, retries = 2) {
  let lastErr;
  for (let a = 0; a <= retries; a++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'vn-fear-greed-snapshot/2.0', Accept: 'application/json' },
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (a < retries) await sleep(600 * (a + 1));
    }
  }
  throw new Error(`${lastErr.message} — ${url}`);
}

async function pool(jobs, limit) {
  const results = new Array(jobs.length);
  let next = 0;
  await Promise.all(new Array(Math.min(limit, jobs.length)).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      try { results[i] = { ok: true, value: await jobs[i]() }; }
      catch (e) { results[i] = { ok: false, error: e }; }
    }
  }));
  return results;
}

const usable = (j, min) => !!(j && Array.isArray(j.t) && Array.isArray(j.c) &&
                              j.t.length >= min && j.t.length === j.c.length);

const url = (kind, p) => `${UPSTREAM}/${kind}?` + new URLSearchParams(p).toString();

async function fetchLive() {
  const now = Math.floor(Date.now() / 1000 / 900) * 900;
  const log = m => process.stderr.write(m + '\n');

  log('→ VN-Index, VN30, VN30F1M');
  const [vniR, vn30R, futR] = await pool([
    () => getJSON(url('index', { from: now - 86400 * LOOKBACK.daily, to: now, symbol: 'VNINDEX', resolution: '1D' })),
    () => getJSON(url('index', { from: now - 86400 * LOOKBACK.daily, to: now, symbol: 'VN30', resolution: '1D' })),
    () => getJSON(url('derivative', { from: now - 86400 * LOOKBACK.future, to: now, symbol: 'VN30F1M', resolution: '1D' })),
  ], 3);

  if (!vniR.ok || !usable(vniR.value, 150)) {
    throw new Error('VN-Index fetch failed: ' + (vniR.ok ? 'series too short' : vniR.error.message));
  }

  log(`→ ${E.VN30.length} VN30 constituents (weekly)`);
  const settled = await pool(E.VN30.map(sym => () =>
    getJSON(url('stock', { from: now - 86400 * LOOKBACK.weekly, to: now, symbol: sym, resolution: '1W' }))), CONCURRENCY);

  const stocks = [];
  const failed = [];
  settled.forEach((r, i) => {
    if (r.ok && usable(r.value, 30)) stocks.push([E.VN30[i], r.value]);
    else failed.push(E.VN30[i]);
  });
  if (failed.length) log('  ! failed: ' + failed.join(', '));

  return {
    vni: vniR.value,
    vn30: vn30R.ok && usable(vn30R.value, 100) ? vn30R.value : null,
    fut: futR.ok && usable(futR.value, 100) ? futR.value : null,
    stocks,
  };
}

/* --------------------------------------------------------------- fixtures */

function loadFixtures(dir) {
  const read = f => {
    const p = path.join(dir, f);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
  };
  const vni = read('vnindex.json');
  if (!vni) throw new Error(`Missing ${path.join(dir, 'vnindex.json')}`);
  const stocks = [];
  for (const sym of E.VN30) {
    const j = read(`stocks/${sym}.json`);
    if (j && usable(j, 30)) stocks.push([sym, j]);
  }
  return { vni, vn30: read('vn30.json'), fut: read('vn30f1m.json'), stocks };
}

/* ----------------------------------------------------------------- output */

/**
 * The browser never needs the full raw component arrays, and they dominate the
 * file size. Strip them before serialising — v1's snapshot was a ~100 KB single
 * line, which made every git diff useless.
 */
function slimForSnapshot(out) {
  const { raw, detailDates, detailSeries, full, ...rest } = out;
  // Sparklines do not need 500 points, and the fallback payload is shipped to
  // every visitor on first paint. Trim the long tails.
  const tail = (arr, n) => (Array.isArray(arr) ? arr.slice(-n) : arr);
  rest.history = tail(rest.history, 320);
  if (rest.panic) rest.panic = { ...rest.panic, history: tail(rest.panic.history, 320) };
  if (rest.componentHistory) {
    rest.componentHistory = Object.fromEntries(
      Object.entries(rest.componentHistory).map(([k, v]) => [k, tail(v, 160)]));
  }
  if (rest.backtest) rest.backtest = { ...rest.backtest, curve: tail(rest.backtest.curve, 260) };
  return rest;
}

function serialise(payload) {
  const json = JSON.stringify(payload, null, 0);
  return `/* Auto-generated by tools/build-snapshot.js — do not edit by hand.
   Generated: ${new Date().toISOString()}
   Data date: ${payload.updated}
   Only consumed by tools/build-standalone.js — never served to visitors. */
window.SNAPSHOT = ${json};
`;
}

/* ------------------------------------------------------------------- main */

(async function main() {
  const args = parseArgs(process.argv);
  try {
    const data = args.fixtures ? loadFixtures(args.fixtures) : await fetchLive();
    const out = E.compute(data);

    process.stderr.write(
      `\n  date          ${out.updated}\n` +
      `  F&G           ${out.score}  (${out.label})\n` +
      `  panic         ${out.panic.score}  (${out.panic.label})\n` +
      `  coverage      ${out.dataQuality.coverage} — missing: ${out.dataQuality.missing.join(', ') || 'none'}\n` +
      `  stocks        ${out.dataQuality.stocksUsed}/${out.dataQuality.stocksExpected}\n` +
      `  daily bars    ${out.dataQuality.dailyBars} from ${out.dataQuality.firstDate}\n` +
      `  verdict       ${out.verdict.title}\n` +
      `  target equity ${out.verdict.targetEquity}%\n\n`);

    if (args.dryRun) { process.stderr.write('--dry-run: nothing written\n'); return; }

    if (out.dataQuality.coverage < E.MIN_COVERAGE) {
      throw new Error('Refusing to write a snapshot with insufficient component coverage.');
    }

    fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
    fs.writeFileSync(args.outPath, serialise(slimForSnapshot(out)), 'utf8');
    process.stderr.write(`written: ${args.outPath} (${(fs.statSync(args.outPath).size / 1024).toFixed(1)} KB)\n`);
  } catch (err) {
    process.stderr.write('FAILED: ' + (err && err.stack ? err.stack : err) + '\n');
    process.exit(1);
  }
})();
