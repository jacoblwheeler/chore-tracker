'use strict';

// ── Service Worker ────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ── iOS install banner ────────────────────────────────────────────────────────
(function () {
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = ('standalone' in navigator) && navigator.standalone;
  const dismissed = localStorage.getItem('installBannerDismissed');
  if (isIos && !isStandalone && !dismissed) {
    document.getElementById('installBanner').classList.remove('hidden');
  }
})();

function dismissBanner() {
  document.getElementById('installBanner').classList.add('hidden');
  localStorage.setItem('installBannerDismissed', '1');
}

// ── Config ────────────────────────────────────────────────────────────────────
const CHORES = [
  { id: 'bed',    label: 'Make bed',         icon: '🛏' },
  { id: 'room',   label: 'Clean room',       icon: '✨' },
  { id: 'dishes', label: 'Help with dishes', icon: '🍽' },
];

const GOAL = 10;

const AVATAR_EMOJIS = [
  '😀','😄','😎','🤩','🥳','😇','🤠','🦊','🐱','🐶',
  '🐼','🐨','🐸','🦁','🐯','🦄','🐙','🦋','🌟','⚡',
  '🍕','🍦','🎮','🎨','🏆','🚀','🎸','🌈','💎','🔥',
];

const AVATAR_BG = [
  { bg: '#E6F1FB', color: '#0C447C' },
  { bg: '#EEEDFE', color: '#3C3489' },
  { bg: '#E1F5EE', color: '#085041' },
  { bg: '#FAEEDA', color: '#633806' },
  { bg: '#FDE8F0', color: '#7C1040' },
  { bg: '#FFF3E0', color: '#7C4000' },
];

