// app.js — Main application logic

const BASE = '/n8n-scheduler';
const CONFIG_KEY = 'n8n_scheduler_config';
const DB_NAME = 'n8n-scheduler-db';
const DB_VERSION = 1;
const STORE_NAME = 'config';

// ── Default config ────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  webhookUrl: '',
  formUrl: '',
  schedule: {
    type: 'interval',
    minutes: 60,
    time: '09:00',
    days: [1, 2, 3, 4, 5],
    iso: null,
  },
  enabled: false,
  lastRun: null,
  lastRunStatus: null,
};

// ── State ─────────────────────────────────────────────────────────────────────

let config = { ...DEFAULT_CONFIG };
let swRegistration = null;
let pollInterval = null;

// ── IndexedDB (for Service Worker access) ─────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ── Config persistence ────────────────────────────────────────────────────────

function loadConfig() {
  try {
    const stored = localStorage.getItem(CONFIG_KEY);
    if (stored) config = { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
  } catch (_) {}
}

async function saveConfig() {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    await dbSet('config', config);
  } catch (_) {}
}

// ── Service Worker registration ───────────────────────────────────────────────

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    swRegistration = await navigator.serviceWorker.register(BASE + '/sw.js', {
      scope: BASE + '/',
    });

    // Listen for messages from SW (webhook results)
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'WEBHOOK_RESULT') {
        onWebhookResult(event.data.success, event.data.error, event.data.time);
      }
    });

    await registerPeriodicSync();
    updateSyncBadge(true);
  } catch (err) {
    console.warn('SW registration failed:', err);
    updateSyncBadge(false);
  }
}

async function registerPeriodicSync() {
  if (!swRegistration || !('periodicSync' in swRegistration)) {
    updateSyncBadge(false);
    return;
  }
  try {
    const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (status.state === 'granted') {
      const minInterval = Scheduler.computeMinInterval(config.schedule);
      await swRegistration.periodicSync.register('webhook-trigger', { minInterval });
      updateSyncBadge(true);
    } else {
      updateSyncBadge(false);
    }
  } catch (_) {
    updateSyncBadge(false);
  }
}

// ── Notification permission ───────────────────────────────────────────────────

async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    updateNotifBadge('unsupported');
    return;
  }
  if (Notification.permission === 'granted') {
    updateNotifBadge('granted');
    return;
  }
  if (Notification.permission !== 'denied') {
    const result = await Notification.requestPermission();
    updateNotifBadge(result);
  } else {
    updateNotifBadge('denied');
  }
}

// ── Main polling loop ─────────────────────────────────────────────────────────

function startPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(checkAndFire, 30 * 1000);
}

async function checkAndFire() {
  if (!config.enabled || !config.webhookUrl) return;
  if (Scheduler.shouldFireNow(config.schedule, config.lastRun)) {
    await fireWebhook();
  }
  updateNextRun();
}

// ── Missed-run catch-up on page load ──────────────────────────────────────────

async function catchUpMissedRun() {
  if (!config.enabled || !config.webhookUrl) return;
  if (Scheduler.hasMissedRun(config.schedule, config.lastRun)) {
    showToast('Firing missed scheduled run…', 'info');
    await fireWebhook(true);
  }
}

// ── Webhook firing ────────────────────────────────────────────────────────────

async function fireWebhook(isCatchUp = false) {
  const url = config.webhookUrl;
  if (!url) return;

  setFiringState(true);
  const now = new Date().toISOString();
  let success = false;
  let errorMsg = '';

  try {
    const res = await fetch(url, { method: 'POST', mode: 'cors' });
    success = res.ok;
    if (!success) errorMsg = `HTTP ${res.status}`;
  } catch (err) {
    errorMsg = err.message || 'Network error';
  }

  onWebhookResult(success, errorMsg, now, isCatchUp);
  setFiringState(false);
}

