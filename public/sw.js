// Minimal service worker so the app can be installed as a desktop/mobile app.
// Everything is loaded from the network: maps are shared and must stay live.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
