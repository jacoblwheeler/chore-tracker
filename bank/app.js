'use strict';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ── iOS install banner ────────────────────────────────────────────────────────
(function () {
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = ('standalone' in navigator) && navigator.standalone;
  if (isIos && !isStandalone && !localStorage.getItem('bankBannerDismissed')) {
    const b = document.createElement('div');
    b.className = 'install-banner';
    b.innerHTML = '📲 <strong>Add to Home Screen:</strong> tap Share → "Add to Home Screen" <button onclick="this.parentNode.remove();localStorage.setItem(\'bankBannerDismissed\',1)">✕</button>';
    document.body.prepend(b);
  }
})();

// ── Constants ─────────────────────────────────────────────────────────────────
const ALLOWANCE = 5.00;
const CHORE_GOAL = 10;
const CHILDREN = [
  { id: 'c1', name: 'Thompson', emoji: '🦊', bg: '#1e3a5c' },
  { id: 'c2', name: 'Lillian',  emoji: '🦋', bg: '#2d1e5c' },
];

// Quarter payment dates: Jan 1, Apr 1, Jul 1, Oct 1
// Returns the Date of the most recent quarter payment date on or before `now`
function lastQuarterDate(now) {
  const d = new Date(now);
  const year = d.getFullYear();
  const month = d.getMonth(); // 0-based
  // Quarter starts: 0=Jan, 3=Apr, 6=Jul, 9=Oct
  const starts = [0, 3, 6, 9];
  // Find the latest quarter start <= now
  let bestMonth = 0;
  for (const m of starts) {
    const candidate = new Date(year, m, 1);
    if (candidate <= d) bestMonth = m;
  }
  return new Date(year, bestMonth, 1);
}

function nextQuarterDate(now) {
  const d = new Date(now);
  const year = d.getFullYear();
  const month = d.getMonth();
  const starts = [0, 3, 6, 9];
  for (const m of starts) {
    if (m > month) return new Date(year, m, 1);
  }
  return new Date(year + 1, 0, 1); // next Jan 1
}

function quarterLabel(d) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

// ── ECB Rate ──────────────────────────────────────────────────────────────────
let ecbRate = null;

async function fetchEcbRate() {
  // Check cache (refresh once per day)
  const stored = localStorage.getItem('ecbRate');
  const fetched = localStorage.getItem('ecbRateFetched');
  if (stored && fetched && Date.now() - Number(fetched) < 86400000) {
    ecbRate = parseFloat(stored);
    updateRateLabel();
    return;
  }
  try {
    const url = 'https://data-api.ecb.europa.eu/service/data/FM/B.U2.EUR.4F.KR.DFR.LEV?format=jsondata&lastNObservations=1';
    const res = await fetch(url);
    if (!res.ok) throw new Error();
    const json = await res.json();
    const obs = json.dataSets[0].series['0:0:0:0:0:0:0'].observations;
    const keys = Object.keys(obs).sort((a, b) => Number(a) - Number(b));
    ecbRate = parseFloat(obs[keys[keys.length - 1]][0]);
    localStorage.setItem('ecbRate', ecbRate);
    localStorage.setItem('ecbRateFetched', Date.now());
  } catch {
    ecbRate = parseFloat(localStorage.getItem('ecbRate') || '4.0');
  }
  updateRateLabel();
}

function updateRateLabel() {
  const el = document.getElementById('rateLabel');
  if (el && ecbRate !== null) {
    el.textContent = `ECB rate ${ecbRate.toFixed(2)}% p.a. · interest Jan/Apr/Jul/Oct`;
  }
  const badge = document.getElementById('nextBadge');
  if (badge) {
    const next = nextQuarterDate(Date.now());
    badge.textContent = `Next interest\n${quarterLabel(next)}`;
  }
}

// ── State ─────────────────────────────────────────────────────────────────────
function defaultState() {
  const lastQ = lastQuarterDate(Date.now());
  return {
    accounts: {
      c1: { balance: 0, transactions: [], lastInterestQuarter: lastQ.toISOString() },
      c2: { balance: 0, transactions: [], lastInterestQuarter: lastQ.toISOString() },
    },
    choreState:      { c1: 0, c2: 0 },
    pendingAllowance:{ c1: false, c2: false },
  };
}

