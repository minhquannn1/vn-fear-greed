/* =============================================================================
   VN Fear & Greed Index — ENGINE
   Pure computation. No DOM. No globals besides the exported namespace.
   Runs in the browser and under Node (for tests) via the UMD shim at the bottom.

   Design rules enforced here (differences vs. the v1 implementation):
   1.  Every rolling normalisation uses a STRICTLY PAST window. The current
       observation is never part of the distribution it is scored against.
   2.  All 7 components share one normalisation family, so their 0-100 values
       are actually comparable before averaging.
   3.  Missing components re-weight the composite, but the re-weighting is
       reported (`coverage`, `missing`) instead of happening silently.
   4.  Nothing is coerced to 0 when it is missing. Missing is `null`.
   ========================================================================== */
'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FGEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

/* ---------------------------------------------------------------- constants */

const EPS = 1e-12;
const TRADING_DAYS = 252;

/** Risk-free proxy: 12M VND deposit / short government bond, annualised. */
const RF_ANNUAL = 0.048;

/** Round-trip transaction cost assumption for the backtest (15 bps). */
const COST_PER_TURN = 0.0015;

const VN30 = ['ACB','BCM','BID','CTG','DGC','FPT','GAS','GVR','HDB','HPG',
              'LPB','MBB','MSN','MWG','PLX','SAB','SHB','SSB','SSI','STB',
              'TCB','TPB','VCB','VHM','VIB','VIC','VJC','VNM','VPB','VRE'];

const COMPONENT_IDS = ['momentum','strength','breadth','putcall',
                       'volatility','safehaven','junkdemand'];

/** Equal weights. Kept explicit so they can be changed without touching logic. */
const COMPONENT_WEIGHTS = {
  momentum: 1, strength: 1, breadth: 1, putcall: 1,
  volatility: 1, safehaven: 1, junkdemand: 1,
};

/** Minimum share of total weight that must be present for a valid composite. */
const MIN_COVERAGE = 5 / 7;

const META = {
  momentum:   ['Đà thị trường',        'VN-Index so với trung bình 125 phiên'],
  strength:   ['Sức mạnh giá cổ phiếu','Số mã VN30 sát đỉnh vs sát đáy 52 tuần'],
  breadth:    ['Độ lan toả dòng tiền', 'Giá trị khớp lệnh mã tăng vs mã giảm'],
  putcall:    ['Tâm lý phái sinh',     'Basis VN30F1M so với chỉ số cơ sở VN30'],
  volatility: ['Biến động thị trường', 'Biến động thực 20 phiên so với nền 50 phiên'],
  safehaven:  ['Nhu cầu trú ẩn',       'Lợi suất cổ phiếu 20 phiên so với lãi suất phi rủi ro'],
  junkdemand: ['Khẩu vị rủi ro',       'Thanh khoản 20 phiên so với nền 100 phiên'],
};

const ZONES = [
  { max: 25,       key: 'extreme-fear',  label: 'Sợ hãi cực độ' },
  { max: 45,       key: 'fear',          label: 'Sợ hãi' },
  { max: 55.00001, key: 'neutral',       label: 'Trung tính' },
  { max: 75,       key: 'greed',         label: 'Tham lam' },
  { max: Infinity, key: 'extreme-greed', label: 'Tham lam cực độ' },
];

/* ------------------------------------------------------------- tiny helpers */

const isNum = x => typeof x === 'number' && Number.isFinite(x);
const NaNs  = n => new Array(n).fill(NaN);
const clip  = (x, a, b) => Math.min(b, Math.max(a, x));
const sum   = a => a.reduce((p, c) => p + c, 0);
const mean  = a => sum(a) / a.length;

/** Round for display; returns null (never 0) when the input is not a number. */
const r1 = x => (isNum(x) ? +x.toFixed(1) : null);
const r2 = x => (isNum(x) ? +x.toFixed(2) : null);

/** Last finite value of a series, or null. */
function lastFinite(a) {
  for (let i = a.length - 1; i >= 0; i--) if (isNum(a[i])) return a[i];
  return null;
}

/**
 * Entrade timestamps are exchange-local sessions published between 00:00 and
 * 12:00 UTC. Shifting by +7h (ICT) lands every observed bar on the correct
 * Vietnamese calendar date without pulling in a timezone library.
 */
const dstr = t => new Date((t + 7 * 3600) * 1000).toISOString().slice(0, 10);

/* ------------------------------------------------- rolling window primitives */

function rollApply(a, w, minp, fn) {
  const out = NaNs(a.length);
  for (let i = 0; i < a.length; i++) {
    const s = Math.max(0, i - w + 1);
    const win = [];
    for (let j = s; j <= i; j++) if (isNum(a[j])) win.push(a[j]);
    if (win.length >= minp) out[i] = fn(win, a[i]);
  }
  return out;
}

const rollMean = (a, w, minp = w) => rollApply(a, w, minp, mean);
const rollMax  = (a, w, minp = w) => rollApply(a, w, minp, x => Math.max(...x));
const rollMin  = (a, w, minp = w) => rollApply(a, w, minp, x => Math.min(...x));

const rollStd = (a, w, minp = w) => rollApply(a, w, minp, x => {
  if (x.length < 2) return NaN;
  const m = mean(x);
  return Math.sqrt(sum(x.map(v => (v - m) * (v - m))) / (x.length - 1));
});

/**
 * Percentile rank of a[i] inside the `w` observations that came BEFORE it.
 * The current point is excluded from its own reference distribution, which is
 * what makes the resulting score usable in a backtest without leakage.
 * Returns a value in [0, 100).
 */
function rollPctPast(a, w, minp) {
  const out = NaNs(a.length);
  for (let i = 0; i < a.length; i++) {
    if (!isNum(a[i])) continue;
    const s = Math.max(0, i - w);
    let n = 0, lt = 0;
    for (let j = s; j < i; j++) {
      if (!isNum(a[j])) continue;
      n++;
      if (a[j] < a[i]) lt++;
    }
    if (n >= minp) out[i] = (100 * lt) / n;
  }
  return out;
}

/** Standard deviation of the `w` observations strictly before index i. */
function rollStdPast(a, w, minp) {
  const out = NaNs(a.length);
  for (let i = 0; i < a.length; i++) {
    const s = Math.max(0, i - w);
    const win = [];
    for (let j = s; j < i; j++) if (isNum(a[j])) win.push(a[j]);
    if (win.length >= minp && win.length >= 2) {
      const m = mean(win);
      out[i] = Math.sqrt(sum(win.map(v => (v - m) * (v - m))) / (win.length - 1));
    }
  }
  return out;
}

/**
 * pandas-equivalent ewm(span, adjust=True, ignore_na=True).
 * v1 decayed the accumulator on NaN inputs, which quietly biased the breadth
 * series toward 0 across holidays. Here NaN observations are truly skipped.
 */
function ewmAdjusted(a, span) {
  const alpha = 2 / (span + 1);
  let num = 0, den = 0;
  const out = NaNs(a.length);
  for (let i = 0; i < a.length; i++) {
    if (isNum(a[i])) {
      num = num * (1 - alpha) + a[i];
      den = den * (1 - alpha) + 1;
    }
    out[i] = den > EPS ? num / den : NaN;
  }
  return out;
}

/* ------------------------------------------------------ scoring transformers */

/**
 * Score an unbounded, zero-anchored signal onto 0-100.
 * Half of the score is where the signal sits in its own recent history
 * (percentile, past-only); half is how far it is from its neutral point of 0
 * in units of past volatility (tanh, saturating).
 */
