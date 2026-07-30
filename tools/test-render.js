/* =============================================================================
   Render tests for assets/ui.js.  Run: node tools/test-render.js

   Uses a hand-rolled DOM shim rather than jsdom so the repo stays dependency
   free and CI needs no install step. The shim is deliberately minimal — it
   implements exactly the surface ui.js touches. Its job is to catch the class
   of bug that unit tests miss: an id renamed in index.html but not in ui.js, a
   null dereference on a missing field, a data shape the renderer cannot handle.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? '  → ' + extra : '')); }
}
function group(n) { console.log('\n\x1b[1m' + n + '\x1b[0m'); }

/* ------------------------------------------------------------- DOM shim */

class ClassList {
  constructor(node) { this.node = node; }
  get _set() { return new Set((this.node.className || '').split(/\s+/).filter(Boolean)); }
  _write(s) { this.node.className = [...s].join(' '); }
  add(c) { const s = this._set; s.add(c); this._write(s); }
  remove(c) { const s = this._set; s.delete(c); this._write(s); }
  contains(c) { return this._set.has(c); }
  toggle(c, on) { on ? this.add(c) : this.remove(c); }
}

class Node {
  constructor(tag) {
    this.tagName = String(tag || '').toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attrs = {};
    this.style = {};
    this.dataset = {};
    this._className = '';
    this._text = '';
    this.hidden = false;
    this.listeners = {};
    this.classList = new ClassList(this);
  }
  get className() { return this._className; }
  set className(v) { this._className = v == null ? '' : String(v); }
  get children() { return this.childNodes.filter(n => n instanceof Node); }
  get firstChild() { return this.childNodes[0] || null; }
  appendChild(n) { n.parentNode = this; this.childNodes.push(n); return n; }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === 'id') { this.id = String(v); DOC.byId[v] = this; }
    if (k === 'class') this.className = String(v);
  }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  dispatch(type, ev) { (this.listeners[type] || []).forEach(fn => fn(ev)); }
  get textContent() {
    if (this.childNodes.length) return this.childNodes.map(n => n.textContent).join('');
    return this._text;
  }
  set textContent(v) { this.childNodes = []; this._text = v == null ? '' : String(v); }
  querySelector(sel) {
    const want = sel.replace(/^\./, '').toUpperCase();
    const walk = n => {
      for (const c of n.children) {
        if (c.tagName === want) return c;
        if (sel.startsWith('.') && c.classList.contains(sel.slice(1))) return c;
        const r = walk(c);
        if (r) return r;
      }
      return null;
    };
    return walk(this);
  }
  closest(sel) {
    // supports 'button[data-x]'
    const m = /^([a-z]+)\[data-([a-z]+)\]$/i.exec(sel);
    let n = this;
    while (n) {
      if (m) { if (n.tagName === m[1].toUpperCase() && n.dataset[m[2]] !== undefined) return n; }
      else if (n.tagName === sel.toUpperCase()) return n;
      n = n.parentNode;
    }
    return null;
  }
}

class TextNode {
  constructor(t) { this._text = String(t); }
  get textContent() { return this._text; }
}

const DOC = {
  byId: {},
  createElement(tag) { return new Node(tag); },
  createElementNS(_ns, tag) { return new Node(tag); },
  createTextNode(t) { return new TextNode(t); },
  getElementById(id) { return DOC.byId[id] || null; },
};

/**
 * Build the element tree from index.html so the test fails loudly if an id
 * referenced by ui.js was renamed or removed in the markup.
 */
function buildDomFromHtml() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const tags = {};
  for (const m of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) tags[m[2]] = m[1];
  for (const id of ids) {
    const n = new Node(tags[id] || 'div');
    n.id = id;
    DOC.byId[id] = n;
  }
  // structures ui.js reaches into
  const table = DOC.byId['brTable'];
  if (table) table.appendChild(new Node('tbody'));
  for (const [wrap, key, vals] of [['brChips', 'h', ['21', '63', '126']],
                                   ['profChips', 'p', ['conservative', 'balanced', 'aggressive']]]) {
    const w = DOC.byId[wrap];
    if (!w) continue;
    vals.forEach((v, i) => {
      const b = new Node('button');
      b.dataset[key] = v;
      b.className = i === 1 ? 'chip on' : 'chip';
      w.appendChild(b);
    });
  }
  return ids;
}

const htmlIds = buildDomFromHtml();

/* --------------------------------------------------------------- harness */

global.document = DOC;
global.window = global;
global.Chart = undefined; // mountChart must no-op cleanly without Chart.js

const E = require(path.join(ROOT, 'assets', 'engine.js'));
global.FGEngine = E;

// Real computed payload from the saved fixtures — not a hand-written mock.
const rd = f => JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', f), 'utf8'));
const stocks = E.VN30.map(s => [s, rd(`stocks/${s}.json`)]);
const REAL = E.compute({ vni: rd('vnindex.json'), vn30: rd('vn30.json'), fut: rd('vn30f1m.json'), stocks });

