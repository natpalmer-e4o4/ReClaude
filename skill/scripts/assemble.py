#!/usr/bin/env python3
"""Assemble a Context Explorer snapshot from a staging dir and POST it.

Usage: assemble.py <staging-dir> <session-id> [--server http://127.0.0.1:7331]

Staging layout (written by the model during /context-export):
  meta.json                     {sessionId, model, claudeCodeVersion, notes}
  system-prompt/NN-<slug>.md    one file per system-prompt section, verbatim
  tools/<name>.json             {name, description, schema} per loaded tool

The script adds on-disk rules files (global + project CLAUDE.md and their
@-includes), the latest message uuid from the imported transcript, and ships
the bundle to POST /api/import/snapshot?session=<id>.
"""
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

def read(p: Path) -> str:
    return p.read_text(encoding="utf-8", errors="replace")

def title_of(md: Path) -> str:
    stem = re.sub(r"^\d+[-_]?", "", md.stem)
    return stem.replace("-", " ").replace("_", " ").strip() or md.stem

def collect_rules(project_cwd: Path) -> list:
    rules, seen = [], set()

    def add(path: Path):
        path = path.expanduser()
        try:
            path = path.resolve()
        except OSError:
            return
        if path in seen or not path.is_file():
            return
        seen.add(path)
        content = read(path)
        rules.append({"path": str(path), "content": content})
        # follow @-includes (CLAUDE.md convention: a line starting with @path)
        for m in re.finditer(r"^@(\S+)", content, re.M):
            inc = m.group(1)
            base = Path(inc).expanduser()
            add(base if base.is_absolute() else path.parent / base)

    add(Path("~/.claude/CLAUDE.md"))
    cur = project_cwd
    chain = []
    while cur != cur.parent:
        chain.append(cur / "CLAUDE.md")
        cur = cur.parent
    for p in reversed(chain):
        add(p)
    return rules

def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    staging = Path(sys.argv[1])
    session_id = sys.argv[2]
    server = "http://127.0.0.1:7331"
    if "--server" in sys.argv:
        server = sys.argv[sys.argv.index("--server") + 1]

    meta = {}
    meta_p = staging / "meta.json"
    if meta_p.is_file():
        meta = json.loads(read(meta_p))

    sections = []
    sp_dir = staging / "system-prompt"
    for f in sorted(sp_dir.glob("*")) if sp_dir.is_dir() else []:
        if f.suffix == ".ref":
            # cached in the server's shared library — send the reference only
            sections.append({"title": title_of(f), "ref": read(f).strip()})
        elif f.suffix == ".md":
            body = read(f)
            sections.append({
                "title": title_of(f),
                "content": body,
                "abridged": "[ABRIDGED BY EXPORTER]" in body,
            })

    tools = []
    t_dir = staging / "tools"
    if t_dir.is_dir():
        # <name>.ref = reference into the server's shared library
        for f in sorted(t_dir.glob("*.ref")):
            tools.append({"name": f.stem, "ref": read(f).strip()})
        # <name>.md = verbatim description; optional <name>.schema.json = verbatim schema
        for f in sorted(t_dir.glob("*.md")):
            tool = {"name": f.stem, "description": read(f)}
            sj = t_dir / f"{f.stem}.schema.json"
            if sj.is_file():
                try:
                    tool["schema"] = json.loads(read(sj))
                except json.JSONDecodeError as e:
                    print(f"WARNING: malformed schema {sj.name}: {e}", file=sys.stderr)
            tools.append(tool)
        # or a single pre-built {name, description, schema} JSON per tool
        for f in sorted(t_dir.glob("*.json")):
            if f.name.endswith(".schema.json"):
                continue
            try:
                tools.append(json.loads(read(f)))
            except json.JSONDecodeError as e:
                print(f"WARNING: skipping malformed tool file {f.name}: {e}", file=sys.stderr)

    # anchor the snapshot to the last message uuid in the transcript on disk
    latest_uuid = None
    for proj_dir in (Path.home() / ".claude" / "projects").glob("*"):
        t = proj_dir / f"{session_id}.jsonl"
        if t.is_file():
            for line in read(t).splitlines():
                try:
                    rec = json.loads(line)
                    if rec.get("uuid"):
                        latest_uuid = rec["uuid"]
                except json.JSONDecodeError:
                    pass
            break

    snapshot = {
        "sessionId": session_id,
        "exportedAt": datetime.now(timezone.utc).isoformat(),
        "latestMessageUuid": latest_uuid,
        "model": meta.get("model"),
        "claudeCodeVersion": meta.get("claudeCodeVersion"),
        "notes": meta.get("notes"),
        "systemPrompt": sections,
        "tools": tools,
        "rules": collect_rules(Path.cwd()),
    }

    if not sections:
        print("WARNING: no system-prompt sections found in staging dir", file=sys.stderr)

    body = json.dumps(snapshot).encode("utf-8")
    req = urllib.request.Request(
        f"{server}/api/import/snapshot?session={session_id}",
        data=body, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())
    abridged = sum(1 for s in sections if s.get("abridged"))
    refs = sum(1 for s in sections if "ref" in s) + sum(1 for t in tools if "ref" in t)
    print(f"snapshot uploaded: {result.get('snapshot')}")
    print(f"  {len(sections)} system-prompt sections ({abridged} abridged), "
          f"{len(tools)} tool schemas, {len(snapshot['rules'])} rules files, "
          f"{refs} served from the shared library cache")
    print(f"  view: {server}/#/s/{session_id}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