function scoreDir(raw, opts = {}) {
  const { w = TRADING_DAYS, minp = 60, invert = false, k = 0.7 } = opts;
  const p  = rollPctPast(raw, w, minp);
  const sd = rollStdPast(raw, w, minp);
  return raw.map((v, i) => {
    if (!isNum(v) || !isNum(p[i]) || !isNum(sd[i]) || sd[i] < EPS) return NaN;
    const t = 50 * (1 + Math.tanh((k * v) / sd[i]));
    const s = 0.5 * p[i] + 0.5 * t;
    return invert ? 100 - s : s;
  });
}

/**
 * Score a signal that is already bounded on [-1, 1] and zero-anchored.
 * Same 50/50 blend as scoreDir, but the tanh scale is a fixed constant because
 * a rolling stdev of a bounded ratio is unstable on weekly data.
 *
 * v1 used a bare tanh here, which put `strength` and `breadth` on a completely
 * different distribution from the other five components and then averaged them
 * together anyway. During warm-up (before `minp` history exists) we still fall
 * back to the bare tanh rather than dropping the component.
 */
function scoreBounded(raw, scale, opts = {}) {
  const { w = 156, minp = 52, invert = false } = opts;
  const p = rollPctPast(raw, w, minp);
  return raw.map((v, i) => {
    if (!isNum(v)) return NaN;
    const t = 50 * (1 + Math.tanh(v / scale));
    const s = isNum(p[i]) ? 0.5 * p[i] + 0.5 * t : t;
    return invert ? 100 - s : s;
  });
}

