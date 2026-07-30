/* Unit + integration tests for assets/engine.js.  Run: node tools/test-engine.js */
'use strict';
const E = require('../assets/engine.js');

let pass = 0, fail = 0;
const approx = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? '  → ' + extra : '')); }
}
function group(n) { console.log('\n\x1b[1m' + n + '\x1b[0m'); }

/* ------------------------------------------------------------ primitives */
group('rolling primitives');
{
  const a = [1, 2, 3, 4, 5];
  const m = E.rollMean(a, 3, 3);
  ok('rollMean warm-up is NaN', Number.isNaN(m[0]) && Number.isNaN(m[1]));
  ok('rollMean value', approx(m[2], 2) && approx(m[4], 4), JSON.stringify(m));
  ok('rollMax', E.rollMax(a, 3, 1)[4] === 5);
  ok('rollMin', E.rollMin(a, 3, 1)[4] === 3);

  const sd = E.rollStd([2, 4, 4, 4, 5, 5, 7, 9], 8, 8);
  ok('rollStd is sample stdev', approx(sd[7], Math.sqrt(32 / 7), 1e-12), String(sd[7]));

  const withNaN = [1, NaN, 3, 4];
  ok('rollMean skips NaN', approx(E.rollMean(withNaN, 4, 2)[3], (1 + 3 + 4) / 3));
}

group('rollPctPast — no look-ahead');
{
  // strictly increasing: every point is the largest so far → 100
  const inc = [1, 2, 3, 4, 5, 6];
  const p = E.rollPctPast(inc, 10, 2);
  ok('increasing series → 100', p[2] === 100 && p[5] === 100, JSON.stringify(p));

  // strictly decreasing: every point is the smallest so far → 0
  const dec = [6, 5, 4, 3, 2, 1];
  const q = E.rollPctPast(dec, 10, 2);
  ok('decreasing series → 0', q[2] === 0 && q[5] === 0, JSON.stringify(q));

  // the current point must never be in its own reference window
  const a = [1, 1, 1, 1, 1, 1];
  ok('constant series → 0 (no self-inclusion)', E.rollPctPast(a, 10, 2)[5] === 0);

  // future values must not change a past score
  const base = [3, 1, 4, 1, 5];
  const ext = [3, 1, 4, 1, 5, 99, -99, 42];
  const pb = E.rollPctPast(base, 100, 2);
  const pe = E.rollPctPast(ext, 100, 2);
  ok('future data cannot alter earlier scores',
    base.every((_, i) => (Number.isNaN(pb[i]) && Number.isNaN(pe[i])) || pb[i] === pe[i]),
    JSON.stringify(pb) + ' vs ' + JSON.stringify(pe.slice(0, 5)));

  ok('minp respected', Number.isNaN(E.rollPctPast([1, 2, 3], 10, 5)[2]));
}

group('rollStdPast — excludes current point');
{
  const a = [1, 2, 3, 100];
  const s = E.rollStdPast(a, 10, 2);
  const exp = Math.sqrt(((1 - 2) ** 2 + (2 - 2) ** 2 + (3 - 2) ** 2) / 2);
  ok('stdev at i uses only prior points', approx(s[3], exp, 1e-12), `${s[3]} vs ${exp}`);
}

group('ewmAdjusted');
{
  // adjust=True on a constant series must return the constant
  const c = new Array(20).fill(5);
  ok('constant series preserved', approx(E.ewmAdjusted(c, 4)[19], 5, 1e-9));

  // first observation equals itself
  ok('first value = first obs', approx(E.ewmAdjusted([7, 1, 1], 4)[0], 7));

  // known pandas value: ewm(span=2, adjust=True).mean() of [1,2,3]
  // alpha = 2/3 → w=[1/9,1/3,1] → (3 + 2/3 + 1/9)/(1 + 1/3 + 1/9) = 2.615384615
  const p = E.ewmAdjusted([1, 2, 3], 2);
  ok('matches pandas ewm(span=2)', approx(p[2], 2.6153846153846154, 1e-12), String(p[2]));

  // NaN must be skipped, not decay the accumulator
  const withNaN = E.ewmAdjusted([1, NaN, NaN, 1], 4);
  ok('NaN inputs do not drag the mean', approx(withNaN[3], 1, 1e-12), String(withNaN[3]));
  ok('NaN forward-fills the level', approx(withNaN[1], 1, 1e-12));
}