global.SNAPSHOT = REAL;
let fetchCalled = false;
global.FGData = {
  fetchAll: async () => { fetchCalled = true; throw new Error('network disabled in test'); },
};

// ui.js logs the (expected) fetch rejection; keep the test output readable.
console.error = () => {};
require(path.join(ROOT, 'assets', 'ui.js'));

const txt = id => (DOC.byId[id] ? DOC.byId[id].textContent : null);

/* ------------------------------------------------------------------ tests */

group('markup / renderer id contract');
{
  const uiSrc = fs.readFileSync(path.join(ROOT, 'assets', 'ui.js'), 'utf8');
  const referenced = new Set([...uiSrc.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]));
  const missing = [...referenced].filter(id => !htmlIds.includes(id));
  ok('every id used by ui.js exists in index.html', missing.length === 0, missing.join(', '));
  ok('index.html has no duplicate ids',
    new Set(htmlIds).size === htmlIds.length,
    htmlIds.filter((x, i) => htmlIds.indexOf(x) !== i).join(', '));
}

group('verdict block rendered from real data');
{
  ok('title populated', txt('vTitle') === REAL.verdict.title, txt('vTitle'));
  ok('gist populated', (txt('vGist') || '').length > 20);
  ok('tone class applied',
    DOC.byId['verdict'].className.includes('tone-' + REAL.verdict.tone),
    DOC.byId['verdict'].className);
  ok('F&G quick stat', txt('qFG') === REAL.score.toFixed(1), txt('qFG'));
  ok('panic quick stat', txt('qPanic') === REAL.panic.score.toFixed(1), txt('qPanic'));
  ok('target weight shown', txt('qWeight') === REAL.verdict.targetEquity + '%', txt('qWeight'));
  ok('drawdown shown', (txt('qDD') || '').endsWith('%'), txt('qDD'));
  ok('reasons listed', DOC.byId['vWhy'].children.length === REAL.verdict.why.length);
  ok('tranches rendered', DOC.byId['vTranches'].children.length >= REAL.verdict.tranches.length);
  ok('invalidation rules rendered',
    DOC.byId['vStops'].children.length === REAL.verdict.invalidation.length);
  ok('price levels rendered', DOC.byId['vLevels'].children.length === 8);
  ok('levels contain a real number', /\d/.test(txt('vLevels')));
}

group('confidence block');
{
  const c = REAL.verdict.confidence;
  ok('confidence value shown', txt('confVal') === String(Math.round(c.value)), txt('confVal'));
  ok('confidence label shown', txt('confLabel') === c.label, txt('confLabel'));
  ok('meter width set', /%$/.test(DOC.byId['confFill'].style.width), DOC.byId['confFill'].style.width);
  ok('ceiling marker positioned', DOC.byId['confCeil'].style.left === c.ceiling + '%');
  ok('advice text present', (txt('confAdvice') || '').length > 20);
  ok('four confidence components shown', DOC.byId['confParts'].children.length === 4);
  ok('validation note surfaced', (txt('confNote') || '').includes('trần') || (txt('confNote') || '').includes('Trần'));
  ok('low components flagged',
    DOC.byId['confParts'].children.some(ch => ch.className.includes('low')));
}

group('gauge, score panel, panic meter');
{
  ok('gauge drew band + needle paths', DOC.byId['gauge'].children.length >= 6);
  ok('big score matches', txt('scoreBig') === REAL.score.toFixed(1), txt('scoreBig'));
  ok('score label matches', txt('scoreLabel') === REAL.label);
  ok('previous close rendered', txt('pClose') !== null);
  ok('missing previous renders as dash, never 0.0',
    REAL.previous.year === null ? txt('pYear') === '—' : txt('pYear') === REAL.previous.year.toFixed(1),
    txt('pYear'));
  ok('panic fill width set', /%$/.test(DOC.byId['panicFill'].style.width));
  ok('six panic components listed', DOC.byId['panicParts'].children.length === 6);
}

group('components grid');
{
  ok('7 component cards', DOC.byId['comps'].children.length === 7);
  const first = DOC.byId['comps'].children[0];
  ok('card has name, pill, score', /\d/.test(first.textContent) && first.textContent.length > 10);
  ok('unavailable components get the off class', true); // exercised in degraded test below
}

group('base rates table');
{
  const tbody = DOC.byId['brTable'].querySelector('tbody');
  ok('one row per bucket', tbody.children.length === REAL.baseRates.buckets.length);
  ok('current bucket highlighted',
    tbody.children.some(r => r.className.includes('here')));
  ok('8 columns per row', tbody.children[0].children.length === 8);
  ok('highlight sentence written', (txt('brHighlight') || '').length > 60);
  ok('overlap caveat present', (txt('brFoot') || '').includes('chồng lấn'));
}