function loadState() {
  try { const r = localStorage.getItem('kids_bank_v2'); if (r) return JSON.parse(r); } catch {}
  return defaultState();
}

function saveState() {
  try { localStorage.setItem('kids_bank_v2', JSON.stringify(state)); } catch {}
}

let state = loadState();

// ── Interest on fixed quarter dates ──────────────────────────────────────────
// Interest = ECB rate applied to the average daily balance over the quarter
function computeAverageBalance(transactions, periodStart, periodEnd) {
  // Build daily balance snapshots from period start to end
  // Transactions sorted oldest-first
  const sorted = [...transactions].sort((a, b) => a.ts - b.ts);
  const startMs = periodStart.getTime();
  const endMs   = periodEnd.getTime();

  // Find balance just before period start
  let runningBal = 0;
  for (const tx of sorted) {
    if (tx.ts < startMs) runningBal += tx.amount;
  }
  runningBal = Math.max(0, runningBal);

  // Walk through day by day within the quarter
  const MS_DAY = 86400000;
  const days = Math.round((endMs - startMs) / MS_DAY);
  if (days <= 0) return runningBal;

  let totalBalanceDays = 0;
  let currentTs = startMs;

  // Collect transactions within the period, sorted
  const periodTxs = sorted.filter(tx => tx.ts >= startMs && tx.ts < endMs);
  let txIdx = 0;

  for (let d = 0; d < days; d++) {
    const dayEnd = currentTs + MS_DAY;
    // Apply any transactions that happened before end of this day
    while (txIdx < periodTxs.length && periodTxs[txIdx].ts < dayEnd) {
      runningBal = Math.max(0, runningBal + periodTxs[txIdx].amount);
      txIdx++;
    }
    totalBalanceDays += runningBal;
    currentTs = dayEnd;
  }

  return totalBalanceDays / days;
}

function checkAndPayInterest() {
  if (ecbRate === null) return;
  const now = Date.now();
  const currentLastQ = lastQuarterDate(now);

  CHILDREN.forEach(child => {
    const acc = state.accounts[child.id];
    if (!acc.lastInterestQuarter) {
      acc.lastInterestQuarter = currentLastQ.toISOString();
      return;
    }
    const paidUpTo = new Date(acc.lastInterestQuarter);

    // If we haven't yet paid for the current quarter, pay all missed quarters
    while (paidUpTo < currentLastQ) {
      // The quarter that ended at paidUpTo + next quarter
      const quarterStart = new Date(paidUpTo);
      const quarterEnd   = nextQuarterDate(quarterStart.getTime());

      // Only pay if this quarter has actually ended (i.e. quarterEnd <= now)
      if (quarterEnd.getTime() > now) break;

      const avgBal = computeAverageBalance(acc.transactions, quarterStart, quarterEnd);
      const quarterlyRate = ecbRate / 4 / 100;
      const interest = parseFloat((avgBal * quarterlyRate).toFixed(2));

      if (interest > 0) {
        acc.balance = parseFloat((acc.balance + interest).toFixed(2));
        acc.transactions.unshift({
          id: uid(),
          type: 'interest',
          amount: interest,
          note: `Q interest @ ${ecbRate.toFixed(2)}% ECB (avg €${avgBal.toFixed(2)})`,
          ts: quarterEnd.getTime(),
        });
        showToast(`📈 Interest paid to ${child.name}: +€${interest.toFixed(2)}`);
      }

      // Move forward one quarter
      const y = quarterEnd.getFullYear();
      const m = quarterEnd.getMonth();
      const nexts = [0,3,6,9];
      let nextM = nexts.find(x => x > m);
      if (nextM === undefined) { paidUpTo.setFullYear(y + 1); paidUpTo.setMonth(0); }
      else { paidUpTo.setFullYear(y); paidUpTo.setMonth(nextM); }
      paidUpTo.setDate(1);
    }

    acc.lastInterestQuarter = currentLastQ.toISOString();
  });

  saveState();
}

