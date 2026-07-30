/* =============================================================================
   VN Fear & Greed Index — UI
   Rendering only. Every dynamic string goes in via textContent, never innerHTML,
   so nothing that arrives from the network can execute.
   ========================================================================== */
'use strict';

(function (E, D) {

/* --------------------------------------------------------------- utilities */

const $ = id => document.getElementById(id);
const isNum = x => typeof x === 'number' && Number.isFinite(x);
const dash = '—';

const fmt = (x, d = 1) => (isNum(x) ? x.toFixed(d) : dash);
const fmtSigned = (x, d = 1) => (isNum(x) ? (x > 0 ? '+' : '') + x.toFixed(d) : dash);
const fmtPct = (x, d = 1) => (isNum(x) ? fmtSigned(x, d) + '%' : dash);
const fmtInt = x => (isNum(x) ? Math.round(x).toLocaleString('vi-VN') : dash);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
function setText(id, text) { const n = $(id); if (n) n.textContent = text; }

const ZONE_COLOR = {
  'extreme-fear': '#0b1220', fear: '#41586e', neutral: '#7b8ea1',
  greed: '#0891b2', 'extreme-greed': '#155e75', unknown: '#8fa0b3',
};
const zoneColor = s => ZONE_COLOR[E.zoneOf(s).key] || ZONE_COLOR.unknown;

const charts = {};
function mountChart(id, config) {
  const canvas = $(id);
  if (!canvas || typeof Chart === 'undefined') return;
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(canvas.getContext('2d'), config);
}

const BASE_CHART = {
  responsive: true, maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: { legend: { display: false } },
  elements: { point: { radius: 0 } },
};
const AXIS = {
  grid: { color: '#eef2f6', drawTicks: false },
  border: { display: false },
  ticks: { color: '#8fa0b3', font: { family: 'IBM Plex Mono', size: 9 }, maxRotation: 0, autoSkipPadding: 24 },
};

/* -------------------------------------------------------------- the gauge */

function renderGauge(score) {
  const svg = $('gauge');
  if (!svg) return;
  clear(svg);
  const NS = 'http://www.w3.org/2000/svg';
  const cx = 200, cy = 200, rOuter = 150, rInner = 112;
  const bands = [
    [0, 25, ZONE_COLOR['extreme-fear']], [25, 45, ZONE_COLOR.fear],
    [45, 55, ZONE_COLOR.neutral], [55, 75, ZONE_COLOR.greed],
    [75, 100, ZONE_COLOR['extreme-greed']],
  ];
  const ang = v => Math.PI * (1 - v / 100);
  const pt = (r, a) => [cx + r * Math.cos(a), cy - r * Math.sin(a)];

  for (const [a0, a1, color] of bands) {
    const s = ang(a0), e = ang(a1);
    const [x1, y1] = pt(rOuter, s), [x2, y2] = pt(rOuter, e);
    const [x3, y3] = pt(rInner, e), [x4, y4] = pt(rInner, s);
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', `M${x1},${y1} A${rOuter},${rOuter} 0 0 1 ${x2},${y2} L${x3},${y3} A${rInner},${rInner} 0 0 0 ${x4},${y4} Z`);
    p.setAttribute('fill', color);
    svg.appendChild(p);
  }

  for (const v of [0, 25, 45, 55, 75, 100]) {
    const [tx, ty] = pt(rOuter + 16, ang(v));
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', tx); t.setAttribute('y', ty + 4);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('font-family', 'IBM Plex Mono, monospace');
    t.setAttribute('font-size', '11'); t.setAttribute('fill', '#8fa0b3');
    t.textContent = String(v);
    svg.appendChild(t);
  }

  if (!isNum(score)) return;

  // The pointer lives inside the coloured band only — it never crosses the
  // dial hole, so it cannot collide with the score readout at any width.
  const a = ang(Math.max(0, Math.min(100, score)));
  const [tipX, tipY] = pt(rOuter - 7, a);
  const rBase = rInner + 4;
  const [b1x, b1y] = pt(rBase, a - 0.055);
  const [b2x, b2y] = pt(rBase, a + 0.055);
  const needle = document.createElementNS(NS, 'path');
  needle.setAttribute('d', `M${b1x},${b1y} L${tipX},${tipY} L${b2x},${b2y} Z`);
  needle.setAttribute('fill', '#fff');
  needle.setAttribute('stroke', '#0b1220');
  needle.setAttribute('stroke-width', '2.5');
  needle.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(needle);
}

/* ------------------------------------------------------------- the verdict */

const PANIC_PART_LABEL = {
  drawdown: 'Chiết khấu từ đỉnh', belowTrend: 'Dưới xu hướng MA200',
  volumeClimax: 'Vỡ khối lượng', downDays: 'Mật độ phiên giảm',
  velocity: 'Tốc độ giảm', volatility: 'Biến động thực',
};

const LEVEL_LABEL = {
  last: 'Đóng cửa', ma20: 'MA20', ma50: 'MA50', ma125: 'MA125',
  ma200: 'MA200', hi250: 'Đỉnh 250P', lo250: 'Đáy 250P', swingLow: 'Đáy gần nhất',
};

const CONF_PART_LABEL = {
  coverage: 'Dữ liệu đầy đủ', agreement: 'Thành phần đồng thuận',
  evidence: 'Bằng chứng lịch sử', extremity: 'Độ cực trị của chỉ số',
};
const CONF_COLOR = v => (v >= 70 ? '#0f766e' : v >= 50 ? '#0891b2' : v >= 30 ? '#b45309' : '#b91c1c');

function renderConfidence(v) {
  const c = v.confidence;
  const box = $('confBox');
  if (!c || !isNum(c.value)) { if (box) box.style.display = 'none'; return; }
  if (box) box.style.display = '';

  setText('confVal', fmt(c.value, 0));
  const lab = $('confLabel');
  lab.textContent = c.label || dash;
  lab.style.color = CONF_COLOR(c.value);
  $('confVal').style.color = CONF_COLOR(c.value);

  const fill = $('confFill');
  fill.style.width = Math.max(1, Math.min(100, c.value)) + '%';
  fill.style.background = CONF_COLOR(c.value);
  const ceil = $('confCeil');
  if (isNum(c.ceiling)) { ceil.style.left = c.ceiling + '%'; ceil.style.display = ''; }
  else ceil.style.display = 'none';

  setText('confAdvice', v.confidenceAdvice || '');
  $('confAdvice').style.color = CONF_COLOR(c.value);

  const parts = $('confParts');
  clear(parts);
  Object.keys(CONF_PART_LABEL).forEach(k => {
    const val = c.parts ? c.parts[k] : null;
    const chip = el('span', 'cp' + (isNum(val) && val < 45 ? ' low' : ''));
    chip.appendChild(document.createTextNode(CONF_PART_LABEL[k] + ' '));
    chip.appendChild(el('b', null, fmt(val, 0)));
    parts.appendChild(chip);
  });

  const bits = [];
  if (c.validationNote) bits.push(c.validationNote);
  if (c.drags && c.drags.length) bits.push('Yếu tố kéo giảm độ tin cậy: ' + c.drags.join(', ') + '.');
  if (isNum(c.ceiling)) bits.push(`Trần tin cậy ${c.ceiling}% (vạch đỏ) được đặt tự động từ kết quả kiểm định lịch sử — không phải con số chọn tuỳ ý.`);
  setText('confNote', bits.join(' '));
}

function renderVerdict(d) {
  const v = d.verdict;
  const root = $('verdict');
  root.className = 'verdict tone-' + (v.tone || 'neutral');

  setText('vTitle', v.title);
  setText('vGist', v.gist);

  setText('qFG', fmt(d.score));
  setText('qFGs', d.label || dash);
  setText('qPanic', fmt(d.panic && d.panic.score));
  setText('qPanics', (d.panic && d.panic.label) || dash);
  setText('qWeight', isNum(v.targetEquity) ? v.targetEquity + '%' : dash);
  setText('qDD', isNum(d.vnindex.drawdown_pct) ? fmt(d.vnindex.drawdown_pct, 1) + '%' : dash);

  renderConfidence(v);

  const why = $('vWhy');
  clear(why);
  (v.why || []).forEach(w => why.appendChild(el('li', null, w)));

  const levels = $('vLevels');
  clear(levels);
  Object.keys(LEVEL_LABEL).forEach(k => {
    const val = v.levels ? v.levels[k] : null;
    const box = el('div', 'lv');
    box.appendChild(el('div', 't', LEVEL_LABEL[k]));
    box.appendChild(el('div', 'v', fmtInt(val)));
    levels.appendChild(box);
  });

  const isSell = v.tone === 'sell' || v.tone === 'lean-sell';
  setText('vPlanTitle', isSell ? 'Kế hoạch hạ tỷ trọng' : 'Kế hoạch chia lô giải ngân');

  const tr = $('vTranches');
  clear(tr);
  if (!v.tranches || !v.tranches.length) {
    tr.appendChild(el('div', 'td', 'Không có hành động nào được đề xuất ở vùng này. Giữ nguyên danh mục hiện tại.'));
  } else {
    const gapWord = isSell ? 'phần cần bán' : 'phần còn thiếu';
    const head = el('div', 'td');
    head.style.marginBottom = '10px';
    head.textContent = `Các tỷ lệ dưới đây tính trên ${gapWord} — tức khoảng cách giữa tỷ trọng hiện tại của bạn và mức đề xuất ${isNum(v.targetEquity) ? v.targetEquity + '%' : ''}.`;
    tr.appendChild(head);
    v.tranches.forEach((t, i) => {
      const row = el('div', 'tranche');
      const no = el('div', 'tno');
      no.appendChild(el('b', null, t.pct + '%'));
      no.appendChild(el('i', null, 'lô ' + (i + 1)));
      const body = el('div', 'tbody');
      body.appendChild(el('div', 'tw', t.when));
      body.appendChild(el('div', 'td', t.detail));
      row.appendChild(no); row.appendChild(body);
      tr.appendChild(row);
    });
  }

  const stops = $('vStops');
  clear(stops);
  (v.invalidation || []).forEach(s => stops.appendChild(el('li', null, s)));
}

/* ---------------------------------------------------------------- header */

function renderHeader(d, mode) {
  const vni = d.vnindex || {};
  const badge = $('vniBadge');
  badge.textContent = 'VN-INDEX ' + fmtInt(vni.last) + '  ' + fmtPct(vni.chg_pct, 2);
  badge.className = 'badge ' + (isNum(vni.chg_pct) ? (vni.chg_pct >= 0 ? 'up' : 'down') : '');
  setText('dateBadge', d.updated || dash);

  const status = $('statusBadge');
  const ageDays = d.updated ? (Date.now() - Date.parse(d.updated + 'T00:00:00Z')) / 86400000 : Infinity;
  // 8 days, not 5: Tet and other clustered holidays legitimately close the
  // exchange for over a week, and flagging that as a problem trains people to
  // ignore the badge.
  if (mode === 'offline') { status.textContent = 'BẢN OFFLINE'; status.className = 'badge'; }
  else if (ageDays > 8) { status.textContent = 'PHIÊN GẦN NHẤT ' + d.updated; status.className = 'badge stale'; }
  else { status.textContent = 'LIVE'; status.className = 'badge live'; }

  setText('footLeft', 'Phiên gần nhất ' + (d.updated || dash) + ' · ' +
    (mode === 'offline' ? 'bản nhúng sẵn, không kết nối' : 'tính trực tiếp trên trình duyệt'));
}

function renderQuality(d, meta) {
  const note = $('qualityNote');
  const q = d.dataQuality || {};
  const msgs = [];
  if (isNum(q.coverage) && q.coverage < 1) {
    const names = (q.missing || []).map(m => (E.META[m] ? E.META[m][0] : m)).join(', ');
    msgs.push(`Chỉ ${Math.round(q.coverage * 7)}/7 thành phần hợp lệ (thiếu: ${names}). Trọng số đã được chia lại cho các thành phần còn lại — độ tin cậy của chỉ số thấp hơn bình thường.`);
  }
  if (meta && isNum(meta.stocksOk) && meta.stocksOk < meta.stocksTotal) {
    msgs.push(`Chỉ tải được ${meta.stocksOk}/${meta.stocksTotal} cổ phiếu VN30${meta.stocksFailed && meta.stocksFailed.length ? ' (lỗi: ' + meta.stocksFailed.join(', ') + ')' : ''}.`);
  }
  if (meta && meta.futOk === false) msgs.push('Không tải được dữ liệu phái sinh VN30F1M — thành phần tâm lý phái sinh bị loại.');
  if (msgs.length) { note.textContent = msgs.join(' '); note.hidden = false; }
  else note.hidden = true;
}

/* ------------------------------------------------------------ gauge panel */

function renderScorePanel(d) {
  renderGauge(d.score);
  const big = $('scoreBig');
  big.textContent = fmt(d.score);
  big.style.color = zoneColor(d.score);
  const lab = $('scoreLabel');
  lab.textContent = d.label || dash;
  lab.style.color = zoneColor(d.score);

  const p = d.previous || {};
  setText('pClose', fmt(p.close));
  setText('pWeek', fmt(p.week));
  setText('pMonth', fmt(p.month));
  setText('pYear', fmt(p.year));

  const panic = d.panic || {};
  setText('panicVal', isNum(panic.score) ? fmt(panic.score) + ' / 100 · ' + panic.label : dash);
  const fill = $('panicFill');
  fill.style.width = (isNum(panic.score) ? Math.max(1, Math.min(100, panic.score)) : 0) + '%';

  const parts = $('panicParts');
  clear(parts);
  Object.keys(PANIC_PART_LABEL).forEach(k => {
    const val = panic.parts ? panic.parts[k] : null;
    const row = el('div', 'pp');
    row.appendChild(el('span', null, PANIC_PART_LABEL[k]));
    row.appendChild(el('b', null, fmt(val, 0)));
    parts.appendChild(row);
  });
}

/* ---------------------------------------------------------------- charts */

function renderHistory(d) {
  const h = d.history || [];
  if (!h.length) return;
  mountChart('histChart', {
    type: 'line',
    data: {
      labels: h.map(x => x.d),
      datasets: [
        { label: 'F&G', data: h.map(x => x.s), borderColor: '#0891b2', borderWidth: 1.8,
          yAxisID: 'y', tension: .25, fill: false },
        { label: 'VN-Index', data: h.map(x => x.v), borderColor: '#0b1220', borderWidth: 1.2,
          yAxisID: 'y1', tension: .25, fill: false, borderDash: [3, 3] },
      ],
    },
    options: {
      ...BASE_CHART,
      plugins: {
        legend: { display: true, labels: { boxWidth: 10, font: { family: 'IBM Plex Mono', size: 10 }, color: '#5b6b7c' } },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmt(c.parsed.y, c.datasetIndex ? 0 : 1)}` } },
      },
      scales: {
        x: { ...AXIS, ticks: { ...AXIS.ticks, maxTicksLimit: 7 } },
        y: { ...AXIS, position: 'left', min: 0, max: 100, ticks: { ...AXIS.ticks, stepSize: 25 } },
        y1: { ...AXIS, position: 'right', grid: { display: false } },
      },
    },
  });

  const p = (d.panic && d.panic.history) || [];
  if (p.length) {
    mountChart('panicChart', {
      type: 'line',
      data: {
        labels: p.map(x => x.d),
        datasets: [{
          data: p.map(x => x.s), borderColor: '#b4442c', borderWidth: 1.4,
          backgroundColor: 'rgba(180,68,44,.10)', fill: true, tension: .25,
        }],
      },
      options: {
        ...BASE_CHART,
        scales: {
          x: { ...AXIS, ticks: { ...AXIS.ticks, maxTicksLimit: 6 } },
          y: { ...AXIS, min: 0, max: 100, ticks: { ...AXIS.ticks, stepSize: 50 } },
        },
      },
    });
  }
}

/* ------------------------------------------------------------ components */

function renderComponents(d) {
  const wrap = $('comps');
  clear(wrap);
  (d.components || []).forEach(c => {
    const box = el('div', 'comp' + (c.available === false ? ' off' : ''));

    const top = el('div', 'top');
    top.appendChild(el('h3', null, c.name));
    const pill = el('span', 'pill', c.available === false ? 'THIẾU DỮ LIỆU' : (c.label || dash));
    pill.style.color = c.available === false ? '#8fa0b3' : zoneColor(c.score);
    top.appendChild(pill);
    box.appendChild(top);

    box.appendChild(el('div', 'desc', c.desc));

    const row = el('div', 'row');
    const sc = el('div', 'score', fmt(c.score));
    sc.style.color = c.available === false ? '#8fa0b3' : zoneColor(c.score);
    row.appendChild(sc);
    // Fixed-size bitmap + responsive:false. A responsive sparkline inside a
    // flex row has no stable parent height to measure, which is what made the
    // big charts grow without bound.
    const cv = document.createElement('canvas');
    cv.className = 'spark';
    cv.id = 'spark-' + c.id;
    cv.width = 300;
    cv.height = 80;
    row.appendChild(cv);
    box.appendChild(row);

    const bar = el('div', 'bar');
    const b = el('b'); b.style.width = (isNum(c.score) ? Math.max(0, Math.min(100, c.score)) : 0) + '%';
    b.style.background = zoneColor(c.score);
    const i = el('i'); i.style.left = '50%';
    bar.appendChild(b); bar.appendChild(i);
    box.appendChild(bar);

    wrap.appendChild(box);
  });

  (d.components || []).forEach(c => {
    const hist = (d.componentHistory && d.componentHistory[c.id]) || [];
    if (!hist.length) return;
    mountChart('spark-' + c.id, {
      type: 'line',
      data: {
        labels: hist.map(x => x.d),
        datasets: [{
          data: hist.map(x => x.s), borderColor: zoneColor(c.score), borderWidth: 1.3,
          tension: .3, fill: false, spanGaps: true,
        }],
      },
      options: {
        ...BASE_CHART,
        responsive: false,
        animation: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false, min: 0, max: 100 } },
      },
    });
  });
}

/* ------------------------------------------------------------- base rates */

let brHorizon = 63;

function renderBaseRates(d) {
  const br = d.baseRates;
  const tbody = $('brTable').querySelector('tbody');
  clear(tbody);
  if (!br || !br.buckets) return;

  const cur = d.score;
  br.buckets.forEach(b => {
    const s = b.stats ? b.stats[brHorizon] : null;
    const tr = document.createElement('tr');
    if (isNum(cur) && cur >= b.lo && cur < b.hi) tr.className = 'here';

    const cells = [
      b.label,
      s ? fmtInt(s.n) : dash,
      s ? fmtPct(s.median) : dash,
      s ? fmtPct(s.mean) : dash,
      s ? fmt(s.hit, 0) + '%' : dash,
      s ? fmtPct(s.p25) : dash,
      s ? fmtPct(s.worst) : dash,
      s ? fmtPct(s.best) : dash,
    ];
    cells.forEach((text, i) => {
      const td = el('td', null, text);
      if (s && (i === 2 || i === 3 || i === 5 || i === 6 || i === 7)) {
        const raw = [null, null, s.median, s.mean, null, s.p25, s.worst, s.best][i];
        if (isNum(raw)) td.className = raw >= 0 ? 'pos' : 'neg';
      }
      if (s && i === 1 && s.n < 20) td.className = 'thin';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });

  const a = br.around;
  const hl = $('brHighlight');
  if (a && a.stats && a.stats[brHorizon] && a.stats[brHorizon].n >= 5) {
    const s = a.stats[brHorizon];
    const hLabel = (E.HORIZONS.find(h => h.d === brHorizon) || {}).label || '';
    hl.textContent =
      `Chỉ số hiện tại ${fmt(d.score)}. Trong quá khứ (${br.sampleFrom} → ${br.sampleTo}), những phiên có chỉ số nằm trong khoảng ${a.lo}–${a.hi} — ${fmtInt(s.n)} phiên chồng lấn — VN-Index sau ${hLabel} có trung vị ${fmtPct(s.median)}, tỷ lệ dương ${fmt(s.hit, 0)}%, phân vị 25 ở ${fmtPct(s.p25)} và trường hợp xấu nhất ${fmtPct(s.worst)}.`;
    hl.hidden = false;
  } else {
    hl.textContent = 'Chưa đủ dữ liệu lịch sử quanh mức chỉ số hiện tại để đưa ra tỷ lệ cơ sở đáng tin cậy.';
    hl.hidden = false;
  }

  setText('brFoot',
    `Mẫu: ${br.sampleFrom} → ${br.sampleTo}. Các cửa sổ quan sát chồng lấn nhau, nên "số phiên" phản ánh độ dày dữ liệu chứ không phải số lần thử độc lập — hãy hiểu vài trăm phiên trong cùng một vùng có thể chỉ tương ứng vài đợt thị trường thật sự. Dữ liệu chưa bao gồm các chu kỳ trước 2020.`);
}

/* ------------------------------------------------- allocation + backtest */

let profile = 'balanced';

function renderAllocation(d) {
  const v = d.verdict;
  const w = v.profiles ? v.profiles[profile] : v.targetEquity;
  const eq = isNum(w) ? w : 0;
  setText('eqPct', (isNum(w) ? w : dash) + ' % cổ phiếu');
  setText('cashPct', (isNum(w) ? 100 - w : dash) + ' % tiền mặt');
  $('eqBar').style.width = eq + '%';

  const notes = $('wNotes');
  clear(notes);
  const all = [`Tỷ trọng thô từ vùng F&G ${fmt(d.score)}: ${fmt(E.zoneWeight(d.score), 0)}%.`]
    .concat(v.weightNotes || []);
  if (profile !== 'balanced') {
    all.push(`Hồ sơ ${E.PROFILES[profile].label}: nhân ${E.PROFILES[profile].mult}× và giới hạn trần ${E.PROFILES[profile].cap}%.`);
  }
  all.forEach(n => notes.appendChild(el('li', null, n)));
}

function statBox(label, value, sub) {
  const box = document.createElement('div');
  box.appendChild(el('div', 't', label));
  box.appendChild(el('b', null, value));
  if (sub) box.appendChild(el('div', 't', sub));
  return box;
}

function renderBacktest(d) {
  const bt = d.backtest;
  if (!bt) return;
  const curve = bt.curve || [];
  if (curve.length) {
    mountChart('btChart', {
      type: 'line',
      data: {
        labels: curve.map(x => x.d),
        datasets: [
          { label: 'Chiến lược', data: curve.map(x => x.s), borderColor: '#0891b2', borderWidth: 1.8, tension: .2, fill: false },
          { label: 'Mua & giữ', data: curve.map(x => x.b), borderColor: '#0b1220', borderWidth: 1.2, tension: .2, fill: false, borderDash: [3, 3] },
          { label: `Cố định ${fmt(bt.matchedWeight, 0)}% (cùng tỷ trọng TB)`, data: curve.map(x => x.f), borderColor: '#b4442c', borderWidth: 1.4, tension: .2, fill: false, borderDash: [5, 3] },
        ],
      },
      options: {
        ...BASE_CHART,
        plugins: {
          legend: { display: true, labels: { boxWidth: 10, font: { family: 'IBM Plex Mono', size: 10 }, color: '#5b6b7c' } },
          tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmt(c.parsed.y, 2)}×` } },
        },
        scales: { x: { ...AXIS, ticks: { ...AXIS.ticks, maxTicksLimit: 7 } }, y: AXIS },
      },
    });
  }

  const f = bt.full || {};

  // The honest headline: strategy vs a fixed weight holding the same average
  // amount of equity. That comparison isolates the timing decision, and it is
  // the one that decides the confidence ceiling elsewhere on the page.
  const verdictNote = $('btVerdict');
  if (verdictNote && f.strat && f.matched) {
    const edge = isNum(f.strat.total) && isNum(f.matched.total) ? f.strat.total - f.matched.total : null;
    if (isNum(edge)) {
      verdictNote.className = 'note ' + (edge > 0 ? '' : 'warn');
      verdictNote.textContent = edge > 0
        ? `Kết quả: quy tắc định thời điểm theo F&G VƯỢT danh mục cố định cùng tỷ trọng trung bình ${fmt(bt.matchedWeight, 0)}% là ${fmtSigned(edge)} điểm phần trăm trong mẫu này. Vẫn nên đọc kèm phần chia đôi mẫu bên dưới.`
        : `Kết quả trung thực: quy tắc định thời điểm theo F&G THUA danh mục cố định cùng tỷ trọng trung bình ${fmt(bt.matchedWeight, 0)}% tới ${fmt(Math.abs(edge), 1)} điểm phần trăm, và thua mua-giữ ${fmt(Math.abs((f.strat.total || 0) - (f.bench.total || 0)), 1)} điểm. Nói cách khác: trong dữ liệu hiện có, việc dùng chỉ số này để tăng/giảm tỷ trọng KHÔNG tạo thêm giá trị — phần lớn chênh lệch đến từ việc giữ tỷ trọng thấp trong một thị trường đi lên. Đây là lý do trần độ tin cậy ở phần kết luận bị giới hạn ở ${(d.verdict.confidence && d.verdict.confidence.ceiling) || '—'}%.`;
      verdictNote.hidden = false;
    }
  }

  const box = $('btStats');
  clear(box);
  const rows = [
    ['Tổng lợi nhuận', 'total', '%'],
    ['CAGR', 'cagr', '%'],
    ['Sụt giảm tối đa', 'maxdd', '%'],
    ['Sharpe', 'sharpe', ''],
    ['Calmar', 'calmar', ''],
  ];
  rows.forEach(([label, key, unit]) => {
    const s = f.strat ? f.strat[key] : null;
    const b = f.bench ? f.bench[key] : null;
    const m = f.matched ? f.matched[key] : null;
    const show = x => (isNum(x) ? (unit === '%' ? fmtSigned(x) : fmt(x, 2)) + unit : dash);
    box.appendChild(statBox(label, show(s),
      `mua & giữ ${show(b)} · cố định ${show(m)}`));
  });
  box.appendChild(statBox('Tỷ trọng CP trung bình',
    isNum(bt.avgExposure) ? fmt(bt.avgExposure, 0) + '%' : dash,
    'vòng quay ' + (isNum(bt.turnoverPerYear) ? fmt(bt.turnoverPerYear, 1) + '×/năm' : dash)));

  const split = $('btSplit');
  clear(split);
  const halves = [['Nửa đầu mẫu', bt.firstHalf], ['Nửa sau mẫu', bt.secondHalf]];
  halves.forEach(([label, h]) => {
    if (!h || !h.strat) return;
    split.appendChild(statBox(label + ' — chiến lược',
      isNum(h.strat.total) ? fmtSigned(h.strat.total) + '%' : dash,
      'mua & giữ: ' + (isNum(h.bench && h.bench.total) ? fmtSigned(h.bench.total) + '%' : dash)));
  });
  if (bt.splitAt) split.appendChild(statBox('Điểm chia mẫu', bt.splitAt, `${fmtInt(bt.periods)} phiên`));

  setText('btFoot',
    `Cách tính: tỷ trọng áp cho phiên t là tỷ trọng suy ra từ tín hiệu đóng cửa phiên t−1 (không nhìn trước); phí giao dịch 15 điểm cơ bản tính trên phần tỷ trọng thay đổi; tiền mặt hưởng lãi suất phi rủi ro 4,8%/năm; mọi phép chuẩn hoá chỉ dùng dữ liệu quá khứ. Mốc so sánh "cố định ${fmt(bt.matchedWeight, 0)}%" giữ đúng tỷ trọng cổ phiếu trung bình của chiến lược nhưng KHÔNG định thời điểm — chênh lệch giữa hai đường chính là giá trị thật (hoặc thiệt hại thật) của việc định thời điểm. ` +
    `Hạn chế phải nói rõ: mẫu chỉ dài ${fmtInt(bt.periods)} phiên và bị chi phối bởi một thị trường tăng giá kéo dài, nên kết quả này chưa đủ để kết luận dứt khoát quy tắc sai — nhưng cũng hoàn toàn không đủ để tin rằng nó đúng. Bộ quy tắc được thiết kế sau khi lịch sử đã xảy ra, vì vậy hãy đối chiếu nửa đầu với nửa sau mẫu: chênh lệch lớn là dấu hiệu tối ưu quá đà.`);
}