group('piecewise');
{
  const k = [[0, 0], [10, 50], [20, 100]];
  ok('below first knot clamps', E.piecewise(-5, k) === 0);
  ok('above last knot clamps', E.piecewise(99, k) === 100);
  ok('exact knot', E.piecewise(10, k) === 50);
  ok('interpolates', approx(E.piecewise(5, k), 25));
  ok('interpolates upper segment', approx(E.piecewise(15, k), 75));
  ok('NaN in → NaN out', Number.isNaN(E.piecewise(NaN, k)));
}

group('scoreDir');
{
  const n = 400;
  const rising = Array.from({ length: n }, (_, i) => i * 0.001);
  const s = E.scoreDir(rising);
  ok('monotone rising raw → high score', s[n - 1] > 80, String(s[n - 1]));
  const falling = Array.from({ length: n }, (_, i) => -i * 0.001);
  ok('monotone falling raw → low score', E.scoreDir(falling)[n - 1] < 20);
  ok('invert flips', approx(E.scoreDir(falling, { invert: true })[n - 1],
    100 - E.scoreDir(falling)[n - 1], 1e-9));
  ok('bounded 0..100', E.scoreDir(rising).every(x => Number.isNaN(x) || (x >= 0 && x <= 100)));
  ok('zero-variance input → NaN', E.scoreDir(new Array(n).fill(0.5)).every(Number.isNaN));
}

group('scoreBounded');
{
  const raw = Array.from({ length: 200 }, (_, i) => Math.sin(i / 9) * 0.5);
  const s = E.scoreBounded(raw, 0.45);
  ok('no NaN after warm-up (falls back to tanh)', s.slice(0, 10).every(x => E.isNum(x)));
  ok('bounded 0..100', s.every(x => Number.isNaN(x) || (x >= 0 && x <= 100)));
  ok('zero maps to 50 during warm-up', approx(E.scoreBounded([0], 0.45)[0], 50, 1e-12));
  ok('positive raw → above 50', E.scoreBounded([0.9], 0.45)[0] > 50);
}

group('zones & labels');
{
  ok('24.9 = extreme fear', E.zoneOf(24.9).key === 'extreme-fear');
  ok('25 = fear', E.zoneOf(25).key === 'fear');
  ok('50 = neutral', E.zoneOf(50).key === 'neutral');
  ok('55 = neutral (inclusive)', E.zoneOf(55).key === 'neutral');
  ok('55.1 = greed', E.zoneOf(55.1).key === 'greed');
  ok('90 = extreme greed', E.zoneOf(90).key === 'extreme-greed');
  ok('NaN handled', E.zoneOf(NaN).key === 'unknown');
}

group('combineAt — dropout is reported, never silent');
{
  const full = {};
  for (const id of E.COMPONENT_IDS) full[id] = [60];
  const a = E.combineAt(full, 0);
  ok('full coverage', approx(a.score, 60) && approx(a.coverage, 1) && a.missing.length === 0);

  const one = { ...full, momentum: [NaN] };
  const b = E.combineAt(one, 0);
  ok('1 missing → still scores', approx(b.score, 60));
  ok('1 missing → coverage 6/7', approx(b.coverage, 6 / 7));
  ok('1 missing → reported', b.missing.length === 1 && b.missing[0] === 'momentum');

  const three = { ...full, momentum: [NaN], breadth: [NaN], strength: [NaN] };
  const c = E.combineAt(three, 0);
  ok('3 missing (< min coverage) → NaN score', Number.isNaN(c.score), String(c.score));
  ok('3 missing → coverage still reported', approx(c.coverage, 4 / 7));
}

group('quantile / forwardStats');
{
  const s = [1, 2, 3, 4, 5];
  ok('median', E.quantile(s, 0.5) === 3);
  ok('p25', E.quantile(s, 0.25) === 2);
  ok('p0', E.quantile(s, 0) === 1);
  const f = E.forwardStats([0.10, -0.05, 0.20, -0.10, 0.05]);
  ok('n', f.n === 5);
  ok('hit rate', f.hit === 60, String(f.hit));
  ok('worst', f.worst === -10, String(f.worst));
  ok('best', f.best === 20);
  ok('empty → null', E.forwardStats([]) === null);
}

