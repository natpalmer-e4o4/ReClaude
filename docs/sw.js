/* Context Explorer static demo — precache everything, serve cache-first. */
const CACHE = 'ctx-explorer-1787090657';
const ASSETS = [
"index.html",
"app.css",
"app.js",
"manifest.webmanifest",
"vendor/codemirror/codemirror.js",
"vendor/codemirror/codemirror.css",
"vendor/codemirror/javascript.js",
"icon.png",
"icon-192.png",
"icon-512.png",
"data/s/a9107ddb-a748-442b-bb88-23d87b823014/meta.json",
"data/s/a9107ddb-a748-442b-bb88-23d87b823014/transcript.jsonl",
"data/s/a9107ddb-a748-442b-bb88-23d87b823014/snapshots/snapshot-build-session.json",
"data/s/a9107ddb-a748-442b-bb88-23d87b823014/files/subagents/agent-ae050d421718d1294.jsonl",
"data/s/a9107ddb-a748-442b-bb88-23d87b823014/files/subagents/agent-ae050d421718d1294.meta.json",
"data/s/a9107ddb-a748-442b-bb88-23d87b823014/filehistory.json"
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true })
    .then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('index.html'))));
});
