# ReClaude

**A flight recorder for the Claude Code context window.**

Explore the full context of any Claude Code session — system prompt, rules, skills,
tool definitions, attachments, and messages — at any point in time, scrubbed on a
timeline. Sessions are discovered from `~/.claude` automatically; the parts that
exist *only* inside the model's context are captured by invoking the
`context-export` skill from inside a live session.

### 🔎 [Live demo →](https://natpalmer-e4o4.github.io/ReClaude/)

A static, installable build carrying the redacted session in which this tool was
built — so you can explore the construction of the viewer *in* the viewer. No
install, no server, works offline once loaded.

![zero dependencies](https://img.shields.io/badge/dependencies-none-27a578)
![node](https://img.shields.io/badge/node-%E2%89%A518-4a8fdd)
![docker optional](https://img.shields.io/badge/docker-optional-8a5fe8)
![license MIT](https://img.shields.io/badge/license-MIT-c08618)

## Why a skill does the export

The transcript JSONL on disk (`~/.claude/projects/<slug>/<session>.jsonl`) records
messages, attachments (deferred-tool deltas, skill listings, MCP instructions),
token usage, and compaction events — but **the system prompt and full tool schemas
exist only inside the model's context window**. The only sensor that can capture
them is the model itself, so `/context-export` has Claude transcribe its own
system prompt section-by-section and its loaded tool schemas verbatim, then ship
them alongside the transcript. The viewer labels this material "as transcribed" —
the sensor is a language model and can be lossy; sections it had to truncate are
marked `[ABRIDGED BY EXPORTER]`.

## Usage

```bash
node server/server.js         # native, zero dependencies — viewer + import API on http://127.0.0.1:7331
# or with go-task installed: `task serve`   (`task --list` shows all operations)
```

Running natively, the server reads `~/.claude/projects` and `~/.claude/file-history`
directly. Docker is **optional** — `docker compose up -d` (or `task up`) runs the
same server in a container with read-only mounts and a named volume instead.

Then, in any Claude Code session:

```
/context-export
```

and open http://127.0.0.1:7331. The port is bound to loopback only — transcripts
contain real project data and secrets.

The skill lives in `skill/` (source of truth) and is installed by copying:

```bash
cp -R skill/ ~/.claude/skills/context-export/
```

## Demo mode

`DEMO_SEED=1` (see `docker-compose.yml`) serves the redacted session that built
this project — transcript, snapshot, and the subagent that redesigned the
snapshot tab — loaded from `seed/` into **memory only**: nothing is written to
the data volume, and it disappears on restart. Usernames, email, employer and
personal project names are redacted; embedded screenshots are replaced with a
styled SVG placeholder ("DEMO ONLY — SCREENSHOT REDACTED FOR AUTHOR PRIVACY").
Off by default.

To refresh the seed (e.g. to include newer messages before sharing):

```bash
python3 scripts/build-demo-seed.py   # rebuilds seed/ from the live transcript
docker compose up -d --build         # bakes it into the image
```

The script holds the redaction map, swaps every embedded image for the SVG
placeholder, validates all JSON, and hard-fails if any identifier survives.

## Static / PWA build

```bash
task static     # or: python3 scripts/build-static-demo.py
```

Boots the server with `DEMO_SEED=1`, harvests its real API responses into flat
files, and emits `docs/` — the SPA plus the seed data, a web app manifest, and a
service worker that precaches everything. The same `app.js` runs in both modes:
a `window.CTX_STATIC` flag flips every request from `/api/…` to a relative file
path, and search falls back to a client-side scan. GitHub Pages serves `docs/`.

## What the viewer shows

- **Context tape** — the signature instrument: an area chart of tokens-in-window
  per record (from `message.usage`: cache-read + cache-write + fresh input), with
  a tick strip colored by record kind and dashed splices where the context was
  compacted. Click anywhere to scrub.
- **Context at this point** — the reconstructed effective context at the selected
  record: token gauge, system prompt + tool schemas + rules files (from the
  snapshot), cumulative deferred-tool/skill/MCP state, and the exact message
  window.
- **Record / Snapshot / Files** tabs — raw JSONL record, the full export
  snapshot(s), and companion files (subagent transcripts, workflow journals).

## Reconstruction rules (derived from real transcripts)

- Records link via `parentUuid`; context-at-point is the **parent-chain walk** to
  root, not the chronological prefix — edits and retries branch the tree.
- `system/compact_boundary` records have `parentUuid: null`, so the chain walk
  naturally stops at the live context's edge after a compaction; the boundary's
  `compactMetadata` (preTokens → postTokens, preserved uuids) is surfaced.
- `isSidechain: true` records are subagent turns and are excluded from the main
  window (shown dimmed in the rail, toggleable).
- Attachment kinds have distinct semantics: `deferred_tools_delta` accumulates,
  `skill_listing` / `output_style` supersede, `mcp_instructions_delta` accumulates.

## Layout

```
server/           zero-dependency Node server + static SPA (no build step)
skill/            the context-export skill (SKILL.md + scripts/assemble.py)
Dockerfile        node:22-alpine, COPY only
docker-compose.yml
```

Storage inside the container volume: `sessions/<id>/transcript.jsonl` (verbatim),
`meta.json` (computed at import), `snapshots/*.json`, `files/…`. All
reconstruction happens client-side, so re-imports and viewer upgrades are free.

## License

MIT — see [LICENSE](LICENSE).