group('allocation ladder is monotone-contrarian');
{
  const ws = [5, 15, 24, 30, 40, 50, 60, 70, 80, 95].map(E.zoneWeight);
  ok('weight decreases as greed rises', ws.every((w, i) => i === 0 || w <= ws[i - 1]), JSON.stringify(ws));
  ok('extreme fear → heavy equity', E.zoneWeight(10) >= 90);
  ok('extreme greed → light equity', E.zoneWeight(95) <= 20);
  ok('profiles ordered', E.profileWeight(60, 'conservative') < E.profileWeight(60, 'balanced')
    && E.profileWeight(60, 'balanced') < E.profileWeight(60, 'aggressive'));
  ok('profiles capped at 100', E.profileWeight(95, 'aggressive') <= 100);
}

group('targetWeight regime adjustments');
{
  const up = E.targetWeight(30, 20, { distMA200: 0.05, ma200Rising: true, ma200Falling: false });
  const dn = E.targetWeight(30, 20, { distMA200: -0.08, ma200Rising: false, ma200Falling: true });
  ok('downtrend sizes down vs uptrend', dn.weight < up.weight, `${dn.weight} vs ${up.weight}`);
  const capit = E.targetWeight(20, 70, { distMA200: -0.1, ma200Rising: false, ma200Falling: true });
  const calm  = E.targetWeight(20, 10, { distMA200: -0.1, ma200Rising: false, ma200Falling: true });
  ok('capitulation sizes up vs calm decline', capit.weight > calm.weight, `${capit.weight} vs ${calm.weight}`);
  ok('weights stay in 0..100', [up, dn, capit, calm].every(x => x.weight >= 0 && x.weight <= 100));
  ok('notes explain adjustments', dn.notes.length > 0);
}

group('pickAction decision table');
{
  const base = { distMA200: 0, ma200Falling: false, ma200Rising: false, aboveMA20: false, fgDelta5: 0 };
  ok('extreme fear + capitulation → buy strong',
    E.pickAction(15, 70, base).key === 'buy-strong');
  ok('extreme fear + calm → buy partial',
    E.pickAction(20, 20, base).key === 'buy-partial');
  ok('fear + confirmed downtrend → probe only',
    E.pickAction(35, 30, { ...base, distMA200: -0.1, ma200Falling: true }).key === 'buy-probe');
  ok('fear + stabilising → accumulate',
    E.pickAction(35, 30, { ...base, distMA200: -0.1, ma200Falling: true, aboveMA20: true }).key === 'accumulate');
  ok('neutral → hold', E.pickAction(50, 20, base).key === 'hold');
  ok('greed → no chase', E.pickAction(65, 20, base).key === 'no-chase');
  ok('extreme greed → trim', E.pickAction(85, 20, base).key === 'trim');
  ok('no score → wait', E.pickAction(NaN, NaN, base).key === 'wait');
}

group('backtest mechanics');
{
  // Constant 100% equity must reproduce buy-and-hold exactly (no turnover cost).
  const c = Array.from({ length: 300 }, (_, i) => 1000 * Math.pow(1.0004, i));
  const idx = c.map((_, i) => i);
  const w100 = idx.map(() => 100);
  const bt = E.backtest(c, w100, idx);
  ok('100% equity == buy & hold',
    approx(bt.stats.strat.total, bt.stats.bench.total, 0.05),
    `${bt.stats.strat.total} vs ${bt.stats.bench.total}`);
  ok('avg exposure 100%', bt.avgExposure === 100);
  ok('zero turnover when weight constant', bt.turnoverPerYear === 0);

  // 0% equity must earn exactly the risk-free rate.
  const bt0 = E.backtest(c, idx.map(() => 0), idx);
  const expected = (Math.pow(1 + E.RF_ANNUAL / 252, 299) - 1) * 100;
  ok('0% equity == risk-free', approx(bt0.stats.strat.total, +expected.toFixed(1), 0.1),
    `${bt0.stats.strat.total} vs ${expected.toFixed(1)}`);

  // Turnover must actually cost money.
  const flip = idx.map(i => (i % 2 ? 100 : 0));
  const btF = E.backtest(c, flip, idx);
  ok('turnover is charged', btF.stats.strat.total < bt.stats.strat.total);
  ok('maxdd is negative or zero', bt.stats.strat.maxdd <= 0);
}

