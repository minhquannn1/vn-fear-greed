/* =============================================================================
   Serverless proxy for the DNSE/Entrade chart API.
   Purpose: avoid CORS from the browser, and put a shared CDN cache in front of
   the upstream so 30+ visitors do not become 30x the upstream request volume.

   Hardened vs. v1:
   - symbol allowlist instead of a loose /^[A-Z0-9]+$/ regex, so this cannot be
     used as a general-purpose relay for arbitrary upstream paths
   - explicit upstream timeout (v1 could hang until the platform killed it)
   - one retry on 5xx / network error
   - range sanity checks
   - Vary + immutable-ish caching tuned to the 15-minute quantised keys the
     client sends, plus stale-while-revalidate so a cold upstream never blocks
   ========================================================================== */
'use strict';

const UPSTREAM = 'https://services.entrade.com.vn/chart-api/v2/ohlcs';

const KINDS = new Set(['index', 'stock', 'derivative']);
const RESOLUTIONS = new Set(['1D', '1W', '1M']);

const INDEX_SYMBOLS = new Set(['VNINDEX', 'VN30', 'VN100', 'HNX', 'HNX30', 'UPCOM', 'VNMID', 'VNSML']);
const DERIVATIVE_SYMBOLS = new Set(['VN30F1M', 'VN30F2M', 'VN30F1Q', 'VN30F2Q']);

/* VN30 constituents plus a little headroom for index reshuffles. */
const STOCK_SYMBOLS = new Set([
  'ACB','BCM','BID','BVH','CTG','DGC','FPT','GAS','GVR','HDB','HPG','KDH','LPB',
  'MBB','MSN','MWG','NVL','PDR','PLX','POW','SAB','SHB','SSB','SSI','STB','TCB',
  'TPB','VCB','VHM','VIB','VIC','VJC','VNM','VPB','VRE','BSR','VIX','VND','HCM',
]);

const TIMEOUT_MS = 12000;
const MAX_RANGE_SECONDS = 86400 * 4000; // ~11 years, generous but bounded

function symbolAllowed(kind, symbol) {
  if (kind === 'index') return INDEX_SYMBOLS.has(symbol);
  if (kind === 'derivative') return DERIVATIVE_SYMBOLS.has(symbol);
  return STOCK_SYMBOLS.has(symbol);
}

async function fetchUpstream(url, attempt = 0) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'vn-fear-greed/2.0 (+https://github.com/minhquannn1/vn-fear-greed)',
        Accept: 'application/json',
      },
    });
    clearTimeout(timer);
    if (res.status >= 500 && attempt < 1) return fetchUpstream(url, attempt + 1);
    return res;
  } catch (err) {
    clearTimeout(timer);
    if (attempt < 1) return fetchUpstream(url, attempt + 1);
    throw err;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Vary', 'Accept-Encoding');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const q = req.query || {};
  const kind = String(q.kind || 'index');
  const symbol = String(q.symbol || '').toUpperCase();
  const resolution = String(q.resolution || '1D').toUpperCase();
  const from = String(q.from || '');
  const to = String(q.to || '');

  if (!KINDS.has(kind)) return res.status(400).json({ error: 'invalid kind' });
  if (!RESOLUTIONS.has(resolution)) return res.status(400).json({ error: 'invalid resolution' });
  if (!/^\d{9,11}$/.test(from) || !/^\d{9,11}$/.test(to)) {
    return res.status(400).json({ error: 'from/to must be unix seconds' });
  }
  if (!symbolAllowed(kind, symbol)) {
    return res.status(400).json({ error: 'symbol not allowed for this kind' });
  }

  const f = Number(from), t = Number(to);
  if (!(t > f) || t - f > MAX_RANGE_SECONDS) {
    return res.status(400).json({ error: 'invalid range' });
  }

  const url = `${UPSTREAM}/${kind}?from=${f}&to=${t}&symbol=${encodeURIComponent(symbol)}&resolution=${resolution}`;

  try {
    const upstream = await fetchUpstream(url);
    if (!upstream.ok) {
      return res.status(502).json({ error: 'upstream ' + upstream.status });
    }
    const body = await upstream.json();

    // Client quantises `to` to 15-minute boundaries, so a 15-minute shared cache
    // collapses a burst of visitors into one upstream call. The long SWR window
    // means a temporarily unavailable upstream still serves the last good copy.
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=604800');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).json(body);
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    return res.status(aborted ? 504 : 502).json({
      error: aborted ? 'upstream timeout' : 'upstream error',
      detail: String(err && err.message ? err.message : err),
    });
  }
};