/* ------------------------------------------------------------------ render */

let current = null;

function render(d, mode, meta) {
  current = d;
  try {
    renderHeader(d, mode);
    renderQuality(d, meta);
    renderVerdict(d);
    renderScorePanel(d);
    renderHistory(d);
    renderComponents(d);
    renderBaseRates(d);
    renderAllocation(d);
    renderBacktest(d);
  } catch (err) {
    showError('Lỗi khi hiển thị dữ liệu: ' + (err && err.message ? err.message : String(err)));
    if (typeof console !== 'undefined') console.error(err);
  }
}

function showError(msg) {
  const n = $('errNote');
  setText('errText', msg);
  n.hidden = false;
}
function hideError() { $('errNote').hidden = true; }

function progress(pct) {
  const bar = $('progress');
  if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
}

/* --------------------------------------------------------------- controls */

$('brChips').addEventListener('click', e => {
  const btn = e.target.closest('button[data-h]');
  if (!btn) return;
  brHorizon = Number(btn.dataset.h);
  [...$('brChips').children].forEach(c => c.classList.toggle('on', c === btn));
  if (current) renderBaseRates(current);
});

$('profChips').addEventListener('click', e => {
  const btn = e.target.closest('button[data-p]');
  if (!btn) return;
  profile = btn.dataset.p;
  [...$('profChips').children].forEach(c => c.classList.toggle('on', c === btn));
  if (current) renderAllocation(current);
});

