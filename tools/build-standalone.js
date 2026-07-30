#!/usr/bin/env node
/* =============================================================================
   Bundles index.html + assets/* into ONE portable HTML file that runs with no
   server, no network and no deploy — double-click and it works.

   Useful for: sharing a reading with someone, archiving a specific day, or
   viewing on a machine that cannot reach the API. The bundle renders from the
   embedded snapshot only (window.FG_OFFLINE), so it never attempts a fetch.

   Usage: node tools/build-standalone.js [--out dist/standalone.html] [--slim]
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const outPath = args.includes('--out')
  ? path.resolve(args[args.indexOf('--out') + 1])
  : path.join(ROOT, 'dist', 'standalone.html');
const slim = args.includes('--slim');

const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let html = read('index.html');
const engine = read('assets/engine.js');
const ui = read('assets/ui.js');
let snapshot = read('assets/snapshot.js');

if (slim) {
  // Trim the long series so the bundle stays small enough to embed elsewhere.
  const m = /window\.SNAPSHOT = ([\s\S]*);\s*$/.exec(snapshot);
  if (m) {
    const s = JSON.parse(m[1]);
    const tail = (a, n) => (Array.isArray(a) ? a.slice(-n) : a);
    s.history = tail(s.history, 180);
    if (s.panic) s.panic.history = tail(s.panic.history, 180);
    if (s.componentHistory) {
      for (const k of Object.keys(s.componentHistory)) {
        s.componentHistory[k] = tail(s.componentHistory[k], 90);
      }
    }
    if (s.backtest) s.backtest.curve = tail(s.backtest.curve, 150);
    snapshot = 'window.SNAPSHOT = ' + JSON.stringify(s) + ';';
  }
}

const inline = (label, code) =>
  `<script>/* ---- ${label} ---- */\n${code}\n</script>`;

// data.js is deliberately omitted: an offline bundle must have no fetch path.
html = html.replace(
  /<script src="assets\/engine\.js"><\/script>[\s\S]*?<script src="assets\/ui\.js"><\/script>/,
  [
    '<script>window.FG_OFFLINE = true; window.FGData = null;</script>',
    inline('engine.js', engine),
    inline('snapshot.js', snapshot),
    inline('ui.js', ui),
  ].join('\n')
);

if (html.includes('assets/engine.js')) {
  console.error('FAILED: script tags were not replaced — check index.html markup.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html, 'utf8');

const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
console.error(`written: ${outPath} (${kb} KB)${slim ? ' [slim]' : ''}`);
