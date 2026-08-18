#!/usr/bin/env python3
"""Build a static, installable (PWA) copy of ReClaude into docs/.

Usage: python3 scripts/build-static-demo.py [--port 7350]

Boots the server with DEMO_SEED=1 and harvests its real API responses into flat
files, so the static bundle can never drift from server behaviour. Emits docs/
(the folder GitHub Pages serves) containing the SPA with window.CTX_STATIC set,
the seed data under data/, a web app manifest, and a service worker that
precaches everything for offline use.
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUB = ROOT / 'server' / 'public'
OUT = ROOT / 'docs'
PORT = int(sys.argv[sys.argv.index('--port') + 1]) if '--port' in sys.argv else 7350
BASE = f'http://127.0.0.1:{PORT}'


def get(path, binary=False):
    with urllib.request.urlopen(f'{BASE}{path}', timeout=30) as r:
        data = r.read()
    return data if binary else data.decode('utf-8')


def write(rel, data):
    p = OUT / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data if isinstance(data, bytes) else data.encode('utf-8'))
    return p


def main():
    tmp = tempfile.mkdtemp()
    env = {**os.environ, 'DEMO_SEED': '1', 'DATA_DIR': tmp, 'PORT': str(PORT),
           'HOST_PROJECTS': '', 'FILE_HISTORY': ''}
    srv = subprocess.Popen([shutil.which('node') or 'node', 'server/server.js'],
                           cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            try:
                get('/api/health')
                break
            except (urllib.error.URLError, ConnectionError):
                time.sleep(0.2)
        else:
            print(f'server did not start on :{PORT}', file=sys.stderr)
            return 1

        if OUT.exists():
            shutil.rmtree(OUT)
        OUT.mkdir(parents=True)

        # ---- app shell ----
        for name in ('app.css', 'app.js'):
            shutil.copy2(PUB / name, OUT / name)
        shutil.copytree(PUB / 'vendor', OUT / 'vendor')

        html = (PUB / 'index.html').read_text()
        html = (html
                .replace('href="/app.css"', 'href="app.css"')
                .replace('href="/vendor/', 'href="vendor/')
                .replace('src="/app.js"', 'src="app.js"')
                .replace('src="/vendor/', 'src="vendor/')
                .replace('</head>',
                         '<link rel="manifest" href="manifest.webmanifest">\n'
                         '<meta name="theme-color" content="#14181f">\n'
                         '<script>window.CTX_STATIC = 1;</script>\n</head>')
                .replace('</body>',
                         '<script>if ("serviceWorker" in navigator) '
                         'window.addEventListener("load", () => navigator.serviceWorker.register("sw.js"));'
                         '</script>\n</body>'))
        write('index.html', html)

        # ---- data: harvested from the live API ----
        sessions = json.loads(get('/api/sessions'))
        write('data/sessions.json', json.dumps(sessions))
        assets = []
        for s in sessions:
            sid = s['sessionId']
            man = json.loads(get(f'/api/sessions/{sid}'))
            write(f'data/s/{sid}/meta.json', json.dumps(man))
            write(f'data/s/{sid}/transcript.jsonl', get(f'/api/sessions/{sid}/transcript', binary=True))
            assets += [f'data/s/{sid}/meta.json', f'data/s/{sid}/transcript.jsonl']
            for name in man.get('snapshots', []):
                write(f'data/s/{sid}/snapshots/{name}', get(f'/api/sessions/{sid}/snapshots/{name}', binary=True))
                assets.append(f'data/s/{sid}/snapshots/{name}')
            for rel in man.get('files', []):
                write(f'data/s/{sid}/files/{rel}', get(f'/api/sessions/{sid}/files/{urllib.request.quote(rel, safe="")}', binary=True))
                assets.append(f'data/s/{sid}/files/{rel}')
            write(f'data/s/{sid}/memory.json', get(f'/api/sessions/{sid}/memory', binary=True))
            assets.append(f'data/s/{sid}/memory.json')
            # no file-history backups travel with the demo seed
            write(f'data/s/{sid}/filehistory.json', json.dumps([]))
            assets.append(f'data/s/{sid}/filehistory.json')
        print(f'data: {len(sessions)} session(s), {len(assets)} files')

        # ---- icons (the maker's mark, reused as the app icon) ----
        mark = ROOT.parent / 'wizard.png'
        icons = []
        if mark.is_file():
            shutil.copy2(mark, OUT / 'icon.png')
            icons.append({'src': 'icon.png', 'sizes': '64x64', 'type': 'image/png'})
            if shutil.which('sips'):
                for size in (192, 512):
                    subprocess.run(['sips', '-z', str(size), str(size), str(OUT / 'icon.png'),
                                    '--out', str(OUT / f'icon-{size}.png')],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    if (OUT / f'icon-{size}.png').is_file():
                        icons.append({'src': f'icon-{size}.png', 'sizes': f'{size}x{size}',
                                      'type': 'image/png', 'purpose': 'any maskable'})

        write('manifest.webmanifest', json.dumps({
            'name': 'ReClaude', 'short_name': 'ReClaude',
            'description': "A flight recorder for the Claude Code context window.",
            'start_url': '.', 'scope': '.', 'display': 'standalone',
            'background_color': '#14181f', 'theme_color': '#14181f',
            'icons': icons,
        }, indent=1))

        shell = ['index.html', 'app.css', 'app.js', 'manifest.webmanifest']
        shell += [str(p.relative_to(OUT)) for p in (OUT / 'vendor').rglob('*') if p.is_file()]
        shell += [i['src'] for i in icons]
        version = str(int((PUB / 'app.js').stat().st_mtime))
        write('sw.js', f'''/* ReClaude static demo — precache everything, serve cache-first. */
const CACHE = 'reclaude-{version}';
const ASSETS = {json.dumps(shell + assets, indent=0)};
self.addEventListener('install', (e) => {{
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
}});
self.addEventListener('activate', (e) => {{
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
}});
self.addEventListener('fetch', (e) => {{
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, {{ ignoreSearch: true }})
    .then((hit) => hit || fetch(e.request).then((res) => {{
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {{}});
      return res;
    }}).catch(() => caches.match('index.html'))));
}});
''')
        write('.nojekyll', '')
        total = sum(p.stat().st_size for p in OUT.rglob('*') if p.is_file())
        print(f'built {OUT.relative_to(ROOT)}/ — {len(list(OUT.rglob("*")))} entries, {total / 1e6:.1f} MB')
        print('serve locally: python3 -m http.server -d docs 8080')
        return 0
    finally:
        srv.send_signal(signal.SIGTERM)
        srv.wait(timeout=10)
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