// ── Chore Sync ────────────────────────────────────────────────────────────────
function syncChoreState() {
  try {
    const raw = localStorage.getItem('chore_tracker_v3');
    if (!raw) return;
    const chores = JSON.parse(raw);
    chores.children.forEach(child => {
      if (state.choreState[child.id] === undefined) return;
      const prev = state.choreState[child.id];
      const curr = child.total;
      if (Math.floor(curr / CHORE_GOAL) > Math.floor(prev / CHORE_GOAL)) {
        state.pendingAllowance[child.id] = true;
      }
      state.choreState[child.id] = curr;
    });
    saveState();
  } catch {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function uid() { return Math.random().toString(36).slice(2, 10); }
function fmt(n) { return '€' + Math.abs(n).toFixed(2); }
function fmtSigned(n) { return (n >= 0 ? '+€' : '-€') + Math.abs(n).toFixed(2); }

function formatDate(ts) {
  const d = new Date(ts);
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 4000);
}

const TX_META = {
  deposit:   { icon: '⬆️', cls: 'deposit',   sign: +1 },
  spend:     { icon: '🛍',  cls: 'spend',     sign: -1 },
  donate:    { icon: '💝',  cls: 'donate',    sign: -1 },
  interest:  { icon: '📈',  cls: 'interest',  sign: +1 },
  allowance: { icon: '🎉',  cls: 'allowance', sign: +1 },
  opening:   { icon: '🏦',  cls: 'opening',   sign: +1 },
};

// ── Active child tab ──────────────────────────────────────────────────────────
let activeChild = CHILDREN[0].id;

// ── Transaction modal ─────────────────────────────────────────────────────────
let txType = 'deposit';

function openTxModal(childId, type) {
  activeChild = childId;
  txType = type || 'deposit';
  const child = CHILDREN.find(c => c.id === childId);
  document.getElementById('txModalTitle').textContent = `${child.name}'s Account`;
  document.getElementById('txAmount').value = '';
  document.getElementById('txNote').value = '';
  document.querySelectorAll('.tx-type-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.type === txType));
  document.getElementById('txModal').classList.remove('hidden');
  setTimeout(() => document.getElementById('txAmount').focus(), 150);
}

function closeTxModal() {
  document.getElementById('txModal').classList.add('hidden');
}

function confirmTx() {
  const amount = parseFloat(document.getElementById('txAmount').value);
  const note   = document.getElementById('txNote').value.trim();
  if (!amount || amount <= 0) { showToast('Please enter a valid amount.'); return; }
  const acc  = state.accounts[activeChild];
  const meta = TX_META[txType];
  const delta = parseFloat((amount * meta.sign).toFixed(2));
  if (meta.sign < 0 && acc.balance + delta < 0) { showToast('Not enough balance!'); return; }
  acc.balance = parseFloat((acc.balance + delta).toFixed(2));
  acc.transactions.unshift({ id: uid(), type: txType, amount: delta, note: note || txType, ts: Date.now() });
  saveState();
  closeTxModal();
  render();
  const child = CHILDREN.find(c => c.id === activeChild);
  showToast(`${meta.icon} ${fmt(amount)} ${meta.sign > 0 ? 'added to' : 'from'} ${child.name}'s account`);
}

// ── Opening balance ───────────────────────────────────────────────────────────
let openingTarget = null;

function openOpeningModal(childId) {
  openingTarget = childId;
  document.getElementById('openingAmount').value = '';
  document.getElementById('openingModal').classList.remove('hidden');
  setTimeout(() => document.getElementById('openingAmount').focus(), 150);
}
function closeOpeningModal() {
  document.getElementById('openingModal').classList.add('hidden');
  openingTarget = null;
}
function confirmOpening() {
  const amount = parseFloat(document.getElementById('openingAmount').value);
  if (isNaN(amount) || amount < 0) { showToast('Please enter a valid amount.'); return; }
  const acc = state.accounts[openingTarget];
  acc.transactions = acc.transactions.filter(tx => tx.type !== 'opening');
  acc.balance = parseFloat(amount.toFixed(2));
  if (amount > 0) acc.transactions.push({ id: uid(), type: 'opening', amount, note: 'Opening balance', ts: Date.now() });
  saveState();
  closeOpeningModal();
  render();
  const child = CHILDREN.find(c => c.id === openingTarget);
  showToast(`🏦 Opening balance set: ${fmt(amount)} for ${child.name}`);
}

// ── Allowance ─────────────────────────────────────────────────────────────────
let allowanceTarget = null;

function openAllowanceModal(childId) {
  allowanceTarget = childId;
  const child = CHILDREN.find(c => c.id === childId);
  document.getElementById('allowanceText').textContent =
    `${child.name} completed ${CHORE_GOAL} chores! Approve their €${ALLOWANCE.toFixed(2)} allowance?`;
  document.getElementById('allowanceModal').classList.remove('hidden');
}
function closeAllowanceModal() {
  document.getElementById('allowanceModal').classList.add('hidden');
  allowanceTarget = null;
}
function confirmAllowance() {
  const acc   = state.accounts[allowanceTarget];
  const child = CHILDREN.find(c => c.id === allowanceTarget);
  acc.balance = parseFloat((acc.balance + ALLOWANCE).toFixed(2));
  acc.transactions.unshift({ id: uid(), type: 'allowance', amount: ALLOWANCE, note: `Allowance — ${CHORE_GOAL} chores`, ts: Date.now() });
  state.pendingAllowance[allowanceTarget] = false;
  saveState();
  closeAllowanceModal();
  render();
  showToast(`🎉 €${ALLOWANCE.toFixed(2)} paid to ${child.name}!`);
}

// ── Remove transaction ────────────────────────────────────────────────────────
function removeTx(childId, txId) {
  const acc = state.accounts[childId];
  const tx  = acc.transactions.find(t => t.id === txId);
  if (!tx) return;
  acc.balance = parseFloat((acc.balance - tx.amount).toFixed(2));
  if (acc.balance < 0) acc.balance = 0;
  acc.transactions = acc.transactions.filter(t => t.id !== txId);
  saveState();
  render();
  showToast('Transaction removed.');
}

// ── Chart ─────────────────────────────────────────────────────────────────────
function drawChart(canvas, transactions) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth || 300;
  const H = 110;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);

  const sorted = [...transactions].sort((a, b) => a.ts - b.ts);
  let points = [{ ts: sorted[0]?.ts || Date.now(), bal: 0 }];
  let running = 0;
  sorted.forEach(tx => {
    running = Math.max(0, parseFloat((running + tx.amount).toFixed(2)));
    points.push({ ts: tx.ts, bal: running });
  });
  points.push({ ts: Date.now(), bal: running });

  if (points.length < 2) {
    ctx.fillStyle = 'rgba(148,180,212,0.4)';
    ctx.font = '12px -apple-system';
    ctx.textAlign = 'center';
    ctx.fillText('No transactions yet', W / 2, H / 2);
    return;
  }

  const minTs  = points[0].ts;
  const maxTs  = points[points.length - 1].ts;
  const maxBal = Math.max(...points.map(p => p.bal), 0.01);
  const pad = { top: 10, right: 10, bottom: 22, left: 44 };
  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;
  const toX = ts  => pad.left + ((ts - minTs) / (maxTs - minTs || 1)) * cw;
  const toY = bal => pad.top  + (1 - bal / maxBal) * ch;

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  [0, 0.5, 1].forEach(f => {
    const y = pad.top + f * ch;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cw, y); ctx.stroke();
  });

  // Y labels
  ctx.fillStyle = 'rgba(148,180,212,0.6)';
  ctx.font = `10px -apple-system`;
  ctx.textAlign = 'right';
  [0, 0.5, 1].forEach(f => {
    const v = maxBal * (1 - f);
    ctx.fillText('€' + (v >= 1000 ? (v/1000).toFixed(1)+'k' : v.toFixed(0)),
                 pad.left - 4, pad.top + f * ch + 4);
  });

  // Area
  const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + ch);
  grad.addColorStop(0, 'rgba(79,156,249,0.3)');
  grad.addColorStop(1, 'rgba(79,156,249,0.02)');
  ctx.beginPath();
  ctx.moveTo(toX(points[0].ts), toY(points[0].bal));
  points.forEach(p => ctx.lineTo(toX(p.ts), toY(p.bal)));
  ctx.lineTo(toX(points[points.length-1].ts), toY(0));
  ctx.lineTo(toX(points[0].ts), toY(0));
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.strokeStyle = '#4f9cf9';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  points.forEach((p, i) => i === 0 ? ctx.moveTo(toX(p.ts), toY(p.bal)) : ctx.lineTo(toX(p.ts), toY(p.bal)));
  ctx.stroke();

  // Last dot
  const last = points[points.length - 1];
  ctx.beginPath();
  ctx.arc(toX(last.ts), toY(last.bal), 4, 0, Math.PI * 2);
  ctx.fillStyle = '#4f9cf9';
  ctx.fill();
  ctx.strokeStyle = '#0b1929';
  ctx.lineWidth = 2;
  ctx.stroke();

  // X labels
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  ctx.fillStyle = 'rgba(148,180,212,0.5)';
  ctx.textAlign = 'left';
  const d0 = new Date(minTs);
  ctx.fillText(`${d0.getDate()} ${months[d0.getMonth()]}`, pad.left, H - 5);
  ctx.textAlign = 'right';
  const d1 = new Date(maxTs);
  ctx.fillText(`${d1.getDate()} ${months[d1.getMonth()]}`, pad.left + cw, H - 5);
}