/** Linear interpolation across an ascending list of [input, output] knots. */
function piecewise(x, knots) {
  if (!isNum(x)) return NaN;
  if (x <= knots[0][0]) return knots[0][1];
  const last = knots[knots.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < knots.length; i++) {
    const [x0, y0] = knots[i - 1], [x1, y1] = knots[i];
    if (x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  }
  return last[1];
}

/* -------------------------------------------------------------- zone helpers */

function zoneOf(score) {
  if (!isNum(score)) return { key: 'unknown', label: 'Không xác định', max: 0 };
  for (const z of ZONES) if (score < z.max) return z;
  return ZONES[ZONES.length - 1];
}
const labelOf = score => zoneOf(score).label;

/* =============================================================================
   COMPOSITE INDEX
   ========================================================================== */

/**
 * Weighted mean of whatever components exist at index i.
 * Returns { score, coverage, missing } so callers can react to dropouts
 * instead of receiving a silently re-weighted number.
 */
function combineAt(series, i, weights = COMPONENT_WEIGHTS) {
  let wsum = 0, acc = 0, total = 0;
  const missing = [];
  for (const id of COMPONENT_IDS) {
    const w = weights[id] ?? 0;
    total += w;
    const v = series[id] ? series[id][i] : NaN;
    if (isNum(v)) { acc += w * v; wsum += w; }
    else missing.push(id);
  }
  const coverage = total > 0 ? wsum / total : 0;
  return {
    score: coverage >= MIN_COVERAGE ? acc / wsum : NaN,
    coverage,
    missing,
  };
}

/* =============================================================================
   PANIC / CAPITULATION DETECTOR
   A deliberately separate axis from Fear & Greed.
   F&G answers "how does the market feel?".  Panic answers "is this an orderly
   pullback or a disorderly washout?".  The two together decide position sizing:
   cheap-and-calm is accumulated slowly, cheap-and-violent is where the
   asymmetric entries historically live.
   ========================================================================== */

function computePanic(c, v) {
  const n = c.length;

  const hi250   = rollMax(c, 250, 60);
  const ma200   = rollMean(c, 200, 120);
  const ma20v   = rollMean(v, 20, 10);
  const logret  = c.map((x, i) => (i > 0 && isNum(c[i - 1]) && c[i - 1] > 0 ? Math.log(x / c[i - 1]) : NaN));
  const rv20    = rollStd(logret, 20, 15).map(x => (isNum(x) ? x * Math.sqrt(TRADING_DAYS) : NaN));
  const rvPct   = rollPctPast(rv20, TRADING_DAYS * 2, 120);
  const distMA  = c.map((x, i) => (isNum(ma200[i]) && ma200[i] > 0 ? x / ma200[i] - 1 : NaN));
  const distSd  = rollStdPast(distMA, TRADING_DAYS * 3, 200);

  const parts = {
    drawdown: NaNs(n), belowTrend: NaNs(n), volumeClimax: NaNs(n),
    downDays: NaNs(n), velocity: NaNs(n), volatility: NaNs(n),
  };
  const score = NaNs(n);
  const drawdown = NaNs(n);
  const ret10 = NaNs(n);
  const volRatio = NaNs(n);

  for (let i = 0; i < n; i++) {
    // (a) depth: how far below the 250-session high we are
    if (isNum(hi250[i]) && hi250[i] > 0) {
      drawdown[i] = c[i] / hi250[i] - 1;
      parts.drawdown[i] = piecewise(-drawdown[i] * 100,
        [[0, 0], [5, 20], [10, 40], [15, 60], [20, 80], [30, 100]]);
    }

    // (b) structure: distance below the 200-session trend, in past-vol units
    if (isNum(distMA[i]) && isNum(distSd[i]) && distSd[i] > EPS) {
      parts.belowTrend[i] = clip(50 * (1 + Math.tanh(-distMA[i] / distSd[i])), 0, 100);
    }

    // (c) participation: volume spike, but only counted as panic on down moves
    if (isNum(ma20v[i]) && ma20v[i] > 0) {
      volRatio[i] = v[i] / ma20v[i];
      const falling = i >= 5 && isNum(c[i - 5]) && c[i] < c[i - 5];
      parts.volumeClimax[i] = falling
        ? piecewise(volRatio[i], [[0.9, 0], [1.2, 35], [1.6, 70], [2.4, 100]])
        : 0;
    }

    // (d) persistence: share of the last 10 sessions that closed down
    if (i >= 10) {
      let down = 0;
      for (let j = i - 9; j <= i; j++) if (isNum(c[j]) && isNum(c[j - 1]) && c[j] < c[j - 1]) down++;
      parts.downDays[i] = piecewise(down / 10,
        [[0.3, 0], [0.5, 20], [0.7, 55], [0.9, 85], [1.0, 100]]);
    }

    // (e) speed: 10-session return
    if (i >= 10 && isNum(c[i - 10]) && c[i - 10] > 0) {
      ret10[i] = c[i] / c[i - 10] - 1;
      parts.velocity[i] = piecewise(-ret10[i] * 100,
        [[0, 0], [3, 25], [6, 55], [10, 80], [15, 100]]);
    }

    // (f) turbulence: where realised vol sits in its own 2-year history
    if (isNum(rvPct[i])) parts.volatility[i] = clip((rvPct[i] - 50) * 2, 0, 100);

    const W = { drawdown: 0.20, belowTrend: 0.15, volumeClimax: 0.15,
                downDays: 0.15, velocity: 0.20, volatility: 0.15 };
    let acc = 0, wsum = 0;
    for (const k in W) if (isNum(parts[k][i])) { acc += W[k] * parts[k][i]; wsum += W[k]; }
    if (wsum >= 0.7) score[i] = acc / wsum;
  }

  return { score, parts, drawdown, ret10, volRatio, ma200, rv20, hi250 };
}

function panicLabel(p) {
  if (!isNum(p)) return 'Không xác định';
  if (p < 25) return 'Bình thường';
  if (p < 45) return 'Căng thẳng';
  if (p < 65) return 'Hoảng loạn';
  return 'Bán tháo / Capitulation';
}

/* =============================================================================
   HISTORICAL BASE RATES
   "When the index was this low before, what actually happened next?"
   Overlapping windows are used, so the effective sample is far smaller than n.
   That caveat is returned with the data rather than buried.
   ========================================================================== */

const BUCKETS = [
  { lo: -Infinity, hi: 20, label: '< 20' },
  { lo: 20, hi: 30, label: '20 – 30' },
  { lo: 30, hi: 40, label: '30 – 40' },
  { lo: 40, hi: 50, label: '40 – 50' },
  { lo: 50, hi: 60, label: '50 – 60' },
  { lo: 60, hi: 70, label: '60 – 70' },
  { lo: 70, hi: Infinity, label: '> 70' },
];

const HORIZONS = [
  { d: 21,  label: '1 tháng' },
  { d: 63,  label: '3 tháng' },
  { d: 126, label: '6 tháng' },
];

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function forwardStats(rets) {
  if (!rets.length) return null;
  const s = [...rets].sort((a, b) => a - b);
  return {
    n: rets.length,
    median: r1(quantile(s, 0.5) * 100),
    mean: r1(mean(rets) * 100),
    hit: r1((rets.filter(x => x > 0).length / rets.length) * 100),
    p25: r1(quantile(s, 0.25) * 100),
    worst: r1(s[0] * 100),
    best: r1(s[s.length - 1] * 100),
  };
}

function baseRates(composite, c) {
  const table = BUCKETS.map(b => ({ label: b.label, lo: b.lo, hi: b.hi, h: {} }));
  for (const b of table) for (const h of HORIZONS) b.h[h.d] = [];

  for (let i = 0; i < composite.length; i++) {
    const s = composite[i];
    if (!isNum(s)) continue;
    const b = table.find(x => s >= x.lo && s < x.hi);
    if (!b) continue;
    for (const h of HORIZONS) {
      const j = i + h.d;
      if (j < c.length && isNum(c[j]) && isNum(c[i]) && c[i] > 0) b.h[h.d].push(c[j] / c[i] - 1);
    }
  }

  return table.map(b => ({
    label: b.label, lo: b.lo, hi: b.hi,
    stats: Object.fromEntries(HORIZONS.map(h => [h.d, forwardStats(b.h[h.d])])),
  }));
}

/**
 * Base rates for a neighbourhood around the current reading rather than a
 * fixed bucket — a score of 24.9 and 25.1 should not give different answers.
 */
function baseRatesAround(composite, c, current, halfWidth = 5) {
  if (!isNum(current)) return null;
  const lo = current - halfWidth, hi = current + halfWidth;
  const out = { lo: r1(lo), hi: r1(hi), stats: {} };

  /**
   * Count contiguous runs, not days. 60 days inside the band sounds like a
   * healthy sample until you notice they are three week-long episodes. This is
   * the number that actually governs how much the base rates can be trusted.
   */
  const GAP_TOLERANCE = 21; // a re-entry within a month is the same episode
  let episodes = 0, daysIn = 0, lastInside = -Infinity;
  for (let i = 0; i < composite.length; i++) {
    const s = composite[i];
    if (!isNum(s) || s < lo || s > hi) continue;
    daysIn++;
    if (i - lastInside > GAP_TOLERANCE) episodes++;
    lastInside = i;
  }
  out.episodes = episodes;
  out.daysIn = daysIn;

  for (const h of HORIZONS) {
    const rets = [];
    for (let i = 0; i < composite.length; i++) {
      const s = composite[i];
      if (!isNum(s) || s < lo || s > hi) continue;
      const j = i + h.d;
      if (j < c.length && isNum(c[j]) && isNum(c[i]) && c[i] > 0) rets.push(c[j] / c[i] - 1);
    }
    out.stats[h.d] = forwardStats(rets);
  }
  return out;
}

/* =============================================================================
   CONFIDENCE
   How much weight the verdict deserves, expressed as a number instead of a
   shrug. Every input is something measured, not a hand-set constant:

   1. coverage        — how many of the 7 components actually reported
   2. agreement       — do the components tell the same story, or contradict?
   3. evidence        — is the historical base rate for this reading consistent
                        across horizons, and built on enough distinct episodes?
   4. extremity       — readings near 50 carry less information than extremes
   5. validation      — a hard ceiling derived from whether the rule beat a
                        fixed-weight portfolio at the SAME average exposure.
                        If the strategy cannot clear that bar, no amount of
                        component agreement earns high confidence.
   ========================================================================== */

function computeConfidence(input) {
  const { score, componentScores, coverage, around, backtest } = input;
  const parts = {};

  parts.coverage = isNum(coverage) ? clip(coverage * 100, 0, 100) : 0;

  const vals = (componentScores || []).filter(isNum);
  if (vals.length >= 3) {
    const m = mean(vals);
    const sd = Math.sqrt(sum(vals.map(v => (v - m) * (v - m))) / (vals.length - 1));
    // sd of ~35 means components are pointing in opposite directions.
    parts.agreement = clip(100 * (1 - sd / 35), 0, 100);
  } else parts.agreement = 0;

  if (around && around.stats) {
    const meds = HORIZONS.map(h => around.stats[h.d]).filter(Boolean);
    if (meds.length) {
      const signs = meds.map(s => Math.sign(s.median || 0));
      const dominant = Math.sign(sum(signs)) || 1;
      const signAgree = signs.filter(x => x === dominant).length / signs.length;
      const avgHit = mean(meds.map(s => (dominant > 0 ? s.hit : 100 - s.hit)));
      const hitStrength = clip((avgHit - 50) / 25, 0, 1);
      const episodeAdequacy = clip((around.episodes || 0) / 8, 0, 1);
      parts.evidence = clip(100 * (0.30 * signAgree + 0.30 * hitStrength + 0.40 * episodeAdequacy), 0, 100);
    } else parts.evidence = 0;
  } else parts.evidence = 0;

  parts.extremity = isNum(score) ? clip((Math.abs(score - 50) / 30) * 100, 0, 100) : 0;

  let ceiling = 60, validationNote = 'Chưa kiểm định được hiệu quả lịch sử của quy tắc.';
  if (backtest && backtest.strat && backtest.matched) {
    const s = backtest.strat.total, b = backtest.matched.total;
    if (isNum(s) && isNum(b)) {
      const edge = s - b;
      if (edge > 10)      { ceiling = 85; validationNote = `Quy tắc vượt danh mục cố định cùng tỷ trọng ${r1(edge)} điểm % trong mẫu.`; }
      else if (edge > 0)  { ceiling = 70; validationNote = `Quy tắc nhỉnh hơn danh mục cố định cùng tỷ trọng ${r1(edge)} điểm % — chưa đủ thuyết phục.`; }
      else if (edge > -15){ ceiling = 45; validationNote = `Quy tắc THUA danh mục cố định cùng tỷ trọng ${r1(-edge)} điểm % trong mẫu.`; }
      else                { ceiling = 30; validationNote = `Quy tắc THUA danh mục cố định cùng tỷ trọng tới ${r1(-edge)} điểm % — tín hiệu chưa chứng minh được giá trị định thời điểm.`; }
    }
  }

  const W = { coverage: 0.20, agreement: 0.25, evidence: 0.30, extremity: 0.25 };
  let raw = 0;
  for (const k in W) raw += W[k] * (parts[k] || 0);

  const value = clip(Math.min(raw, ceiling), 0, 100);

  const drags = [];
  if (parts.coverage < 100) drags.push('thiếu thành phần dữ liệu');
  if (parts.agreement < 45) drags.push('các thành phần mâu thuẫn nhau');
  if (parts.evidence < 45) drags.push('bằng chứng lịch sử mỏng hoặc không nhất quán');
  if (parts.extremity < 40) drags.push('chỉ số gần vùng trung tính nên ít thông tin');
  if (raw > ceiling) drags.push('trần tin cậy do kiểm định lịch sử');

  return {
    value: r1(value),
    label: value >= 70 ? 'Cao' : value >= 50 ? 'Khá' : value >= 30 ? 'Thấp' : 'Rất thấp',
    parts: Object.fromEntries(Object.keys(parts).map(k => [k, r1(parts[k])])),
    ceiling,
    validationNote,
    drags,
  };
}

/* =============================================================================
   ALLOCATION LADDER + BACKTEST
   ========================================================================== */

/** Contrarian target equity weight from the F&G score alone. */
function zoneWeight(s) {
  if (!isNum(s)) return NaN;
  return piecewise(s, [[10, 95], [20, 90], [25, 85], [35, 75], [45, 65],
                       [55, 55], [65, 45], [75, 35], [85, 25], [95, 15]]);
}

/**
 * Regime-aware target: the pure contrarian ladder, nudged by the 200-session
 * trend and by whether the selling is disorderly.
 * Buying falling knives in a confirmed downtrend is sized down; buying a
 * capitulation flush while already cheap is sized up.
 */
function targetWeight(score, panic, ctx) {
  let t = zoneWeight(score);
  if (!isNum(t)) return NaN;
  const notes = [];

  if (ctx && isNum(ctx.distMA200)) {
    if (ctx.distMA200 < 0 && ctx.ma200Falling) { t -= 10; notes.push('Dưới MA200 và MA200 đang dốc xuống → giảm 10 điểm tỷ trọng'); }
    else if (ctx.distMA200 < 0)                { t -= 5;  notes.push('Dưới MA200 → giảm 5 điểm tỷ trọng'); }
    else if (ctx.ma200Rising)                  { t += 5;  notes.push('Trên MA200 và MA200 dốc lên → tăng 5 điểm tỷ trọng'); }
  }
  if (isNum(panic) && isNum(score) && score < 30 && panic >= 45) {
    t += 8; notes.push('Bán tháo trong vùng định giá sợ hãi → tăng 8 điểm (vùng mua bất đối xứng)');
  }
  if (isNum(panic) && isNum(score) && score >= 55 && panic >= 55) {
    t -= 8; notes.push('Biến động mạnh nhưng tâm lý chưa sợ → giảm 8 điểm (rủi ro chưa được chiết khấu)');
  }
  return { weight: clip(Math.round(t / 5) * 5, 0, 100), notes };
}

const PROFILES = {
  conservative: { mult: 0.65, cap: 80,  label: 'Thận trọng' },
  balanced:     { mult: 1.00, cap: 95,  label: 'Cân bằng' },
  aggressive:   { mult: 1.30, cap: 100, label: 'Mạo hiểm' },
};

const profileWeight = (w, p) =>
  isNum(w) ? clip(Math.round((w * PROFILES[p].mult) / 5) * 5, 0, PROFILES[p].cap) : NaN;

function drawdownCurve(curve) {
  let peak = -Infinity, worst = 0;
  for (const x of curve) { peak = Math.max(peak, x); if (peak > 0) worst = Math.min(worst, x / peak - 1); }
  return worst;
}

function annualise(curve, periods) {
  if (curve.length < 2 || periods <= 0) return NaN;
  return Math.pow(curve[curve.length - 1], TRADING_DAYS / periods) - 1;
}

function sharpe(rets, rfd) {
  if (rets.length < 20) return NaN;
  const ex = rets.map(x => x - rfd);
  const m = mean(ex);
  const sd = Math.sqrt(sum(ex.map(x => (x - m) * (x - m))) / (ex.length - 1));
  return sd < EPS ? NaN : (m / sd) * Math.sqrt(TRADING_DAYS);
}

/**
 * Walk-forward backtest.
 *  - The weight applied to day k's return is the one implied by the signal
 *    available at the CLOSE of day k-1.
 *  - Transaction cost is charged on the day the weight actually changes.
 *  - Because every component is normalised past-only, the equity curve does not
 *    consume information that was unavailable at the time.
 * Still in-sample in the sense that the rules themselves were chosen with
 * hindsight; treat it as a sanity check on the rule set, not as a forecast.
 */
function backtest(c, weights, idx) {
  const rfd = RF_ANNUAL / TRADING_DAYS;

  // Pass 1: establish the strategy's average exposure so the fair benchmark —
  // a fixed weight holding the SAME amount of equity on average — can be run
  // alongside it. Comparing a 59%-invested rule to 100% buy-and-hold flatters
  // or damns it for the wrong reason; this isolates the timing decision itself.
  let expSum = 0, expN = 0;
  for (let k = 1; k < idx.length; k++) {
    const i = idx[k], iPrev = idx[k - 1];
    if (!isNum(c[i]) || !isNum(c[iPrev]) || c[iPrev] <= 0) continue;
    if (!isNum(weights[k - 1]) || !isNum(weights[k])) continue;
    expSum += weights[k - 1] / 100; expN++;
  }
  const wMatched = expN ? expSum / expN : 0.6;

  const strat = [], bench = [], matched = [], dates = [];
  const sRets = [], bRets = [], mRets = [];
  let es = 1, eb = 1, em = 1, turnover = 0;

  for (let k = 1; k < idx.length; k++) {
    const i = idx[k], iPrev = idx[k - 1];
    if (!isNum(c[i]) || !isNum(c[iPrev]) || c[iPrev] <= 0) continue;
    const wPrev = weights[k - 1];
    const wNow  = weights[k];
    if (!isNum(wPrev) || !isNum(wNow)) continue;

    const r = c[i] / c[iPrev] - 1;
    const w = wPrev / 100;
    const cost = COST_PER_TURN * (Math.abs(wNow - wPrev) / 100);
    const rs = w * r + (1 - w) * rfd - cost;
    const rm = wMatched * r + (1 - wMatched) * rfd;

    es *= 1 + rs;
    eb *= 1 + r;
    em *= 1 + rm;

    turnover += Math.abs(wNow - wPrev) / 100;
    strat.push(es); bench.push(eb); matched.push(em);
    sRets.push(rs); bRets.push(r); mRets.push(rm);
    dates.push(i);
  }

  const nP = strat.length;
  const stat = (curve, rets) => {
    if (!curve.length) return { total: null, cagr: null, maxdd: null, sharpe: null, calmar: null };
    const dd = drawdownCurve(curve);
    return {
      total:  r1((curve[curve.length - 1] - 1) * 100),
      cagr:   r1(annualise(curve, nP) * 100),
      maxdd:  r1(dd * 100),
      sharpe: r2(sharpe(rets, rfd)),
      calmar: r2(dd < 0 ? annualise(curve, nP) / Math.abs(dd) : NaN),
    };
  };

  return {
    idx: dates,
    strat, bench, matched,
    stats: { strat: stat(strat, sRets), bench: stat(bench, bRets), matched: stat(matched, mRets) },
    matchedWeight: r1(wMatched * 100),
    turnoverPerYear: r1((turnover / nP) * TRADING_DAYS),
    avgExposure: r1(wMatched * 100),
    periods: nP,
  };
}

/** Same engine over an arbitrary slice — used for the split-sample check. */
function backtestSlice(c, weights, idx, from, to) {
  return backtest(c, weights.slice(from, to), idx.slice(from, to));
}

/* =============================================================================
   VERDICT ENGINE
   Turns numbers into one unambiguous instruction, plus the conditions under
   which that instruction stops being valid.
   ========================================================================== */

const ACTIONS = {
  BUY_AGGRESSIVE: { key: 'buy-strong', tone: 'buy',
    title: 'GIẢI NGÂN MẠNH — MUA CHỦ ĐỘNG',
    gist: 'Thị trường đang bán tháo trong vùng định giá sợ hãi. Đây là vùng mua bất đối xứng.' },
  BUY_PARTIAL: { key: 'buy-partial', tone: 'buy',
    title: 'BẮT ĐÁY TỪNG PHẦN — CÓ',
    gist: 'Có cơ sở để giải ngân một phần ngay, phần còn lại chia lô theo điều kiện bên dưới.' },
  BUY_PROBE: { key: 'buy-probe', tone: 'lean-buy',
    title: 'GIẢI NGÂN THĂM DÒ — LÔ NHỎ',
    gist: 'Rẻ nhưng chưa có tín hiệu dừng rơi. Vào lô nhỏ, giữ phần lớn tiền mặt để mua thấp hơn.' },
  ACCUMULATE: { key: 'accumulate', tone: 'lean-buy',
    title: 'TÍCH LUỸ DẦN',
    gist: 'Tâm lý còn thận trọng nhưng cấu trúc chưa gãy. Mua đều tay, không cần vội.' },
  HOLD: { key: 'hold', tone: 'neutral',
    title: 'GIỮ NGUYÊN — CHƯA LÀM GÌ',
    gist: 'Không có lợi thế rõ ràng ở cả hai chiều. Đứng yên là quyết định đúng.' },
  NO_CHASE: { key: 'no-chase', tone: 'lean-sell',
    title: 'KHÔNG MUA ĐUỔI',
    gist: 'Tâm lý đã nghiêng về tham lam. Giữ danh mục hiện có, ngừng mua mới ở vùng giá này.' },
  TRIM: { key: 'trim', tone: 'sell',
    title: 'GIẢM TỶ TRỌNG — CHỐT LỜI TỪNG PHẦN',
    gist: 'Thị trường hưng phấn. Hạ tỷ trọng dần để có tiền mặt cho đợt chiết khấu sau.' },
  WAIT_DATA: { key: 'wait', tone: 'neutral',
    title: 'CHƯA ĐỦ DỮ LIỆU',
    gist: 'Không đủ thành phần hợp lệ để đưa ra kết luận. Không hành động theo chỉ số lúc này.' },
};

function pickAction(score, panic, ctx) {
  if (!isNum(score)) return ACTIONS.WAIT_DATA;
  const falling = ctx.distMA200 < 0 && ctx.ma200Falling;
  const stabilising = ctx.aboveMA20 || (isNum(ctx.fgDelta5) && ctx.fgDelta5 > 4);

  if (score < 25) {
    if (isNum(panic) && panic >= 60) return ACTIONS.BUY_AGGRESSIVE;
    if (isNum(panic) && panic >= 40) return stabilising ? ACTIONS.BUY_PARTIAL : ACTIONS.BUY_PROBE;
    return ACTIONS.BUY_PARTIAL;
  }
  if (score < 45) {
    if (falling && !stabilising) return ACTIONS.BUY_PROBE;
    return ACTIONS.ACCUMULATE;
  }
  if (score <= 55) return ACTIONS.HOLD;
  if (score <= 75) return ACTIONS.NO_CHASE;
  return ACTIONS.TRIM;
}

/**
 * The tranche ladder. Expressed as a share of the gap between the investor's
 * current equity weight and the target, so it works regardless of how much
 * they already hold. Trigger levels are concrete index numbers, not vibes.
 */
function buildTranches(action, ctx) {
  const px = ctx.last;
  const lvl = x => (isNum(x) ? Math.round(x) : null);

  if (action.tone === 'sell' || action.tone === 'lean-sell') {
    return [
      { pct: 50, when: 'Ngay phiên gần nhất',
        detail: 'Hạ trước ở nhóm đã tăng nóng và nhóm thanh khoản thấp.' },
      { pct: 30, when: `Nếu VN-Index vượt ${lvl(px * 1.03)} (+3%)`,
        detail: 'Bán vào sức mạnh, không bán đuổi khi giảm.' },
      { pct: 20, when: 'Nếu chỉ số F&G vượt 85',
        detail: 'Vùng hưng phấn cực độ — giữ tiền mặt chờ chiết khấu.' },
    ];
  }
  if (action === ACTIONS.HOLD) return [];

  const first = action === ACTIONS.BUY_AGGRESSIVE ? 50
              : action === ACTIONS.BUY_PARTIAL    ? 40
              : action === ACTIONS.ACCUMULATE     ? 35 : 25;
  const second = action === ACTIONS.BUY_AGGRESSIVE ? 30 : 35;
  const third = 100 - first - second;

  return [
    { pct: first, when: 'Ngay — phiên kế tiếp',
      detail: 'Mua ở nhóm vốn hoá lớn, thanh khoản cao, nợ vay thấp. Không dùng margin.' },
    { pct: second, when: `Nếu VN-Index về ${lvl(px * 0.97)} (−3%) hoặc F&G xuống dưới ${Math.max(5, Math.round(ctx.score - 6))}`,
      detail: 'Lô này chỉ kích hoạt khi thị trường giảm thêm — đây là phần thưởng cho việc chờ.' },
    { pct: third, when: `Nếu VN-Index đóng cửa trên MA20 (${lvl(ctx.ma20)}) hoặc F&G bật lên trên ${Math.round(Math.min(60, ctx.score + 12))}`,
      detail: 'Lô xác nhận — mua khi đà giảm đã dừng, chấp nhận giá cao hơn để đổi lấy độ chắc chắn.' },
  ];
}

function buildInvalidation(action, ctx) {
  const lvl = x => (isNum(x) ? Math.round(x) : '—');
  if (action.tone === 'sell' || action.tone === 'lean-sell') {
    return [
      `Ngừng bán nếu VN-Index bật lên trên ${lvl(ctx.hi250)} kèm thanh khoản tăng — xu hướng tăng có thể còn kéo dài.`,
      'Không bán toàn bộ. Đây là hạ tỷ trọng, không phải thoát hàng.',
    ];
  }
  if (action === ACTIONS.HOLD) {
    return ['Kích hoạt lại kế hoạch khi F&G rơi xuống dưới 35 (mua) hoặc vượt 70 (bán).'];
  }
  return [
    `Dừng giải ngân nếu VN-Index đóng cửa dưới ${lvl(ctx.swingLow)} — đáy gần nhất bị xuyên thủng nghĩa là kịch bản này sai.`,
    'Dừng nếu chỉ số hoảng loạn trên 80 mà thanh khoản CẠN dần — bán tháo không có người mua thì đáy chưa hình thành.',
    'Không dùng đòn bẩy cho bất kỳ lô nào. Kế hoạch này giả định tiền thật, không margin.',
    'Nếu sau 3 lô mà vẫn còn tiền mặt, giữ nguyên — không có lô thứ tư.',
  ];
}

function buildVerdict(input) {
  const { score, panic, ctx, coverage, missing, base, confidence } = input;
  const action = pickAction(score, panic, ctx);
  const tw = targetWeight(score, panic, ctx);
  const target = tw && isNum(tw.weight) ? tw.weight : NaN;

  const why = [];
  if (isNum(score)) why.push(`Chỉ số F&G ${r1(score)}/100 — ${labelOf(score)}.`);
  if (isNum(panic)) why.push(`Mức hoảng loạn ${r1(panic)}/100 — ${panicLabel(panic)}.`);
  if (isNum(ctx.distMA200)) {
    why.push(ctx.distMA200 < 0
      ? `VN-Index đang thấp hơn MA200 ${Math.abs(r1(ctx.distMA200 * 100))}% — xu hướng dài hạn đã bị bẻ gãy.`
      : `VN-Index còn cao hơn MA200 ${r1(ctx.distMA200 * 100)}% — xu hướng dài hạn vẫn nguyên.`);
  }
  if (isNum(ctx.drawdown)) why.push(`Đã chiết khấu ${Math.abs(r1(ctx.drawdown * 100))}% so với đỉnh 250 phiên.`);
  if (base && base.stats && base.stats[63] && base.stats[63].n >= 15) {
    const s = base.stats[63];
    why.push(`Trong quá khứ, khi F&G nằm quanh mức này (${base.lo}–${base.hi}, ${s.n} phiên chồng lấn), VN-Index sau 3 tháng có trung vị ${s.median > 0 ? '+' : ''}${s.median}%, tỷ lệ dương ${s.hit}%, xấu nhất ${s.worst}%.`);
  }
  if (coverage < 1) {
    why.push(`Chỉ có ${Math.round(coverage * 7)}/7 thành phần hợp lệ (thiếu: ${missing.map(m => META[m][0]).join(', ')}) — trọng số đã được chia lại và độ tin cậy thấp hơn bình thường.`);
  }

  /**
   * Confidence is not decoration: it scales how much of the plan should
   * actually be executed. A 30%-confidence "buy" is a small probe, not a
   * conviction trade, and the copy has to say so in the same breath as the
   * headline rather than in a footnote nobody reads.
   */
  let confidenceAdvice = '';
  if (confidence && isNum(confidence.value)) {
    const v = confidence.value;
    if (v >= 70) confidenceAdvice = 'Độ tin cậy cao: có thể thực hiện kế hoạch với quy mô đầy đủ như mô tả.';
    else if (v >= 50) confidenceAdvice = 'Độ tin cậy khá: nên thực hiện với khoảng 2/3 quy mô, giữ thêm tiền mặt dự phòng.';
    else if (v >= 30) confidenceAdvice = 'Độ tin cậy thấp: chỉ nên coi đây là lệnh thăm dò với khoảng 1/3 quy mô. Tín hiệu chưa đủ mạnh để hành động dứt khoát.';
    else confidenceAdvice = 'Độ tin cậy rất thấp: nên coi kết luận này là tham khảo, không phải cơ sở để hành động. Ưu tiên giữ nguyên trạng thái hiện tại.';
  }

  return {
    confidence: confidence || null,
    confidenceAdvice,
    action: action.key,
    tone: action.tone,
    title: action.title,
    gist: action.gist,
    targetEquity: isNum(target) ? target : null,
    profiles: isNum(target) ? {
      conservative: profileWeight(target, 'conservative'),
      balanced: profileWeight(target, 'balanced'),
      aggressive: profileWeight(target, 'aggressive'),
    } : null,
    weightNotes: tw ? tw.notes : [],
    why,
    tranches: buildTranches(action, ctx),
    invalidation: buildInvalidation(action, ctx),
    levels: {
      last: r2(ctx.last), ma20: r2(ctx.ma20), ma50: r2(ctx.ma50),
      ma125: r2(ctx.ma125), ma200: r2(ctx.ma200),
      hi250: r2(ctx.hi250), lo250: r2(ctx.lo250), swingLow: r2(ctx.swingLow),
    },
  };
}

/* =============================================================================
   MAIN PIPELINE
   Consumes already-fetched OHLCV payloads so it stays testable offline.
   ========================================================================== */

/**
 * @param {Object} data
 *   data.vni  {t,o,h,l,c,v}  VN-Index daily
 *   data.vn30 {t,c}          VN30 index daily (basis denominator)
 *   data.fut  {t,c}          VN30F1M daily
 *   data.stocks [[sym, {t,h,l,c,v}], ...]  VN30 constituents, WEEKLY
 */
function compute(data, opts = {}) {
  const { vni, vn30, fut, stocks = [] } = data;
  if (!vni || !Array.isArray(vni.t) || vni.t.length < 150) {
    throw new Error('Dữ liệu VN-Index không đủ dài để tính chỉ số (cần ≥150 phiên).');
  }

  const dates = vni.t.map(dstr);
  const c = vni.c.slice();
  const v = vni.v.slice();
  const n = c.length;

  /* --- 1. momentum -------------------------------------------------------- */
  const ma125 = rollMean(c, 125, 100);
  const ma200 = rollMean(c, 200, 150);
  const ma50  = rollMean(c, 50, 40);
  const ma20  = rollMean(c, 20, 15);
  const momentumRaw = c.map((x, i) => (isNum(ma125[i]) && ma125[i] > 0 ? x / ma125[i] - 1 : NaN));
  const momentum = scoreDir(momentumRaw);

  /* --- 5. volatility (inverted: high vol = fear) -------------------------- */
  const logret = c.map((x, i) => (i > 0 && isNum(c[i - 1]) && c[i - 1] > 0 ? Math.log(x / c[i - 1]) : NaN));
  const rv20 = rollStd(logret, 20, 18).map(x => (isNum(x) ? x * Math.sqrt(TRADING_DAYS) : NaN));
  const rvBase = rollMean(rv20, 50, 40);
  const volRaw = rv20.map((x, i) => (isNum(x) && isNum(rvBase[i]) && rvBase[i] > 0 ? x / rvBase[i] - 1 : NaN));
  const volatility = scoreDir(volRaw, { invert: true });

  /* --- 6. safe haven demand ---------------------------------------------- */
  const shRaw = c.map((x, i) =>
    (i >= 20 && isNum(c[i - 20]) && c[i - 20] > 0 ? x / c[i - 20] - 1 - (RF_ANNUAL * 20) / TRADING_DAYS : NaN));
  const safehaven = scoreDir(shRaw);

  /* --- 7. risk appetite via liquidity ------------------------------------ */
  const v20 = rollMean(v, 20, 15), v100 = rollMean(v, 100, 80);
  const liqRaw = v20.map((x, i) => (isNum(x) && isNum(v100[i]) && v100[i] > 0 ? x / v100[i] - 1 : NaN));
  const junkdemand = scoreDir(liqRaw);

  /* --- 4. derivatives basis ---------------------------------------------- */
  let putcall = NaNs(n), basisPct = NaNs(n);
  if (vn30 && fut && Array.isArray(vn30.t) && Array.isArray(fut.t)) {
    const vn30Map = new Map();
    vn30.t.forEach((t, i) => { if (isNum(vn30.c[i])) vn30Map.set(dstr(t), vn30.c[i]); });
    const futDates = fut.t.map(dstr);
    const basis = fut.c.map((x, i) => {
      const base = vn30Map.get(futDates[i]);
      return isNum(base) && base > 0 && isNum(x) ? x / base - 1 : NaN;
    });
    const basisScore = scoreDir(basis, { w: 250, minp: 60 });
    const sMap = new Map(), bMap = new Map();
    futDates.forEach((d, i) => { sMap.set(d, basisScore[i]); bMap.set(d, basis[i]); });
    putcall = ffillOnDates(dates, sMap);
    basisPct = ffillOnDates(dates, bMap);
  }

  /* --- 2 & 3. strength + breadth (weekly VN30 constituents) --------------- */
  const wk = weeklyAggregates(stocks);
  const strength = ffillOnDates(dates, wk.strengthMap);
  const breadth  = ffillOnDates(dates, wk.breadthMap);

  /* --- composite ---------------------------------------------------------- */
  const series = { momentum, strength, breadth, putcall, volatility, safehaven, junkdemand };
  const composite = NaNs(n);
  const coverageArr = NaNs(n);
  let lastMissing = [];
  for (let i = 0; i < n; i++) {
    const r = combineAt(series, i);
    composite[i] = r.score;
    coverageArr[i] = r.coverage;
    if (isNum(r.score)) lastMissing = r.missing;
  }

  /* --- panic -------------------------------------------------------------- */
  const panic = computePanic(c, v);

  /* --- index of usable days ---------------------------------------------- */
  const idx = [];
  for (let i = 0; i < n; i++) if (isNum(composite[i])) idx.push(i);
  if (!idx.length) throw new Error('Không tính được chỉ số tổng hợp — thiếu quá nhiều thành phần.');
  const li = idx[idx.length - 1];

  /* --- context for the verdict ------------------------------------------- */
  const swingLow = (() => {
    const from = Math.max(0, li - 40);
    let m = Infinity;
    for (let i = from; i <= li; i++) if (isNum(c[i])) m = Math.min(m, c[i]);
    return Number.isFinite(m) ? m : NaN;
  })();
  const lo250 = rollMin(c, 250, 60)[li];
  const ma200Slope = isNum(ma200[li]) && li >= 20 && isNum(ma200[li - 20])
    ? ma200[li] / ma200[li - 20] - 1 : NaN;

  const fgAt = k => {
    const j = idx[idx.length - 1 - k];
    return j === undefined ? NaN : composite[j];
  };

  const ctx = {
    last: c[li],
    ma20: ma20[li], ma50: ma50[li], ma125: ma125[li], ma200: ma200[li],
    hi250: panic.hi250[li], lo250, swingLow,
    distMA200: isNum(ma200[li]) && ma200[li] > 0 ? c[li] / ma200[li] - 1 : NaN,
    ma200Falling: isNum(ma200Slope) && ma200Slope < -0.002,
    ma200Rising:  isNum(ma200Slope) && ma200Slope > 0.002,
    aboveMA20: isNum(ma20[li]) && c[li] > ma20[li],
    drawdown: panic.drawdown[li],
    ret10: panic.ret10[li],
    volRatio: panic.volRatio[li],
    score: composite[li],
    fgDelta5: isNum(fgAt(0)) && isNum(fgAt(5)) ? fgAt(0) - fgAt(5) : NaN,
  };

  /* --- base rates --------------------------------------------------------- */
  const rates = baseRates(composite, c);
  const around = baseRatesAround(composite, c, composite[li], 5);

  /* --- allocation + backtest --------------------------------------------- */
  const targets = idx.map(i => {
    const tw = targetWeight(composite[i], panic.score[i], {
      distMA200: isNum(ma200[i]) && ma200[i] > 0 ? c[i] / ma200[i] - 1 : NaN,
      ma200Falling: isNum(ma200[i]) && i >= 20 && isNum(ma200[i - 20]) ? ma200[i] / ma200[i - 20] - 1 < -0.002 : false,
      ma200Rising:  isNum(ma200[i]) && i >= 20 && isNum(ma200[i - 20]) ? ma200[i] / ma200[i - 20] - 1 > 0.002 : false,
    });
    return tw ? tw.weight : NaN;
  });

  const bt = backtest(c, targets, idx);
  const half = Math.floor(idx.length / 2);
  const btFirst = backtestSlice(c, targets, idx, 0, half);
  const btSecond = backtestSlice(c, targets, idx, half, idx.length);

  /* --- confidence --------------------------------------------------------- */
  const confidence = computeConfidence({
    score: composite[li],
    componentScores: COMPONENT_IDS.map(id => series[id][li]),
    coverage: coverageArr[li],
    around,
    backtest: bt.stats,
  });

  /* --- verdict ------------------------------------------------------------ */
  const verdict = buildVerdict({
    score: composite[li],
    panic: panic.score[li],
    ctx,
    coverage: coverageArr[li],
    missing: lastMissing,
    base: around,
    confidence,
  });

  /* --- previous readings -------------------------------------------------- */
  const prevAt = daysBack => {
    const targetDate = new Date(dates[li]);
    targetDate.setUTCDate(targetDate.getUTCDate() - daysBack);
    const key = targetDate.toISOString().slice(0, 10);
    let best = null;
    for (const i of idx) if (dates[i] <= key) best = composite[i]; else break;
    return best;
  };

  /* --- payload ------------------------------------------------------------ */
  const histFrom = Math.max(0, idx.length - 500);
  return {
    updated: dates[li],
    generatedAt: new Date().toISOString(),
    dataQuality: {
      coverage: r2(coverageArr[li]),
      missing: lastMissing,
      stocksUsed: wk.symbolsUsed,
      stocksExpected: VN30.length,
      weeklyBars: wk.weeks.length,
      dailyBars: n,
      firstDate: dates[0],
    },
    score: r1(composite[li]),
    label: labelOf(composite[li]),
    zone: zoneOf(composite[li]).key,
    previous: {
      close: r1(idx.length > 1 ? composite[idx[idx.length - 2]] : NaN),
      week: r1(prevAt(7)),
      month: r1(prevAt(30)),
      year: r1(prevAt(365)),
    },
    vnindex: {
      last: r2(c[li]),
      chg_pct: r2(li > 0 && isNum(c[li - 1]) && c[li - 1] > 0 ? (c[li] / c[li - 1] - 1) * 100 : NaN),
      ma20: r2(ma20[li]), ma50: r2(ma50[li]), ma125: r2(ma125[li]), ma200: r2(ma200[li]),
      hi250: r2(panic.hi250[li]), lo250: r2(lo250),
      drawdown_pct: r2(isNum(panic.drawdown[li]) ? panic.drawdown[li] * 100 : NaN),
      ret10_pct: r2(isNum(panic.ret10[li]) ? panic.ret10[li] * 100 : NaN),
      vol_ratio: r2(panic.volRatio[li]),
      rv20_pct: r2(isNum(panic.rv20[li]) ? panic.rv20[li] * 100 : NaN),
    },
    panic: {
      score: r1(panic.score[li]),
      label: panicLabel(panic.score[li]),
      parts: Object.fromEntries(Object.keys(panic.parts).map(k => [k, r1(panic.parts[k][li])])),
      history: idx.slice(histFrom).map(i => ({ d: dates[i], s: r1(panic.score[i]) })),
    },
    components: COMPONENT_IDS.map(id => ({
      id, name: META[id][0], desc: META[id][1],
      score: r1(lastFinite(series[id])),
      label: labelOf(lastFinite(series[id])),
      available: isNum(series[id][li]),
    })),
    componentHistory: Object.fromEntries(COMPONENT_IDS.map(id =>
      [id, idx.slice(histFrom).map(i => ({ d: dates[i], s: r1(series[id][i]) }))])),
    history: idx.slice(histFrom).map(i => ({ d: dates[i], s: r1(composite[i]), v: r2(c[i]) })),
    verdict,
    baseRates: { buckets: rates, around, horizons: HORIZONS,
                 sampleFrom: dates[idx[0]], sampleTo: dates[li], overlapping: true },
    backtest: {
      full: bt.stats, turnoverPerYear: bt.turnoverPerYear,
      avgExposure: bt.avgExposure, periods: bt.periods,
      firstHalf: btFirst.stats, secondHalf: btSecond.stats,
      splitAt: dates[idx[half]] || null,
      matchedWeight: bt.matchedWeight,
      curve: bt.idx.map((i, k) => ({ d: dates[i], s: r2(bt.strat[k]), b: r2(bt.bench[k]), f: r2(bt.matched[k]) }))
        .filter((_, k) => k % Math.max(1, Math.floor(bt.idx.length / 400)) === 0),
    },
    raw: {
      momentum: momentumRaw, volatility: volRaw, safehaven: shRaw,
      junkdemand: liqRaw, basis: basisPct,
    },
    // Full untruncated series, for research tooling only. `history` above is
    // capped at 500 points for charting; anything that measures the strategy
    // must use these instead or it will silently test a shorter window.
    full: opts.full ? {
      dates: idx.map(i => dates[i]),
      close: idx.map(i => c[i]),
      composite: idx.map(i => composite[i]),
      panic: idx.map(i => panic.score[i]),
      targets,
      components: Object.fromEntries(COMPONENT_IDS.map(id => [id, idx.map(i => series[id][i])])),
    } : undefined,
    detailDates: idx.slice(histFrom).map(i => dates[i]),
    detailSeries: {
      momentum: idx.slice(histFrom).map(i => r2(isNum(momentumRaw[i]) ? momentumRaw[i] * 100 : NaN)),
      volatility: idx.slice(histFrom).map(i => r2(isNum(rv20[i]) ? rv20[i] * 100 : NaN)),
      basis: idx.slice(histFrom).map(i => r2(isNum(basisPct[i]) ? basisPct[i] * 100 : NaN)),
      safehaven: idx.slice(histFrom).map(i => r2(isNum(shRaw[i]) ? shRaw[i] * 100 : NaN)),
      junkdemand: idx.slice(histFrom).map(i => r2(isNum(liqRaw[i]) ? liqRaw[i] * 100 : NaN)),
    },
  };
}

/* -------------------------------------------------- weekly breadth/strength */

function weeklyAggregates(stocks) {
  const bySym = {};
  const weekSet = new Set();
  let symbolsUsed = 0;

  for (const item of stocks) {
    if (!item) continue;
    const [sym, j] = item;
    if (!j || !Array.isArray(j.t) || j.t.length < 30) continue;
    bySym[sym] = j;
    symbolsUsed++;
    j.t.forEach(t => weekSet.add(dstr(t)));
  }

  const weeks = [...weekSet].sort();
  const wi = new Map(weeks.map((d, i) => [d, i]));
  const nHigh = new Array(weeks.length).fill(0);
  const nLow  = new Array(weeks.length).fill(0);
  const nVal  = new Array(weeks.length).fill(0);
  const advV  = new Array(weeks.length).fill(0);
  const decV  = new Array(weeks.length).fill(0);

  for (const sym in bySym) {
    const j = bySym[sym];
    const d = j.t.map(dstr);
    // 52-week extremes INCLUDING the current bar: both are known at the close
    // of that bar, so this is a state descriptor, not look-ahead.
    const h52 = rollMax(j.h, 52, 40);
    const l52 = rollMin(j.l, 52, 40);
    for (let i = 0; i < d.length; i++) {
      const k = wi.get(d[i]);
      if (k === undefined) continue;
      if (isNum(h52[i]) && isNum(l52[i]) && isNum(j.c[i])) {
        nVal[k]++;
        if (j.c[i] >= 0.97 * h52[i]) nHigh[k]++;
        if (j.c[i] <= 1.03 * l52[i]) nLow[k]++;
      }
      if (i > 0 && isNum(j.c[i]) && isNum(j.c[i - 1]) && isNum(j.v[i])) {
        const value = j.c[i] * j.v[i];
        if (j.c[i] > j.c[i - 1]) advV[k] += value;
        else if (j.c[i] < j.c[i - 1]) decV[k] += value;
      }
    }
  }

  // A week covered by too few symbols is noise, not signal.
  const minSymbols = Math.max(10, Math.floor(symbolsUsed * 0.6));
  const strengthRaw = nHigh.map((x, i) => (nVal[i] >= minSymbols ? (x - nLow[i]) / nVal[i] : NaN));
  const breadthBase = advV.map((x, i) => {
    const tot = x + decV[i];
    return nVal[i] >= minSymbols && tot > 0 ? (x - decV[i]) / tot : NaN;
  });
  const breadthRaw = ewmAdjusted(breadthBase, 4);

  const strengthScore = scoreBounded(strengthRaw, 0.45, { w: 156, minp: 52 });
  const breadthScore  = scoreBounded(breadthRaw, 0.35, { w: 156, minp: 52 });

  const strengthMap = new Map(), breadthMap = new Map();
  weeks.forEach((d, i) => { strengthMap.set(d, strengthScore[i]); breadthMap.set(d, breadthScore[i]); });

  return { weeks, strengthMap, breadthMap, symbolsUsed, strengthRaw, breadthRaw };
}

/**
 * Forward-fill a sparse date->value map onto a dense date axis.
 * Values older than `maxStaleDays` are dropped rather than carried forever,
 * so a stalled weekly feed shows up as a missing component (and therefore a
 * coverage warning) instead of a frozen number pretending to be current.
 */
function ffillOnDates(dates, map, maxStaleDays = 21) {
  const keys = [...map.keys()].sort();
  const out = NaNs(dates.length);
  let ki = 0, cur = NaN, curDate = null;
  for (let i = 0; i < dates.length; i++) {
    while (ki < keys.length && keys[ki] <= dates[i]) {
      const val = map.get(keys[ki]);
      if (isNum(val)) { cur = val; curDate = keys[ki]; }
      ki++;
    }
    if (isNum(cur) && curDate) {
      const age = (Date.parse(dates[i]) - Date.parse(curDate)) / 86400000;
      out[i] = age <= maxStaleDays ? cur : NaN;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ exports */

return {
  // constants
  VN30, COMPONENT_IDS, COMPONENT_WEIGHTS, META, ZONES, RF_ANNUAL,
  HORIZONS, BUCKETS, PROFILES, ACTIONS, MIN_COVERAGE, COST_PER_TURN,
  // primitives (exported for tests)
  isNum, clip, mean, piecewise, dstr,
  rollApply, rollMean, rollStd, rollMax, rollMin,
  rollPctPast, rollStdPast, ewmAdjusted,
  scoreDir, scoreBounded, zoneOf, labelOf,
  quantile, forwardStats, combineAt,
  // domain
  computePanic, panicLabel, baseRates, baseRatesAround,
  zoneWeight, targetWeight, profileWeight, backtest, backtestSlice,
  pickAction, buildTranches, buildInvalidation, buildVerdict,
  weeklyAggregates, ffillOnDates, compute,
};

});
