---
name: context-export
description: Export the current Claude Code session to the local ReClaude container — transcript, subagent files, and an as-transcribed snapshot of the in-context system prompt and tool definitions. Use when the user runs /context-export or asks to export/inspect this session's context.
---

# Context Export

Export this live session to the ReClaude viewer at `http://127.0.0.1:7331`.

The transcript JSONL exists on disk, but the **system prompt and tool schemas exist
only inside your context window** — you are the only sensor that can capture them.
That transcription step is the heart of this skill: it must be **verbatim**, not
summarized.

## Step 1 — check the server

```bash
curl -sf http://127.0.0.1:7331/api/health
```

If this fails, tell the user to start it (`docker compose up -d` in
`~/ReClaude`) and stop here.

## Step 2 — locate the session

- **Session ID**: your system prompt's scratchpad directory path contains it:
  `.../<project-slug>/<SESSION-ID>/scratchpad`. If no scratchpad path is present,
  fall back to the newest-mtime `*.jsonl` in the project dir below.
- **Project slug**: the current working directory with `/` and `.` replaced by `-`
  (e.g. `/Users/x/proj` → `-Users-x-proj`).
- **Transcript**: `~/.claude/projects/<project-slug>/<SESSION-ID>.jsonl` — verify it
  exists and is non-empty before continuing.

## Step 3 — upload transcript and companion files

```bash
curl -sf --data-binary @"$HOME/.claude/projects/<slug>/<id>.jsonl" \
  "http://127.0.0.1:7331/api/import/transcript?session=<id>&project=<slug>"
```

If `~/.claude/projects/<slug>/<id>/` exists (subagent transcripts, workflows),
upload each file inside it:

```bash
cd ~/.claude/projects/<slug>/<id> && find . -type f | while read -r f; do
  curl -sf --data-binary @"$f" \
    "http://127.0.0.1:7331/api/import/file?session=<id>&name=$(python3 - "$f" <<'EOF'
import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1][2:], safe=''))
EOF
)"
done
```

## Step 4 — transcribe your in-context material (the critical step)

Create a staging directory in your scratchpad: `ctx-export/` with subdirs
`system-prompt/` and `tools/`.

**Check the shared library cache FIRST** — most of this material is static and
already stored from previous exports:

```bash
curl -s http://127.0.0.1:7331/api/library/manifest
```

It returns fingerprints for every cached system-prompt section (`head`/`mid`/
`tail` excerpts + `len`) and every cached tool (description fingerprint +
sorted schema parameter names + schema length). For each cached entry, compare
the fingerprint against what is actually in YOUR context right now:

- All three excerpts match your in-context text verbatim, and the length is
  right → it is the same text. Write a tiny ref file instead of transcribing:
  `system-prompt/NN-<slug>.ref` or `tools/<name>.ref` containing just the
  `ref` string (e.g. `Bash@86d1840e7067`). The server re-inflates it.
- Any excerpt differs, or the entry is missing → transcribe in full as below.
  Your full transcription auto-seeds the cache for the next export.

Sections that are session-specific and must ALWAYS be transcribed fresh, never
ref'd without checking extra carefully: the Environment section, the
Scratchpad/Background-Session section, the Memory section, and anything
mentioning the session id, working directory, or dates.

**System prompt** — write each section of your system prompt as its own file
`system-prompt/NN-<slug>.md` (NN = order of appearance). One file per logical
section (identity/harness, communication rules, environment, memory, scratchpad,
session guidance, injected CLAUDE.md context, etc.).

Rules:
- **Verbatim.** Copy the text exactly as it appears in your context — same wording,
  same formatting, headers included. Do not paraphrase, do not summarize, do not
  reorder.
- Work **one section per Write call**. A single dump of everything invites silent
  truncation; small files keep you honest.
- If a section is too long to reproduce fully, reproduce as much as you can and end
  the file with the exact marker `[ABRIDGED BY EXPORTER]` — never abridge silently.
- **Completeness re-scan**: after writing all sections, walk your context
  top-to-bottom once more and confirm every system-prompt block has a file. The
  safety-rules block near the end (instruction source boundary, action categories,
  privacy, copyright) is the most easily dropped — check for it by name.

**Tool definitions** — for each tool whose full schema is currently loaded in your
context (both the tools defined at the top of the prompt and any deferred tools
whose schemas have been fetched this session), write two files:

- `tools/<name>.md` — the tool's description, verbatim (plain markdown, no JSON
  escaping to get wrong)
- `tools/<name>.schema.json` — the tool's parameter JSON schema, verbatim

Tools you can only see *names* for (unfetched deferred tools) are already captured
in the transcript's `deferred_tools_delta` records — skip them.

**Meta** — write `ctx-export/meta.json`:

```json
{
  "sessionId": "<id>",
  "model": "<your exact model id>",
  "claudeCodeVersion": "<from transcript records' version field, or unknown>",
  "notes": "<anything unusual about this export>"
}
```

## Step 5 — assemble and upload the snapshot

```bash
python3 ~/.claude/skills/context-export/scripts/assemble.py <staging-dir>/ctx-export <session-id>
```

The script bundles the staging dir plus on-disk rules files (`~/.claude/CLAUDE.md`,
project `CLAUDE.md`s, files they `@`-include) into one snapshot JSON and POSTs it.
It prints the viewer URL on success.

## Step 6 — report

Tell the user the export succeeded and give them the link:
`http://127.0.0.1:7331/#/s/<session-id>`. Mention how many system-prompt sections
and tool schemas were transcribed, and whether any were marked abridged.