group('no look-ahead in the full signal path');
{
  // Truncating the series must not change any earlier score.
  const n = 500;
  const c = [];
  let p = 1000;
  for (let i = 0; i < n; i++) { p *= 1 + Math.sin(i / 17) * 0.004 + 0.0002; c.push(p); }
  const raw = c.map((x, i) => (i >= 125 ? x / E.mean(c.slice(i - 124, i + 1)) - 1 : NaN));
  const sFull = E.scoreDir(raw);
  const sTrunc = E.scoreDir(raw.slice(0, 400));
  let same = true;
  for (let i = 0; i < 400; i++) {
    const a = sFull[i], b = sTrunc[i];
    if (Number.isNaN(a) && Number.isNaN(b)) continue;
    if (!approx(a, b, 1e-9)) { same = false; break; }
  }
  ok('scores are causal (truncation-invariant)', same);
}

/* ------------------------------------------------- end-to-end on synthetic */
group('end-to-end compute() on synthetic market data');
{
  const DAY = 86400;
  const N = 1400;
  const t0 = Math.floor(Date.now() / 1000) - N * DAY;

  // A market with a long bull run then a sharp 20% crash on rising volume.
  const t = [], c = [], v = [], h = [], l = [], o = [];
  let px = 900;
  for (let i = 0; i < N; i++) {
    const crash = i > N - 60;
    const drift = crash ? -0.004 : 0.0007;
    const shock = Math.sin(i / 23) * 0.004 + Math.cos(i / 7) * 0.002;
    px *= 1 + drift + shock;
    t.push(t0 + i * DAY);
    c.push(px); o.push(px * 0.999); h.push(px * 1.006); l.push(px * 0.994);
    v.push((crash ? 1.8 : 1) * 5e8 * (1 + 0.2 * Math.sin(i / 5)));
  }
  const vni = { t, o, h, l, c, v };
  const vn30 = { t, c: c.map(x => x * 1.08) };
  const fut = { t, c: c.map((x, i) => x * 1.08 * (1 + Math.sin(i / 31) * 0.004)) };

  const WEEKS = 260;
  const wt0 = Math.floor(Date.now() / 1000) - WEEKS * 7 * DAY;
  const stocks = E.VN30.map((sym, si) => {
    const wt = [], wc = [], wh = [], wl = [], wv = [];
    let q = 20 + si;
    for (let k = 0; k < WEEKS; k++) {
      const crash = k > WEEKS - 9;
      q *= 1 + (crash ? -0.03 : 0.004) + Math.sin((k + si) / 6) * 0.02;
      wt.push(wt0 + k * 7 * DAY);
      wc.push(q); wh.push(q * 1.03); wl.push(q * 0.97); wv.push(1e6 * (1 + 0.3 * Math.cos(k / 4)));
    }
    return [sym, { t: wt, o: wc, h: wh, l: wl, c: wc, v: wv }];
  });

  const out = E.compute({ vni, vn30, fut, stocks });

  ok('returns a score', E.isNum(out.score), String(out.score));
  ok('score in 0..100', out.score >= 0 && out.score <= 100);
  ok('crash produces a fearful reading', out.score < 45, String(out.score));
  ok('panic score present and elevated', E.isNum(out.panic.score) && out.panic.score > 40,
    String(out.panic.score));
  ok('full coverage (7/7)', out.dataQuality.coverage === 1,
    `coverage=${out.dataQuality.coverage} missing=${out.dataQuality.missing}`);
  ok('all 30 symbols used', out.dataQuality.stocksUsed === 30, String(out.dataQuality.stocksUsed));
  ok('7 components returned', out.components.length === 7);
  ok('every component has a numeric score',
    out.components.every(x => E.isNum(x.score)),
    JSON.stringify(out.components.map(x => [x.id, x.score])));
  ok('verdict is a buy-side action', ['buy-strong', 'buy-partial', 'buy-probe', 'accumulate'].includes(out.verdict.action),
    out.verdict.action);
  ok('verdict has a target weight', E.isNum(out.verdict.targetEquity));
  ok('verdict has tranches', out.verdict.tranches.length === 3);
  ok('tranche percentages sum to 100',
    out.verdict.tranches.reduce((p, x) => p + x.pct, 0) === 100,
    JSON.stringify(out.verdict.tranches.map(x => x.pct)));
  ok('verdict has invalidation rules', out.verdict.invalidation.length >= 2);
  ok('verdict cites reasons', out.verdict.why.length >= 3);
  ok('base rates computed', out.baseRates.buckets.length === 7);
  ok('base rates around current reading', out.baseRates.around !== null);
  ok('backtest ran', out.backtest.periods > 500 && E.isNum(out.backtest.full.strat.total));
  ok('backtest has split-sample halves',
    E.isNum(out.backtest.firstHalf.strat.total) && E.isNum(out.backtest.secondHalf.strat.total));
  ok('history is non-empty', out.history.length > 100);
  ok('history entries are well-formed', out.history.every(x => x.d && E.isNum(x.s) && E.isNum(x.v)));
  ok('previous readings are null-or-number, never coerced 0',
    Object.values(out.previous).every(x => x === null || E.isNum(x)));
  ok('levels populated', E.isNum(out.verdict.levels.ma200) && E.isNum(out.verdict.levels.swingLow));
  ok('drawdown is negative after crash', out.vnindex.drawdown_pct < -5, String(out.vnindex.drawdown_pct));

  // Degraded-input behaviour.
  const noStocks = E.compute({ vni, vn30, fut, stocks: [] });
  ok('survives with zero constituent data', E.isNum(noStocks.score));
  ok('reports reduced coverage', noStocks.dataQuality.coverage < 1,
    String(noStocks.dataQuality.coverage));
  ok('names the missing components',
    noStocks.dataQuality.missing.includes('strength') && noStocks.dataQuality.missing.includes('breadth'),
    JSON.stringify(noStocks.dataQuality.missing));
  ok('warns about coverage in the verdict',
    noStocks.verdict.why.some(w => w.includes('thành phần hợp lệ')));

  const noDeriv = E.compute({ vni, vn30: null, fut: null, stocks });
  ok('survives with no derivatives data', E.isNum(noDeriv.score));
  ok('putcall reported missing', noDeriv.dataQuality.missing.includes('putcall'));

  let threw = false;
  try { E.compute({ vni: { t: [1], c: [1], v: [1], h: [1], l: [1], o: [1] } }); } catch (e) { threw = true; }
  ok('rejects too-short history loudly', threw);

  // Stale weekly feed must decay to missing, not freeze.
  const staleStocks = stocks.map(([s, j]) => [s, {
    ...j, t: j.t.map(x => x - 120 * DAY),
  }]);
  const stale = E.compute({ vni, vn30, fut, stocks: staleStocks });
  ok('stale weekly feed drops out instead of freezing',
    stale.dataQuality.missing.includes('strength'),
    JSON.stringify(stale.dataQuality.missing));
}

