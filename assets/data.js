/* =============================================================================
   VN Fear & Greed Index — DATA LAYER
   Fetching only. Timeouts, retries, bounded concurrency, honest failure counts.

   v1 fired 33 un-timed, un-retried, unbounded parallel requests and swallowed
   every per-symbol failure with `.catch(() => null)`, so a half-broken feed
   produced a confident-looking number. Everything here is designed so that a
   degraded fetch becomes visible data quality metadata instead.
   ========================================================================== */
'use strict';

(function (root, factory) {
  const api = factory(root.FGEngine);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FGData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E) {

const API_PROXY  = '/api/chart';
const API_DIRECT = 'https://services.entrade.com.vn/chart-api/v2/ohlcs';

const TIMEOUT_MS  = 15000;
const RETRIES     = 2;
const CONCURRENCY = 6;

/** History depth, in calendar days. */
const LOOKBACK = {
  daily:  2200,   // ~6y of sessions: enough for 252d percentiles + base rates
  weekly: 1950,   // ~278 weekly bars: enough for 52w extremes + 156w percentile
  future: 1150,   // ~3y of VN30F1M
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url, { timeout = TIMEOUT_MS, retries = RETRIES } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;
    try {
      const res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!ct.includes('json')) throw new Error('Phản hồi không phải JSON (' + ct + ')');
      return await res.json();
    } catch (err) {
      if (timer) clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) await sleep(400 * Math.pow(2, attempt));
    }
  }
  throw new Error(lastErr && lastErr.name === 'AbortError'
    ? 'Quá thời gian chờ: ' + url
    : (lastErr ? lastErr.message : 'unknown') + ' — ' + url);
}

/** Run `jobs` with at most `limit` in flight. Never rejects; returns settled results. */
async function pool(jobs, limit) {
  const results = new Array(jobs.length);
  let next = 0;
  const workers = new Array(Math.min(limit, jobs.length)).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      try { results[i] = { ok: true, value: await jobs[i]() }; }
      catch (e) { results[i] = { ok: false, error: e }; }
    }
  });
  await Promise.all(workers);
  return results;
}

/** Entrade returns 200 with empty arrays for unknown ranges/symbols. */
function isUsable(j, minBars = 5) {
  return !!(j && Array.isArray(j.t) && Array.isArray(j.c) &&
            j.t.length >= minBars && j.t.length === j.c.length);
}

function urlFor(base, kind, params) {
  const qs = new URLSearchParams(params).toString();
  return base === API_PROXY
    ? `${base}?kind=${encodeURIComponent(kind)}&${qs}`
    : `${base}/${kind}?${qs}`;
}

/**
 * Decide which base URL works. The same-origin proxy is preferred (no CORS,
 * shared CDN cache, upstream rate limit protection); direct is the fallback for
 * local development or a static host without the serverless function.
 */
async function pickBase(now) {
  const probe = { from: now - 86400 * 20, to: now, symbol: 'VNINDEX', resolution: '1D' };
  for (const base of [API_PROXY, API_DIRECT]) {
    try {
      const j = await fetchJSON(urlFor(base, 'index', probe), { timeout: 8000, retries: 1 });
      if (isUsable(j, 3)) return base;
    } catch (_) { /* try the next one */ }
  }
  throw new Error('Không kết nối được nguồn dữ liệu (cả proxy nội bộ lẫn API trực tiếp).');
}

/**
 * Fetch everything the engine needs.
 * Returns { data, meta } — meta carries the failure accounting so the UI can
 * show exactly how complete the underlying data was.
 */
async function fetchAll(onProgress) {
  const step = (msg, pct) => { if (typeof onProgress === 'function') onProgress(msg, pct); };

  // Quantise to 15 minutes so proxy/CDN cache keys are shared between visitors.
  const now = Math.floor(Date.now() / 1000 / 900) * 900;
  const fromDaily  = now - 86400 * LOOKBACK.daily;
  const fromWeekly = now - 86400 * LOOKBACK.weekly;
  const fromFuture = now - 86400 * LOOKBACK.future;

  step('Đang dò nguồn dữ liệu…', 5);
  const base = await pickBase(now);

  step('Đang tải VN-Index, VN30 và phái sinh…', 15);
  const core = await pool([
    () => fetchJSON(urlFor(base, 'index', { from: fromDaily, to: now, symbol: 'VNINDEX', resolution: '1D' })),
    () => fetchJSON(urlFor(base, 'index', { from: fromDaily, to: now, symbol: 'VN30', resolution: '1D' })),
    () => fetchJSON(urlFor(base, 'derivative', { from: fromFuture, to: now, symbol: 'VN30F1M', resolution: '1D' })),
  ], 3);

  const [vniR, vn30R, futR] = core;
  if (!vniR.ok || !isUsable(vniR.value, 150)) {
    throw new Error('Không tải được dữ liệu VN-Index: ' +
      (vniR.ok ? 'chuỗi dữ liệu quá ngắn' : vniR.error.message));
  }
  const vni  = vniR.value;
  const vn30 = vn30R.ok && isUsable(vn30R.value, 100) ? vn30R.value : null;
  const fut  = futR.ok  && isUsable(futR.value, 100)  ? futR.value  : null;

  step('Đang tải 30 cổ phiếu VN30…', 35);
  const symbols = E.VN30;
  const jobs = symbols.map(sym => () =>
    fetchJSON(urlFor(base, 'stock', { from: fromWeekly, to: now, symbol: sym, resolution: '1W' })));
  const settled = await pool(jobs, CONCURRENCY);

  const stocks = [];
  const failed = [];
  settled.forEach((r, i) => {
    if (r.ok && isUsable(r.value, 30)) stocks.push([symbols[i], r.value]);
    else failed.push(symbols[i]);
  });

  step('Đang tính toán chỉ số…', 85);

  return {
    data: { vni, vn30, fut, stocks },
    meta: {
      base: base === API_PROXY ? 'proxy' : 'direct',
      stocksOk: stocks.length,
      stocksTotal: symbols.length,
      stocksFailed: failed,
      vn30Ok: !!vn30,
      futOk: !!fut,
      fetchedAt: new Date().toISOString(),
    },
  };
}

return { fetchAll, fetchJSON, pool, pickBase, urlFor, isUsable, API_PROXY, API_DIRECT, LOOKBACK };

});