function onWebhookResult(success, errorMsg, time, isCatchUp = false) {
  config.lastRun = time;
  config.lastRunStatus = success ? 'success' : 'failure';
  saveConfig();
  updateStatusPanel();

  if (success) {
    showToast(isCatchUp ? 'Catch-up run succeeded' : 'Webhook triggered successfully', 'success');
    if (Notification.permission === 'granted') {
      new Notification('Webhook triggered', {
        body: `Fired at ${new Date(time).toLocaleTimeString()}`,
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="%236c63ff"/><text x="32" y="44" font-size="36" text-anchor="middle" fill="white">n</text></svg>',
      });
    }
  } else {
    showToast(`Webhook failed: ${errorMsg}`, 'error');
    if (Notification.permission === 'granted') {
      new Notification('Webhook failed', {
        body: errorMsg || 'Unknown error',
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="%23e53e3e"/><text x="32" y="44" font-size="36" text-anchor="middle" fill="white">!</text></svg>',
      });
    }
  }
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function updateStatusPanel() {
  const lastRunEl = document.getElementById('last-run');
  const lastRunStatusEl = document.getElementById('last-run-status');

  if (config.lastRun) {
    lastRunEl.textContent = new Date(config.lastRun).toLocaleString();
    lastRunStatusEl.textContent = config.lastRunStatus === 'success' ? '✓' : '✗';
    lastRunStatusEl.className = 'status-icon ' + (config.lastRunStatus === 'success' ? 'success' : 'failure');
  } else {
    lastRunEl.textContent = 'Never';
    lastRunStatusEl.textContent = '';
    lastRunStatusEl.className = 'status-icon';
  }

  updateNextRun();
}

function updateNextRun() {
  const nextEl = document.getElementById('next-run');
  if (!config.enabled) {
    nextEl.textContent = 'Disabled';
    return;
  }
  const next = Scheduler.nextRunTime(config.schedule, config.lastRun);
  nextEl.textContent = next ? next.toLocaleString() : '—';
}

function updateSyncBadge(supported) {
  const el = document.getElementById('sync-badge');
  if (!el) return;
  el.textContent = supported ? 'Background sync: On' : 'Background sync: Off (tab must stay open)';
  el.className = 'badge ' + (supported ? 'badge-on' : 'badge-off');
}

function updateNotifBadge(state) {
  const el = document.getElementById('notif-badge');
  if (!el) return;
  const labels = {
    granted: 'Notifications: Enabled',
    denied: 'Notifications: Blocked',
    default: 'Notifications: Not set',
    unsupported: 'Notifications: Not supported',
  };
  el.textContent = labels[state] || 'Notifications: Unknown';
  el.className = 'badge ' + (state === 'granted' ? 'badge-on' : 'badge-off');
  el.onclick = state !== 'granted' && state !== 'denied' ? requestNotificationPermission : null;
}

function setFiringState(firing) {
  const btn = document.getElementById('fire-now-btn');
  if (!btn) return;
  btn.disabled = firing;
  btn.textContent = firing ? 'Firing…' : 'Fire Now';
}

function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.classList.add('toast-visible'), 10);
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// ── Schedule UI ───────────────────────────────────────────────────────────────

function populateScheduleUI() {
  const s = config.schedule;

  // Schedule type radio
  const radios = document.querySelectorAll('input[name="schedule-type"]');
  radios.forEach((r) => {
    r.checked = r.value === s.type;
  });
  showScheduleFields(s.type);

  // Interval
  const minutesEl = document.getElementById('interval-minutes');
  if (minutesEl) minutesEl.value = s.minutes || 60;

  // Weekly time
  const timeEl = document.getElementById('weekly-time');
  if (timeEl) timeEl.value = s.time || '09:00';

  // Days of week
  const dayBtns = document.querySelectorAll('.day-chip');
  dayBtns.forEach((btn) => {
    const d = parseInt(btn.dataset.day, 10);
    btn.classList.toggle('active', (s.days || []).includes(d));
  });

  // Once
  const onceEl = document.getElementById('once-datetime');
  if (onceEl && s.iso) onceEl.value = s.iso.slice(0, 16);

  // Webhook URL
  const urlEl = document.getElementById('webhook-url');
  if (urlEl) urlEl.value = config.webhookUrl || '';

  // Form URL
  const formEl = document.getElementById('form-url');
  if (formEl) formEl.value = config.formUrl || '';

  // Enabled toggle
  const enabledEl = document.getElementById('enabled-toggle');
  if (enabledEl) enabledEl.checked = !!config.enabled;

  // iframe
  updateFormIframe();
}

