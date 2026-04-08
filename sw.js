// sw.js — Service Worker
// Handles: caching, periodic background sync, webhook firing, notifications

importScripts('./scheduler.js');

const CACHE_NAME = 'n8n-scheduler-v1';
const BASE = '/n8n-scheduler';
const CACHED_URLS = [
  BASE + '/',
  BASE + '/index.html',
  BASE + '/style.css',
  BASE + '/app.js',
  BASE + '/scheduler.js',
  BASE + '/manifest.json',
];

const DB_NAME = 'n8n-scheduler-db';
const DB_VERSION = 1;
const STORE_NAME = 'config';

// ── IndexedDB helpers ────────────────────────────────────────────────────────

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

async function dbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── Install ──────────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CACHED_URLS))
  );
  self.skipWaiting();
});

// ── Activate ─────────────────────────────────────────────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch (cache-first) ───────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

// ── Periodic Background Sync ─────────────────────────────────────────────────

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'webhook-trigger') {
    event.waitUntil(handleScheduledTrigger());
  }
});

async function handleScheduledTrigger() {
  const config = await dbGet('config');
  if (!config || !config.enabled || !config.webhookUrl) return;

  const { schedule, lastRun, webhookUrl } = config;
  if (!Scheduler.shouldFireNow(schedule, lastRun)) return;

  await fireWebhook(webhookUrl);
}

// ── Webhook firing ────────────────────────────────────────────────────────────

async function fireWebhook(url) {
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

  // Notify all open clients so they can update UI
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) {
    client.postMessage({ type: 'WEBHOOK_RESULT', success, error: errorMsg, time: now });
  }

  // Show browser notification
  const title = success ? 'Webhook triggered successfully' : 'Webhook failed';
  const body = success
    ? `Fired at ${new Date(now).toLocaleTimeString()}`
    : `Error: ${errorMsg}`;

  await self.registration.showNotification(title, {
    body,
    icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="%236c63ff"/><text x="32" y="44" font-size="36" text-anchor="middle" fill="white">n</text></svg>',
    badge: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="%236c63ff"/></svg>',
    tag: 'webhook-result',
    data: { success, time: now },
  });
}

// ── Notification click ────────────────────────────────────────────────────────

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      const appUrl = BASE + '/';
      for (const client of clients) {
        if (client.url.startsWith(self.location.origin + BASE) && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(appUrl);
      }
    })
  );
});

// ── Message from main thread (manual fire) ────────────────────────────────────

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'FIRE_NOW') {
    event.waitUntil(fireWebhook(event.data.webhookUrl));
  }
});