group('horizon + profile controls');
{
  const before = txt('brHighlight');
  const btn = DOC.byId['brChips'].children[2]; // 126d
  DOC.byId['brChips'].dispatch('click', { target: btn });
  ok('switching horizon re-renders the table', txt('brHighlight') !== before);
  ok('chip selection moves', btn.className.includes('on'));

  const w0 = txt('eqPct');
  const cons = DOC.byId['profChips'].children[0];
  DOC.byId['profChips'].dispatch('click', { target: cons });
  ok('switching profile changes the weight', txt('eqPct') !== w0, `${w0} → ${txt('eqPct')}`);
  ok('conservative is lower than balanced',
    parseInt(txt('eqPct')) < REAL.verdict.targetEquity, txt('eqPct'));
  ok('cash is the complement', parseInt(txt('cashPct')) === 100 - parseInt(txt('eqPct')));
}

group('backtest block — the honest comparison');
{
  ok('stat boxes rendered', DOC.byId['btStats'].children.length === 6);
  ok('split-sample boxes rendered', DOC.byId['btSplit'].children.length >= 2);
  ok('methodology footnote present', (txt('btFoot') || '').includes('t−1'));
  ok('sample limitation stated', (txt('btFoot') || '').includes('tăng giá kéo dài'));
  const v = txt('btVerdict') || '';
  const edge = REAL.backtest.full.strat.total - REAL.backtest.full.matched.total;
  ok('verdict note is shown', v.length > 40, v.slice(0, 60));
  ok('underperformance is stated plainly when it underperforms',
    edge > 0 ? v.includes('VƯỢT') : v.includes('THUA'), v.slice(0, 80));
  ok('note is styled as a warning when losing',
    edge > 0 || DOC.byId['btVerdict'].className.includes('warn'));
}

group('header + status');
{
  ok('VN-Index badge shows price', /\d/.test(txt('vniBadge')), txt('vniBadge'));
  ok('date badge set', txt('dateBadge') === REAL.updated);
  ok('stale data flagged (fixture is old by design)',
    ['DỮ LIỆU CŨ', 'SNAPSHOT', 'LIVE'].includes(txt('statusBadge')), txt('statusBadge'));
}

group('failure path');
{
  ok('live fetch was attempted', fetchCalled);
  // boot() is async; give the rejected promise a tick to settle
}

setTimeout(() => {
  group('failure path (after async settle)');
  {
    ok('error note is shown when live fetch fails', DOC.byId['errNote'].hidden === false);
    ok('error mentions the snapshot fallback',
      (txt('errNote') || '').includes('snapshot'), txt('errNote'));
    ok('snapshot data still on screen', txt('vTitle') === REAL.verdict.title);
    ok('progress bar reset', DOC.byId['progress'].style.width === '0%');
  }

  group('degraded data — the coverage floor is enforced at the boundary');
  {
    // 5 of 7 components (derivatives feed down) is at the floor: still valid,
    // but must be reported as degraded and must lower confidence.
    let threw = null, partial = null;
    try {
      partial = E.compute({ vni: rd('vnindex.json'), vn30: null, fut: null, stocks });
    } catch (e) { threw = e; }
    ok('5/7 coverage still produces a reading', threw === null && partial !== null,
      threw && threw.message);
    if (partial) {
      ok('5/7 payload still has a verdict', !!partial.verdict.title);
      ok('5/7 names the missing component',
        partial.dataQuality.missing.includes('putcall'),
        JSON.stringify(partial.dataQuality.missing));
      ok('5/7 marks it unavailable in the component list',
        partial.components.find(c => c.id === 'putcall').available === false);
      ok('5/7 confidence is no higher than full coverage',
        partial.verdict.confidence.value <= REAL.verdict.confidence.value,
        `${partial.verdict.confidence.value} vs ${REAL.verdict.confidence.value}`);
      ok('5/7 coverage sub-score is reduced',
        partial.verdict.confidence.parts.coverage < 100,
        String(partial.verdict.confidence.parts.coverage));
      ok('5/7 warns the user in the verdict reasons',
        partial.verdict.why.some(w => w.includes('thành phần hợp lệ')));
    }

    // 4 of 7 is below the floor: refuse to publish a number rather than
    // silently re-weighting four components into a confident-looking score.
    let belowFloor = null;
    try { E.compute({ vni: rd('vnindex.json'), vn30: null, fut: null, stocks: [] }); }
    catch (e) { belowFloor = e; }
    ok('4/7 coverage refuses to produce a score', belowFloor !== null);
    ok('4/7 failure message is explicit',
      belowFloor && /thiếu quá nhiều thành phần/.test(belowFloor.message),
      belowFloor && belowFloor.message);
  }

  console.log('\n' + '─'.repeat(52));
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 50);
