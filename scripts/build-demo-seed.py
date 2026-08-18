#!/usr/bin/env python3
"""Rebuild the redacted demo seed from a live session transcript.

Usage: python3 scripts/build-demo-seed.py [session-id]

Reads ~/.claude/projects/<slug>/<session-id>.jsonl (+ its subagents dir) and the
newest stored snapshot for that session (from the running container's volume via
`docker exec`), applies the redaction map, swaps every embedded image for an SVG
"DEMO ONLY" placeholder, validates all JSON, sweeps for leftover identifiers,
and writes seed/sessions/<session-id>/. Run from the repo root, then rebuild the
container (the seed is baked into the image; served only when DEMO_SEED=1).
"""
import base64
import json
import re
import subprocess
import sys
from pathlib import Path

SID = sys.argv[1] if len(sys.argv) > 1 else None

SVG = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450">'
       '<rect width="800" height="450" fill="#14181f"/>'
       '<rect x="8" y="8" width="784" height="434" fill="none" stroke="#2e3542" stroke-width="2" rx="10"/>'
       '<text x="400" y="205" text-anchor="middle" font-family="monospace" font-size="44" font-weight="bold" fill="#f0b429">DEMO ONLY</text>'
       '<text x="400" y="255" text-anchor="middle" font-family="monospace" font-size="19" fill="#8b94a7">SCREENSHOT REDACTED FOR AUTHOR PRIVACY</text></svg>')
SVG_B64 = base64.b64encode(SVG.encode()).decode()

# Redaction map lives OUTSIDE version control: scripts/redaction.local.json
# {"slug": "-Users-you-Project", "replacements": [["secret", "placeholder"], ...],
#  "sweep": ["secret", ...]}  — sweep terms hard-fail the build if they survive.
CONF_PATH = Path(__file__).with_name('redaction.local.json')
if CONF_PATH.is_file():
    _conf = json.loads(CONF_PATH.read_text())
else:
    print(f'NOTE: {CONF_PATH.name} not found — using the neutral example map', file=sys.stderr)
    _conf = {'slug': '-Users-you-ContextExplorer',
             'replacements': [['example-user', 'demouser']],
             'sweep': ['example-user']}
SLUG_CONF = _conf.get('slug')
REPL = [tuple(x) for x in _conf.get('replacements', [])]
SWEEP = _conf.get('sweep', [])

B64RUN = re.compile(r'[A-Za-z0-9+/]{1200,}={0,2}')  # catches leftover blobs; SVG_B64 is shorter


def swap_images(obj):
    n = 0
    if isinstance(obj, dict):
        if obj.get('type') == 'image' and isinstance(obj.get('source'), dict) and obj['source'].get('data'):
            obj['source'] = {'type': 'base64', 'media_type': 'image/svg+xml', 'data': SVG_B64}
            n += 1
        else:
            for v in obj.values():
                n += swap_images(v)
    elif isinstance(obj, list):
        for v in obj:
            n += swap_images(v)
    return n


def redact_text(t):
    for a, b in REPL:
        t = t.replace(a, b)
    return B64RUN.sub(SVG_B64, t)


def main():
    if not SID:
        print('usage: build-demo-seed.py <session-id>   (redaction map: scripts/redaction.local.json)', file=sys.stderr)
        return 2
    SLUG = SLUG_CONF
    out = Path('seed/sessions') / SID
    (out / 'snapshots').mkdir(parents=True, exist_ok=True)
    (out / 'files' / 'subagents').mkdir(parents=True, exist_ok=True)

    src = Path.home() / f'.claude/projects/{SLUG}/{SID}.jsonl'
    lines, images = [], 0
    for l in src.read_text().splitlines():
        if not l.strip():
            continue
        rec = json.loads(l)
        images += swap_images(rec)
        r = redact_text(json.dumps(rec, separators=(',', ':')))
        json.loads(r)
        lines.append(r)
    (out / 'transcript.jsonl').write_text('\n'.join(lines) + '\n')
    print(f'transcript: {len(lines)} lines, {images} images -> SVG placeholder')

    raw = name = None
    import os
    local = Path(os.environ.get('DATA_DIR', 'data')) / 'sessions' / SID / 'snapshots'
    if local.is_dir():
        found = sorted(local.glob('*.json'))
        if found:
            name, raw = found[-1].name, found[-1].read_text()
    if raw is None:  # fall back to a running docker container's volume
        ls = subprocess.run(['docker', 'exec', 'context-explorer', 'sh', '-c',
                             f'ls /data/sessions/{SID}/snapshots'], capture_output=True, text=True)
        snaps = [x for x in ls.stdout.split() if x.endswith('.json')]
        if snaps:
            name = snaps[-1]
            raw = subprocess.run(['docker', 'exec', 'context-explorer', 'cat',
                                  f'/data/sessions/{SID}/snapshots/{name}'], capture_output=True, text=True).stdout
    if raw:
        snap = redact_text(raw)
        json.loads(snap)
        (out / 'snapshots' / 'snapshot-build-session.json').write_text(snap)
        print(f'snapshot: {name} -> snapshot-build-session.json')
    else:
        print('no snapshot found (local data/ or docker) — seeding without one')

    agdir = Path.home() / f'.claude/projects/{SLUG}/{SID}/subagents'
    if agdir.is_dir():
        for f in agdir.iterdir():
            (out / 'files' / 'subagents' / f.name).write_text(redact_text(f.read_text()))
        print(f'subagent files: {len(list(agdir.iterdir()))}')

    leftover = {}
    for p in out.rglob('*'):
        if p.is_file():
            t = p.read_text()
            for pat in SWEEP:
                if pat in t:
                    leftover[f'{p.name}:{pat}'] = t.count(pat)
    if leftover:
        print('FAILED — identifiers survived:', leftover)
        return 1
    print('identifier sweep: CLEAN. Now: docker compose up -d --build')
    return 0


if __name__ == '__main__':
    sys.exit(main())