function showScheduleFields(type) {
  ['interval', 'weekly', 'once'].forEach((t) => {
    const el = document.getElementById(`fields-${t}`);
    if (el) el.hidden = t !== type;
  });
}

function updateFormIframe() {
  const iframe = document.getElementById('n8n-form-frame');
  const placeholder = document.getElementById('form-placeholder');
  if (!iframe || !placeholder) return;

  if (config.formUrl) {
    iframe.src = config.formUrl;
    iframe.hidden = false;
    placeholder.hidden = true;
  } else {
    iframe.hidden = true;
    placeholder.hidden = false;
  }
}

// ── Settings save ─────────────────────────────────────────────────────────────

async function saveSettings() {
  const urlEl = document.getElementById('webhook-url');
  const formUrlEl = document.getElementById('form-url');
  const enabledEl = document.getElementById('enabled-toggle');

  config.webhookUrl = urlEl ? urlEl.value.trim() : config.webhookUrl;
  config.formUrl = formUrlEl ? formUrlEl.value.trim() : config.formUrl;
  config.enabled = enabledEl ? enabledEl.checked : config.enabled;

  // Schedule type
  const typeEl = document.querySelector('input[name="schedule-type"]:checked');
  if (typeEl) config.schedule.type = typeEl.value;

  if (config.schedule.type === 'interval') {
    const m = parseInt(document.getElementById('interval-minutes')?.value, 10);
    config.schedule.minutes = isNaN(m) || m < 1 ? 60 : m;
  }

  if (config.schedule.type === 'weekly') {
    config.schedule.time = document.getElementById('weekly-time')?.value || '09:00';
    config.schedule.days = [];
    document.querySelectorAll('.day-chip.active').forEach((btn) => {
      config.schedule.days.push(parseInt(btn.dataset.day, 10));
    });
    if (config.schedule.days.length === 0) config.schedule.days = [1, 2, 3, 4, 5];
  }

  if (config.schedule.type === 'once') {
    const dtEl = document.getElementById('once-datetime');
    config.schedule.iso = dtEl ? new Date(dtEl.value).toISOString() : null;
  }

  await saveConfig();
  await registerPeriodicSync();
  updateStatusPanel();
  updateFormIframe();
  showToast('Settings saved', 'success');
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function initTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach((p) => p.hidden = true);
      const panel = document.getElementById(tab.dataset.panel);
      if (panel) panel.hidden = false;
    });
  });
}

// ── Event listeners ───────────────────────────────────────────────────────────

function initEventListeners() {
  // Schedule type radios
  document.querySelectorAll('input[name="schedule-type"]').forEach((r) => {
    r.addEventListener('change', () => showScheduleFields(r.value));
  });

  // Day chips
  document.querySelectorAll('.day-chip').forEach((btn) => {
    btn.addEventListener('click', () => btn.classList.toggle('active'));
  });

  // Save button
  document.getElementById('save-btn')?.addEventListener('click', saveSettings);

  // Fire Now button
  document.getElementById('fire-now-btn')?.addEventListener('click', () => {
    if (!config.webhookUrl) {
      showToast('Enter a webhook URL first', 'error');
      return;
    }
    fireWebhook();
  });

  // Enable toggle
  document.getElementById('enabled-toggle')?.addEventListener('change', async (e) => {
    config.enabled = e.target.checked;
    await saveConfig();
    updateNextRun();
  });

  // Notification badge click to request permission
  document.getElementById('notif-badge')?.addEventListener('click', requestNotificationPermission);
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  loadConfig();
  initTabs();
  initEventListeners();
  populateScheduleUI();
  updateStatusPanel();

  await registerSW();
  await requestNotificationPermission();
  await catchUpMissedRun();

  startPolling();
  // Update next run display every minute
  setInterval(updateNextRun, 60 * 1000);
}

document.addEventListener('DOMContentLoaded', init);