// ── Running balance for statement ─────────────────────────────────────────────
function buildRunningBalances(transactions) {
  // Go oldest → newest, compute running balance
  const sorted = [...transactions].sort((a, b) => a.ts - b.ts);
  let running = 0;
  const map = {};
  sorted.forEach(tx => {
    running = parseFloat((running + tx.amount).toFixed(2));
    map[tx.id] = Math.max(0, running);
  });
  return map;
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderTabs() {
  const tabs = document.getElementById('accountTabs');
  tabs.innerHTML = '';
  CHILDREN.forEach(child => {
    const acc = state.accounts[child.id];
    const btn = document.createElement('button');
    btn.className = 'account-tab' + (child.id === activeChild ? ' active' : '');
    btn.innerHTML = `
      <div class="tab-avatar" style="background:${child.bg};">${child.emoji}</div>
      <div class="tab-info">
        <div class="tab-name">${child.name}</div>
        <div class="tab-balance">${fmt(acc.balance)}</div>
      </div>`;
    btn.addEventListener('click', () => { activeChild = child.id; render(); });
    tabs.appendChild(btn);
  });
}

function renderMain() {
  const child = CHILDREN.find(c => c.id === activeChild);
  const acc   = state.accounts[activeChild];
  const pending = state.pendingAllowance[activeChild];
  const chores  = state.choreState[activeChild] || 0;
  const inCycle = chores % CHORE_GOAL;

  // Balance display: split euros and cents
  const balStr  = acc.balance.toFixed(2);
  const [euros, cents] = balStr.split('.');

  // Chore row
  const choreRow = pending
    ? `<div class="chore-hero-row">
         <span class="chore-hero-label">🎉 Allowance ready!</span>
         <button class="chore-approve-btn" data-approve="${child.id}">Pay €${ALLOWANCE.toFixed(2)}</button>
       </div>`
    : `<div class="chore-hero-row">
         <span class="chore-hero-label">🧹 ${inCycle}/${CHORE_GOAL}</span>
         <div class="chore-hero-track">
           <div class="chore-hero-fill" style="width:${(inCycle/CHORE_GOAL*100)}%"></div>
         </div>
       </div>`;

  // Running balances for statement
  const runBals = buildRunningBalances(acc.transactions);

  // Statement rows
  const txRows = acc.transactions.length
    ? acc.transactions.slice(0, 20).map(tx => {
        const meta = TX_META[tx.type] || { icon: '💳', cls: 'deposit' };
        const isCr = tx.amount >= 0;
        const runBal = runBals[tx.id];
        return `<div class="tx-row">
          <div class="tx-icon-wrap ${meta.cls}">${meta.icon}</div>
          <div class="tx-body">
            <div class="tx-desc">${tx.note || tx.type}</div>
            <div class="tx-date-str">${formatDate(tx.ts)}</div>
          </div>
          <div class="tx-right">
            <div class="tx-amount ${isCr ? 'cr' : 'dr'}">${fmtSigned(tx.amount)}</div>
            <div class="tx-running-bal">Bal: ${fmt(runBal)}</div>
          </div>
          <button class="tx-remove-btn" data-child="${child.id}" data-tx="${tx.id}">×</button>
        </div>`;
      }).join('')
    : `<div class="empty-state">No transactions yet.<br>Use the buttons above to get started.</div>`;

  // Last interest & next
  const nextQ = nextQuarterDate(Date.now());
  const lastQStr = acc.lastInterestQuarter
    ? quarterLabel(lastQuarterDate(new Date(acc.lastInterestQuarter).getTime()))
    : '—';

  document.getElementById('mainContent').innerHTML = `
    <!-- Hero balance -->
    <div class="hero-card">
      <div class="hero-top">
        <div>
          <div class="hero-account-label">Savings Account</div>
          <div class="hero-name">${child.name}</div>
        </div>
        <div class="hero-avatar" style="background:${child.bg};">${child.emoji}</div>
      </div>
      <div class="hero-balance-label">Available Balance</div>
      <div class="hero-balance">€${euros}<span class="cents">.${cents}</span></div>
      <div class="hero-meta">
        <div class="hero-meta-item">
          <div class="hero-meta-label">Interest rate</div>
          <div class="hero-meta-value">${ecbRate !== null ? ecbRate.toFixed(2) + '%' : '—'} p.a.</div>
        </div>
        <div class="hero-meta-item">
          <div class="hero-meta-label">Last interest</div>
          <div class="hero-meta-value">${lastQStr}</div>
        </div>
        <div class="hero-meta-item">
          <div class="hero-meta-label">Next interest</div>
          <div class="hero-meta-value">${quarterLabel(nextQ)}</div>
        </div>
      </div>
      ${choreRow}
    </div>

    <!-- Quick actions -->
    <div class="quick-actions">
      <button class="quick-btn deposit" data-action="deposit" data-child="${child.id}">
        <div class="quick-icon">⬆️</div>
        <div class="quick-label">Deposit</div>
      </button>
      <button class="quick-btn spend" data-action="spend" data-child="${child.id}">
        <div class="quick-icon">🛍</div>
        <div class="quick-label">Spend</div>
      </button>
      <button class="quick-btn donate" data-action="donate" data-child="${child.id}">
        <div class="quick-icon">💝</div>
        <div class="quick-label">Donate</div>
      </button>
      <button class="quick-btn opening" data-opening="${child.id}">
        <div class="quick-icon">🏦</div>
        <div class="quick-label">Set Opening</div>
      </button>
    </div>

    <!-- Balance chart -->
    <div class="section">
      <div class="section-header">
        <div class="section-title">Balance History</div>
      </div>
      <div class="chart-card">
        <canvas class="balance-chart" id="balChart" style="height:110px;"></canvas>
      </div>
    </div>

    <!-- Statement -->
    <div class="section" style="padding-bottom:0;">
      <div class="section-header">
        <div class="section-title">Statement</div>
      </div>
      <div class="statement-card">${txRows}</div>
    </div>
  `;

  // Draw chart
  requestAnimationFrame(() => {
    const canvas = document.getElementById('balChart');
    if (canvas) drawChart(canvas, acc.transactions);
  });

  // Bind events
  document.querySelectorAll('[data-action]').forEach(btn =>
    btn.addEventListener('click', () => openTxModal(btn.dataset.child, btn.dataset.action)));
  document.querySelectorAll('[data-opening]').forEach(btn =>
    btn.addEventListener('click', () => openOpeningModal(btn.dataset.opening)));
  document.querySelectorAll('[data-approve]').forEach(btn =>
    btn.addEventListener('click', () => openAllowanceModal(btn.dataset.approve)));
  document.querySelectorAll('.tx-remove-btn').forEach(btn =>
    btn.addEventListener('click', () => removeTx(btn.dataset.child, btn.dataset.tx)));
}

function render() {
  renderTabs();
  renderMain();
}

// ── Modal type buttons ────────────────────────────────────────────────────────
document.querySelectorAll('.tx-type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    txType = btn.dataset.type;
    document.querySelectorAll('.tx-type-btn').forEach(b => b.classList.toggle('active', b === btn));
  });
});

// Close modals on overlay tap
['txModal','openingModal','allowanceModal'].forEach(id => {
  document.getElementById(id).addEventListener('click', function(e) {
    if (e.target === this) this.classList.add('hidden');
  });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
syncChoreState();
fetchEcbRate().then(() => {
  checkAndPayInterest();
  render();
});

// Sync chore state periodically
setInterval(() => { syncChoreState(); render(); }, 60000);