// ── State ─────────────────────────────────────────────────────────────────────
function defaultState() {
  return {
    children: [
      { id: 'c1', name: 'Thompson', emoji: '🦊', bgIdx: 0, total: 0, history: [] },
      { id: 'c2', name: 'Lillian',  emoji: '🦋', bgIdx: 1, total: 0, history: [] },
    ]
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem('chore_tracker_v3');
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return defaultState();
}

function saveState() {
  try { localStorage.setItem('chore_tracker_v3', JSON.stringify(state)); } catch (e) {}
}

let state = loadState();

// ── Avatar modal ──────────────────────────────────────────────────────────────
let avatarTargetId = null;

function openAvatarModal(childId) {
  avatarTargetId = childId;
  const child = state.children.find(c => c.id === childId);
  const grid = document.getElementById('emojiGrid');
  grid.innerHTML = '';
  AVATAR_EMOJIS.forEach(em => {
    const btn = document.createElement('button');
    btn.className = 'emoji-option' + (em === child.emoji ? ' selected' : '');
    btn.textContent = em;
    btn.addEventListener('click', () => pickEmoji(em));
    grid.appendChild(btn);
  });
  document.getElementById('avatarModal').classList.remove('hidden');
}

function closeAvatarModal() {
  document.getElementById('avatarModal').classList.add('hidden');
  avatarTargetId = null;
}

function pickEmoji(em) {
  if (!avatarTargetId) return;
  const child = state.children.find(c => c.id === avatarTargetId);
  child.emoji = em;
  saveState();
  closeAvatarModal();
  render();
}

// Close modal on overlay click
document.getElementById('avatarModal').addEventListener('click', function (e) {
  if (e.target === this) closeAvatarModal();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatDate(ts) {
  const d = new Date(ts);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}, ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 4000);
}

function popCard(childId) {
  const card = document.querySelector(`[data-child="${childId}"]`);
  if (card) { card.classList.remove('popped'); void card.offsetWidth; card.classList.add('popped'); }
}

// ── Actions ───────────────────────────────────────────────────────────────────
function logChore(childId, choreId) {
  const child = state.children.find(c => c.id === childId);
  const chore = CHORES.find(c => c.id === choreId);
  child.total += 1;
  child.history.unshift({ label: chore.label, icon: chore.icon, ts: Date.now() });
  if (child.history.length > 10) child.history.pop();
  saveState();
  render();
  popCard(childId);
  if (child.total >= GOAL && child.total % GOAL === 0)
    setTimeout(() => showToast('🎉 ' + child.name + ' hit ' + child.total + ' chores — time to pay up!'), 300);
}

function logOther(childId) {
  const input = document.querySelector(`.other-input[data-child="${childId}"]`);
  if (!input) return;
  const label = input.value.trim();
  if (!label) return;
  const child = state.children.find(c => c.id === childId);
  child.total += 1;
  child.history.unshift({ label, icon: '📝', ts: Date.now() });
  if (child.history.length > 10) child.history.pop();
  saveState();
  render();
  popCard(childId);
  if (child.total >= GOAL && child.total % GOAL === 0)
    setTimeout(() => showToast('🎉 ' + child.name + ' hit ' + child.total + ' chores — time to pay up!'), 300);
}

function removeEntry(childId, idx) {
  const child = state.children.find(c => c.id === childId);
  if (!child || child.history[idx].isPay) return;
  child.history.splice(idx, 1);
  if (child.total > 0) child.total -= 1;
  saveState();
  render();
  showToast('Chore removed.');
}

function payAllowance(childId) {
  const child = state.children.find(c => c.id === childId);
  if (child.total < GOAL) return;
  const paid = Math.floor(child.total / GOAL) * GOAL;
  child.total -= paid;
  child.history.unshift({ label: 'Allowance paid (−' + paid + ' chores)', icon: '💸', ts: Date.now(), isPay: true });
  if (child.history.length > 10) child.history.pop();
  saveState();
  render();
  showToast('💸 Paid! ' + paid + ' chores deducted from ' + child.name + '.');
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  const grid = document.getElementById('grid');
  const scrollY = window.scrollY;
  grid.innerHTML = '';

  state.children.forEach(child => {
    const av = AVATAR_BG[child.bgIdx % AVATAR_BG.length];
    const inCycle = child.total % GOAL;
    const progress = Math.min((inCycle === 0 && child.total >= GOAL ? GOAL : inCycle) / GOAL * 100, 100);
    const remaining = inCycle === 0 && child.total >= GOAL ? 0 : GOAL - inCycle;
    const isReady = child.total >= GOAL;

    const card = document.createElement('div');
    card.className = 'child-card' + (isReady ? ' ready' : '');
    card.setAttribute('data-child', child.id);

    const historyHTML = child.history.length ? `
      <div class="history-section">
        <div class="section-label">Recent</div>
        ${child.history.slice(0, 6).map((h, i) => `
          <div class="history-item">
            <span class="history-item-label${h.isPay ? ' pay' : ''}">${h.icon} ${h.label}</span>
            <span class="history-item-time">${formatDate(h.ts)}</span>
            ${!h.isPay
              ? `<button class="history-item-remove" data-child="${child.id}" data-idx="${i}" title="Remove">×</button>`
              : `<span style="width:26px;flex-shrink:0;"></span>`}
          </div>
        `).join('')}
      </div>
    ` : '';

    card.innerHTML = `
      <div class="child-header">
        <button class="avatar-btn" style="background:${av.bg};" data-avatar="${child.id}" title="Change avatar">
          <span style="line-height:1;">${child.emoji}</span>
          <span class="avatar-edit-hint">✏️</span>
        </button>
        <div class="child-name">${child.name}</div>
      </div>

      <div class="progress-section">
        <div class="progress-row">
          <span class="progress-count">${child.total}</span>
          <div class="progress-meta">
            ${isReady
              ? '<span class="ready-label">Ready to pay! 🎉</span>'
              : `<span>${remaining} to go</span>`}
          </div>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width:${progress}%"></div>
        </div>
      </div>

      <div class="section-label">Log a chore</div>
      <div class="chores-list">
        ${CHORES.map(ch => `
          <button class="chore-btn" data-child="${child.id}" data-chore="${ch.id}">
            <span class="chore-icon">${ch.icon}</span>
            <span class="chore-label">${ch.label}</span>
            <span class="chore-plus">+</span>
          </button>
        `).join('')}
        <div class="other-row">
          <span class="other-icon">📝</span>
          <input class="other-input" type="text" placeholder="Other chore…" maxlength="40" data-child="${child.id}" />
          <button class="other-submit" data-other="${child.id}" disabled>+</button>
        </div>
      </div>

      <button class="pay-btn ${isReady ? 'active' : 'inactive'}" data-pay="${child.id}" ${!isReady ? 'disabled' : ''}>
        ${isReady ? '💸 Pay allowance (' + child.total + ' chores)' : 'Need ' + remaining + ' more chores'}
      </button>

      ${historyHTML}
    `;

    grid.appendChild(card);
  });

  // ── Bind events ──
  grid.querySelectorAll('.chore-btn').forEach(btn =>
    btn.addEventListener('click', () => logChore(btn.dataset.child, btn.dataset.chore)));

  grid.querySelectorAll('[data-pay]').forEach(btn =>
    btn.addEventListener('click', () => payAllowance(btn.dataset.pay)));

  grid.querySelectorAll('.history-item-remove').forEach(btn =>
    btn.addEventListener('click', () => removeEntry(btn.dataset.child, parseInt(btn.dataset.idx))));

  grid.querySelectorAll('.other-input').forEach(input => {
    const btn = input.closest('.other-row').querySelector('.other-submit');
    input.addEventListener('input', () => { btn.disabled = !input.value.trim(); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && input.value.trim()) logOther(input.dataset.child); });
  });

  grid.querySelectorAll('[data-other]').forEach(btn =>
    btn.addEventListener('click', () => logOther(btn.dataset.other)));

  grid.querySelectorAll('[data-avatar]').forEach(btn =>
    btn.addEventListener('click', () => openAvatarModal(btn.dataset.avatar)));

  window.scrollTo(0, scrollY);
}

render();