group('greed scenario produces a sell-side verdict');
{
  const DAY = 86400, N = 1400;
  const t0 = Math.floor(Date.now() / 1000) - N * DAY;
  const t = [], c = [], v = [], h = [], l = [], o = [];
  let px = 900;
  for (let i = 0; i < N; i++) {
    // steady grind up, then a near-vertical melt-up with fading volume
    const meltup = i > N - 50;
    px *= 1 + (meltup ? 0.008 : 0.0004) + Math.sin(i / 29) * 0.002;
    t.push(t0 + i * DAY);
    c.push(px); o.push(px); h.push(px * 1.004); l.push(px * 0.996);
    v.push(5e8 * (meltup ? 1.5 : 1));
  }
  const vni = { t, o, h, l, c, v };
  const vn30 = { t, c: c.map(x => x * 1.08) };
  const fut = { t, c: c.map(x => x * 1.09) };
  const WEEKS = 260, wt0 = Math.floor(Date.now() / 1000) - WEEKS * 7 * DAY;
  const stocks = E.VN30.map((sym, si) => {
    const wt = [], wc = [], wh = [], wl = [], wv = [];
    let q = 20 + si;
    for (let k = 0; k < WEEKS; k++) {
      q *= 1 + (k > WEEKS - 8 ? 0.05 : 0.003);
      wt.push(wt0 + k * 7 * DAY);
      wc.push(q); wh.push(q * 1.02); wl.push(q * 0.98); wv.push(1e6);
    }
    return [sym, { t: wt, o: wc, h: wh, l: wl, c: wc, v: wv }];
  });
  const out = E.compute({ vni, vn30, fut, stocks });
  ok('melt-up produces a greedy reading', out.score > 55, String(out.score));
  ok('verdict is sell-side', ['no-chase', 'trim'].includes(out.verdict.action), out.verdict.action);
  ok('sell verdict still gives a plan', out.verdict.tranches.length === 3);
  ok('panic is low in a melt-up', out.panic.score < 40, String(out.panic.score));
}

/* ------------------------------------------------------------------ report */
console.log('\n' + '─'.repeat(52));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
