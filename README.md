# ReClaude

**A flight recorder for the Claude Code context window.**

Rewind any session. See exactly what the model could see at any moment — system
prompt, tool schemas, rules, skills, MCP instructions, memory, and every message
in the window — scrubbed on a timeline.

### 🔎 [Live demo →](https://natpalmer-e4o4.github.io/ReClaude/)

The demo carries the redacted session in which this tool was built. You explore
the construction of the viewer, in the viewer. No install, no server, works
offline once loaded.

![zero dependencies](https://img.shields.io/badge/dependencies-none-27a578)
![node](https://img.shields.io/badge/node-%E2%89%A518-4a8fdd)
![docker optional](https://img.shields.io/badge/docker-optional-8a5fe8)
![license MIT](https://img.shields.io/badge/license-MIT-c08618)

## Install

```bash
npx @natpalmer-e4o4/reclaude       # run it now
npm i -g @natpalmer-e4o4/reclaude  # or keep it: `reclaude`
```

<details><summary>Windows, macOS and Linux one-liners</summary>

```powershell
# Windows (PowerShell). -AtLogon also registers a logon task, which keeps the
# file-history mirror running so backups are captured before Claude Code prunes them.
irm https://raw.githubusercontent.com/natpalmer-e4o4/ReClaude/main/install/install.ps1 | iex
```

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/natpalmer-e4o4/ReClaude/main/install/install.sh | sh

# or, once the tap is published
brew tap natpalmer-e4o4/tools && brew install reclaude
brew services start reclaude
```
</details>

It finds your sessions in `~/.claude` and opens the viewer on
`http://127.0.0.1:7331`. Loopback only — transcripts contain real project data.

From a checkout, `node server/server.js` (or `task serve`) does the same thing.
Docker is optional: `docker compose up -d` runs the identical server in a
container with read-only mounts.

Then add the capture skill to Claude Code:

```
/plugin marketplace add natpalmer-e4o4/ReClaude
/plugin install snapshot@reclaude
```

`reclaude install-skill` copies it in instead, if you'd rather not use plugins.

## Why a skill has to do the capture

The transcript on disk records messages, attachments, token usage, and
compactions. It does not record the system prompt or the tool schemas. Those
exist only inside the model's context window — nothing writes them to disk.

So the model captures them itself. Run `/snapshot` in a session and Claude
transcribes its own system prompt section by section, plus every tool schema it
holds, and ships them next to the transcript.

The model is the sensor here, and sensors drift. The viewer labels this material
"as transcribed," and anything the model had to truncate is marked
`[ABRIDGED BY EXPORTER]`. Repeat captures reuse a content-addressed cache: the
model compares fingerprints instead of retyping 40k tokens of static prompt.

## What you get

**The tape.** Tokens-in-window over the session, with a tick strip colored by
event kind. Click to select a moment, drag to zoom, double-click to reset. The
x-axis is real time, so bursts look busy and idle stretches collapse into
labelled hatched bands instead of eating the whole width.

**Two lenses.** *Timeline* is what happened in the zoomed range. *Context window*
is what the model could see at the selected record — the parent-chain walk, not
the chronological prefix, because edits and retries branch the tree.

**The ground truth,** each on its own tab: system prompt, tools, skills, MCP
instructions, and Claude's persistent memory for the project.

**Sub-agents as sub-timelines.** Parallel fan-outs collapse into a chip; hover to
pick one; open it and the whole instrument switches to that agent's transcript.
Escape returns you to exactly where you were.

**Real file edits.** Not the conversation's description of an edit — the actual
stored versions from Claude Code's edit tracker, diffed against their
predecessor. ReClaude mirrors that store, because Claude Code prunes it.

**Six themes,** three dark and three light. Categorical colors are validated per
mode for contrast and colorblind separation, not picked by eye.

## How the reconstruction works

Records link by `parentUuid`, so the context at any point is the walk from that
record back to the root. Compaction boundaries carry `parentUuid: null`, which
means the walk stops at the live window's edge on its own — everything older
survives only in the summary, and the viewer says so.

Sidechain records are subagent turns and never entered the main window.
Attachments differ in kind: `deferred_tools_delta` accumulates, `skill_listing`
and `output_style` supersede.

Human turns are identified by the harness stamp `origin.kind: "human"`, never by
guessing from content. That matters — skill loads and post-compaction summaries
arrive as user-role records but nobody typed them.

## Demo mode

`DEMO_SEED=1` serves the redacted build session from `seed/`, in memory only.
Nothing touches your data directory and it vanishes on restart.

Rebuild it with `python3 scripts/build-demo-seed.py`. The script holds the
redaction map outside version control, swaps every screenshot for a placeholder,
validates the JSON, and fails hard if any identifier survives the sweep.

## Static build

```bash
task static
```

Boots the server with the demo seed, harvests its real API responses into flat
files, and writes `docs/` — the app, the data, a manifest, and a service worker.
The same `app.js` runs both ways: a flag flips every request from `/api/…` to a
relative path. GitHub Pages serves it.

## Layout

```
bin/cli.js         the reclaude command
server/            zero-dependency Node server + the SPA (no build step)
skills/snapshot/   the /snapshot skill and its assemble helper
.claude-plugin/    plugin + marketplace manifests
scripts/           demo seed, static build, tests
install/           one-line installers (PowerShell, sh)
packaging/         homebrew formula, winget notes
seed/              the redacted demo session
docs/              built static demo (generated)
```

Storage: `sessions/<id>/transcript.jsonl` verbatim, plus computed `meta.json`,
`snapshots/`, and `files/`. Reconstruction happens in the browser, so re-imports
and viewer upgrades cost nothing.

## Releasing

One command:

```bash
task release -- 0.1.2
```

It bumps `package.json`, rebuilds `docs/`, commits, tags, and pushes. Pushing the
tag runs `.github/workflows/release.yml`, which calls the same task targets you
would run by hand — it checks the tag against `package.json`, runs `task test`,
publishes the GitHub release, then bumps the Homebrew tap and npm.

Two repository secrets gate the last two steps. Without them the workflow still
succeeds and warns:

| Secret | Enables | Needs |
|---|---|---|
| `TAP_TOKEN` | pushing the formula to `homebrew-tools` | a PAT with `repo` scope on that repo (`GITHUB_TOKEN` cannot reach another repository) |
| `NPM_TOKEN` | `npm publish` | an npm automation token |

```bash
gh secret set TAP_TOKEN   # paste the PAT
gh secret set NPM_TOKEN   # paste the npm token
```

Each target also works alone: `task release:sha -- v0.1.2`,
`task release:formula -- v0.1.2`, `task release:tap -- v0.1.2`.

## License

MIT — see [LICENSE](LICENSE).