/* ------------------------------------------------------------------- boot */

/**
 * There is deliberately no embedded snapshot. Either the page shows numbers it
 * computed from the live feed moments ago, or it shows nothing and says why.
 * A stale fallback that looks identical to live data is worse than an error:
 * it invites someone to act on last week's market.
 *
 * The one exception is the portable bundle from tools/build-standalone.js,
 * which injects window.SNAPSHOT and window.FG_OFFLINE and is clearly labelled.
 */
async function load() {
  hideError();
  progress(5);
  const badge = $('statusBadge');
  if (badge) { badge.textContent = 'Đang tải…'; badge.className = 'badge'; }

  try {
    const { data, meta } = await D.fetchAll((msg, pct) => {
      progress(pct);
      if (badge) { badge.textContent = msg; badge.className = 'badge'; }
    });
    progress(92);
    render(E.compute(data), 'live', meta);
    progress(100);
    setTimeout(() => progress(0), 600);
  } catch (err) {
    progress(0);
    const msg = err && err.message ? err.message : String(err);
    showError(`Không tải được dữ liệu thị trường: ${msg}. Trang này không có bản dự phòng — sẽ không hiển thị số liệu cũ để tránh gây nhầm lẫn.`);
    setText('vTitle', 'CHƯA CÓ DỮ LIỆU');
    setText('vGist', 'Không thể đưa ra kết luận khi chưa tải được dữ liệu thị trường. Đừng hành động dựa trên trang này lúc này.');
    if (badge) { badge.textContent = 'LỖI'; badge.className = 'badge stale'; }
    if (typeof console !== 'undefined') console.error(err);
  }
}

const retry = $('retryBtn');
if (retry) retry.addEventListener('click', () => load());

(function boot() {
  if (typeof window !== 'undefined' && window.FG_OFFLINE && window.SNAPSHOT) {
    render(window.SNAPSHOT, 'offline', null);
    progress(0);
    return;
  }
  load();
})();

})(window.FGEngine, window.FGData);
