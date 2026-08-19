#!/usr/bin/env node
/**
 * ReClaude — zero-dependency import server + SPA host.
 *
 * Storage layout (DATA_DIR):
 *   sessions/<sessionId>/transcript.jsonl        raw session JSONL, verbatim
 *   sessions/<sessionId>/meta.json               summary computed at import
 *   sessions/<sessionId>/snapshots/<name>.json   in-context snapshots (system prompt etc.)
 *   sessions/<sessionId>/files/<relpath>         extras (subagent transcripts, memory, ...)
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { URL } = require('url');

// Env defaults suit a native run (reading ~/.claude directly); the compose file
// overrides them with container mount points. Docker is optional.
const defaultDir = (p) => (fs.existsSync(p) ? p : null);
const PORT = parseInt(process.env.PORT || '7331', 10);
const HOST = process.env.HOST || '0.0.0.0'; // compose binds host side to 127.0.0.1
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 512 * 1024 * 1024; // transcripts can be large

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

fs.mkdirSync(path.join(DATA_DIR, 'sessions'), { recursive: true });

// ---------- demo seed (DEMO_SEED=1) ----------
// The redacted session that built this project, loaded from seed/ into MEMORY
// only — never written to the data volume, gone on restart, off by default.
const DEMO_SEED = /^(1|true)$/i.test(process.env.DEMO_SEED || '');
const SEED_DIR = path.join(__dirname, '..', 'seed', 'sessions');
const demoSessions = new Map(); // id -> {transcript, meta, snapshots:{name:buf}, files:{rel:buf}}
if (DEMO_SEED && fs.existsSync(SEED_DIR)) {
  for (const id of fs.readdirSync(SEED_DIR)) {
    try {
      const dir = path.join(SEED_DIR, id);
      const transcript = fs.readFileSync(path.join(dir, 'transcript.jsonl'));
      const meta = summarizeTranscript(transcript);
      meta.project = meta.cwd ? meta.cwd.replace(/[/.]/g, '-') : null;
      const snapshots = {};
      try { for (const f of fs.readdirSync(path.join(dir, 'snapshots'))) snapshots[f] = fs.readFileSync(path.join(dir, 'snapshots', f)); } catch {}
      let memory = null;
      try { memory = JSON.parse(fs.readFileSync(path.join(dir, 'memory.json'), 'utf8')); } catch {}
      const files = {};
      const walk = (base, rel) => {
        for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
          const r = rel ? `${rel}/${ent.name}` : ent.name;
          if (ent.isDirectory()) walk(path.join(base, ent.name), r);
          else files[r] = fs.readFileSync(path.join(base, ent.name));
        }
      };
      try { walk(path.join(dir, 'files'), ''); } catch {}
      demoSessions.set(id, { transcript, meta, snapshots, files, memory });
      console.log(`demo seed loaded (in-memory): ${id} — ${meta.lineCount} records`);
    } catch (e) { console.error('demo seed failed:', id, e.message); }
  }
}

// ---------- file-history mirror ----------
// Claude Code prunes ~/.claude/file-history over time; transcripts then reference
// backups that no longer exist. Backup files are immutable once written, so a
// polling copy-once mirror into the volume preserves them permanently. Serving
// reads host-first with the cache as fallback.
const FH_HOST = process.env.FILE_HISTORY !== undefined
  ? (process.env.FILE_HISTORY || null)
  : defaultDir(path.join(os.homedir(), '.claude', 'file-history'));
const FH_CACHE = path.join(DATA_DIR, 'file-history-cache');
fs.mkdirSync(FH_CACHE, { recursive: true });
const FH_CACHE_MAX_BYTES = Math.max(0, parseInt(process.env.FH_CACHE_MAX_MB || '0', 10)) * 1024 * 1024;
const fhStats = { lastSweep: null, copiedTotal: 0, cachedFiles: 0, cachedBytes: 0, evictedTotal: 0, maxMB: FH_CACHE_MAX_BYTES ? FH_CACHE_MAX_BYTES / 1024 / 1024 : null };

async function mirrorFileHistory() {
  if (!FH_HOST || !fs.existsSync(FH_HOST)) return;
  try {
    let cached = 0;
    for (const sid of await fsp.readdir(FH_HOST)) {
      if (sid.startsWith('.') || !/^[A-Za-z0-9-]+$/.test(sid)) continue;
      const src = path.join(FH_HOST, sid);
      let ents;
      try { ents = await fsp.readdir(src, { withFileTypes: true }); } catch { continue; }
      const dstDir = path.join(FH_CACHE, sid);
      let made = fs.existsSync(dstDir);
      for (const ent of ents) {
        if (!ent.isFile() || ent.name.startsWith('.')) continue;
        const dst = path.join(dstDir, ent.name);
        if (fs.existsSync(dst)) continue; // immutable — copy once
        if (!made) { await fsp.mkdir(dstDir, { recursive: true }); made = true; }
        try { await fsp.copyFile(path.join(src, ent.name), dst); fhStats.copiedTotal++; } catch {}
      }
    }
    // inventory the cache, then enforce the size cap by evicting oldest-written first
    const entries = [];
    for (const sid of await fsp.readdir(FH_CACHE)) {
      const d = path.join(FH_CACHE, sid);
      try {
        for (const n of await fsp.readdir(d)) {
          const fp = path.join(d, n);
          try { const st = await fsp.stat(fp); if (st.isFile()) entries.push({ fp, dir: d, size: st.size, mtimeMs: st.mtimeMs }); } catch {}
        }
      } catch {}
    }
    let total = entries.reduce((a, e) => a + e.size, 0);
    if (FH_CACHE_MAX_BYTES && total > FH_CACHE_MAX_BYTES) {
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
      const dirs = new Set();
      for (const e of entries) {
        if (total <= FH_CACHE_MAX_BYTES) break;
        try { await fsp.unlink(e.fp); total -= e.size; fhStats.evictedTotal++; dirs.add(e.dir); } catch {}
      }
      for (const d of dirs) { try { if (!(await fsp.readdir(d)).length) await fsp.rmdir(d); } catch {} }
    }
    fhStats.cachedFiles = FH_CACHE_MAX_BYTES && entries.length ? entries.filter((e) => fs.existsSync(e.fp)).length : entries.length;
    fhStats.cachedBytes = total;
    fhStats.lastSweep = new Date().toISOString();
  } catch {}
}
mirrorFileHistory();
setInterval(mirrorFileHistory, 60_000);

// ---------- shared library: content-addressed cache of static context ----------
// System-prompt sections and tool definitions are largely identical across
// sessions. Every snapshot import seeds this library; exports can then send
// {ref} entries instead of re-transcribing, and the server re-inflates them.
const LIB_DIR = path.join(DATA_DIR, 'library');
fs.mkdirSync(path.join(LIB_DIR, 'sections'), { recursive: true });
fs.mkdirSync(path.join(LIB_DIR, 'tools'), { recursive: true });

const libSafe = (name) => String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'unnamed';
const libHash = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
const libCanonical = (type, entry) => type === 'section'
  ? String(entry.content ?? '')
  : JSON.stringify({ name: entry.name, description: entry.description || '', schema: entry.schema ?? null });

function libAdd(type, name, entry) {
  const text = libCanonical(type, entry);
  const ref = `${libSafe(name)}@${libHash(text)}`;
  const fp = path.join(LIB_DIR, type === 'section' ? 'sections' : 'tools', ref + '.json');
  if (!fs.existsSync(fp)) {
    fs.writeFileSync(fp, JSON.stringify({ type, name, ref, storedAt: new Date().toISOString(), entry }, null, 1));
  }
  return ref;
}

function libGet(type, ref) {
  const fp = path.join(LIB_DIR, type === 'section' ? 'sections' : 'tools', libSafe(ref.split('@')[0]) + '@' + (ref.split('@')[1] || '') + '.json');
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

// fingerprints let the model verify "what I see in context matches the cache"
// without re-transcribing: head/middle/tail excerpts + length
function libFp(text) {
  const t = String(text);
  const mid = Math.floor(t.length / 2);
  return { len: t.length, head: t.slice(0, 80), mid: t.slice(mid, mid + 60), tail: t.slice(-40) };
}

function libManifest() {
  const out = { sections: [], tools: [] };
  for (const type of ['sections', 'tools']) {
    for (const f of fs.readdirSync(path.join(LIB_DIR, type))) {
      if (!f.endsWith('.json')) continue;
      try {
        const e = JSON.parse(fs.readFileSync(path.join(LIB_DIR, type, f), 'utf8'));
        if (type === 'sections') {
          out.sections.push({ name: e.name, title: e.entry.title, ref: e.ref, fp: libFp(e.entry.content) });
        } else {
          const schema = e.entry.schema ?? {};
          out.tools.push({
            name: e.name, ref: e.ref,
            descFp: libFp(e.entry.description || ''),
            schemaParams: Object.keys(schema.properties || {}).sort(),
            schemaLen: JSON.stringify(schema).length,
          });
        }
      } catch {}
    }
  }
  return out;
}

// snapshots may carry {ref} entries — inflate them; full entries seed the library
function resolveSnapshot(snap) {
  if (Array.isArray(snap.systemPrompt)) {
    snap.systemPrompt = snap.systemPrompt.map((sec) => {
      if (sec && sec.ref && sec.content == null) {
        const e = libGet('section', sec.ref);
        return e ? { ...e.entry, ref: sec.ref, provenance: 'library' }
                 : { title: sec.title || sec.ref, content: `[unresolved library ref: ${sec.ref}]`, provenance: 'missing' };
      }
      if (sec && sec.content != null) sec.ref = libAdd('section', sec.title || 'untitled', { title: sec.title, content: sec.content, abridged: !!sec.abridged });
      return sec;
    });
  }
  if (Array.isArray(snap.tools)) {
    snap.tools = snap.tools.map((t) => {
      if (t && t.ref && t.description == null && t.schema == null) {
        const e = libGet('tool', t.ref);
        return e ? { ...e.entry, ref: t.ref, provenance: 'library' }
                 : { name: t.name || t.ref, description: `[unresolved library ref: ${t.ref}]`, provenance: 'missing' };
      }
      if (t && t.name) t.ref = libAdd('tool', t.name, { name: t.name, description: t.description, schema: t.schema ?? t.parameters ?? null });
      return t;
    });
  }
  return snap;
}

// boot: seed the library from every snapshot already stored
(function seedLibrary() {
  try {
    const root = path.join(DATA_DIR, 'sessions');
    for (const id of fs.readdirSync(root)) {
      const sd = path.join(root, id, 'snapshots');
      if (!fs.existsSync(sd)) continue;
      for (const f of fs.readdirSync(sd)) {
        if (!f.endsWith('.json')) continue;
        try {
          const snap = JSON.parse(fs.readFileSync(path.join(sd, f), 'utf8'));
          for (const sec of snap.systemPrompt || []) if (sec && sec.content != null) libAdd('section', sec.title || 'untitled', { title: sec.title, content: sec.content, abridged: !!sec.abridged });
          for (const t of snap.tools || []) if (t && t.name && (t.description != null || t.schema != null)) libAdd('tool', t.name, { name: t.name, description: t.description, schema: t.schema ?? t.parameters ?? null });
        } catch {}
      }
    }
  } catch {}
})();

// ---------- on-disk session discovery (read-only mount of ~/.claude/projects) ----------
const HOST_PROJECTS = process.env.HOST_PROJECTS !== undefined
  ? (process.env.HOST_PROJECTS || null)
  : defaultDir(path.join(os.homedir(), '.claude', 'projects'));
const HOST_CACHE = path.join(DATA_DIR, 'host-index.json');
const hostIndex = new Map(); // sessionId -> {sessionId, path, slug, mtimeMs, size, companionDir, meta}
let lastScan = 0;
let scanning = null;
try { for (const e of JSON.parse(fs.readFileSync(HOST_CACHE, 'utf8'))) hostIndex.set(e.sessionId, e); } catch {}

async function scanHost(force = false) {
  if (!HOST_PROJECTS || !fs.existsSync(HOST_PROJECTS)) return;
  if (scanning) return scanning;
  if (!force && Date.now() - lastScan < 15000) return;
  scanning = (async () => {
    try {
      const seen = new Set();
      for (const slug of await fsp.readdir(HOST_PROJECTS)) {
        const dir = path.join(HOST_PROJECTS, slug);
        let ents;
        try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const ent of ents) {
          if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
          const sid = ent.name.slice(0, -6);
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(sid)) continue;
          const fp = path.join(dir, ent.name);
          let st;
          try { st = await fsp.stat(fp); } catch { continue; }
          seen.add(sid);
          const prev = hostIndex.get(sid);
          if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) continue;
          const meta = summarizeTranscript(await fsp.readFile(fp));
          meta.project = slug;
          let companionDir = null;
          try { if ((await fsp.stat(path.join(dir, sid))).isDirectory()) companionDir = path.join(dir, sid); } catch {}
          hostIndex.set(sid, { sessionId: sid, path: fp, slug, mtimeMs: st.mtimeMs, size: st.size, companionDir, meta });
        }
      }
      for (const sid of [...hostIndex.keys()]) if (!seen.has(sid)) hostIndex.delete(sid);
      lastScan = Date.now();
      await fsp.writeFile(HOST_CACHE, JSON.stringify([...hostIndex.values()]));
    } finally { scanning = null; }
  })();
  return scanning;
}
scanHost(true); // warm the index at boot

// ---------- helpers ----------

function send(res, status, body, type) {
  const buf = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type || (typeof body === 'object' && !Buffer.isBuffer(body) ? MIME['.json'] : 'text/plain; charset=utf-8'),
    'Content-Length': Buffer.byteLength(buf),
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Session ids and file names come from the network: never let them escape DATA_DIR.
function safeSessionDir(sessionId) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return null;
  return path.join(DATA_DIR, 'sessions', sessionId);
}

function safeJoin(base, rel) {
  const p = path.normalize(path.join(base, rel));
  if (!p.startsWith(base + path.sep) && p !== base) return null;
  return p;
}

// One streaming pass over the transcript to build the session card shown in the list.
function summarizeTranscript(buf) {
  const meta = {
    title: null,
    rootUuid: null,
    sessionKind: null,
    customTitle: null,
    firstTimestamp: null,
    lastTimestamp: null,
    firstUserPrompt: null,
    counts: {},
    compactBoundaries: 0,
    cliVersion: null,
    cwd: null,
    gitBranch: null,
    lineCount: 0,
    bytes: buf.length,
  };
  const text = buf.toString('utf8');
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end).trim();
    start = end + 1;
    if (!line) continue;
    meta.lineCount++;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    meta.counts[rec.type] = (meta.counts[rec.type] || 0) + 1;
    if (rec.timestamp) {
      // min/max, not file order — continuation files interleave fresh bookkeeping
      // (dated now) ahead of replayed history (dated earlier)
      if (!meta.firstTimestamp || rec.timestamp < meta.firstTimestamp) meta.firstTimestamp = rec.timestamp;
      if (!meta.lastTimestamp || rec.timestamp > meta.lastTimestamp) meta.lastTimestamp = rec.timestamp;
    }
    if (!meta.rootUuid && rec.type === 'user' && rec.origin && rec.origin.kind === 'human' && rec.uuid) meta.rootUuid = rec.uuid;
    if (!meta.sessionKind && rec.sessionKind) meta.sessionKind = rec.sessionKind;
    if (rec.type === 'ai-title' && (rec.aiTitle || rec.title)) meta.title = rec.aiTitle || rec.title;
    if (rec.type === 'custom-title' && (rec.customTitle || rec.title)) meta.customTitle = rec.customTitle || rec.title;
    if (rec.type === 'system' && rec.subtype === 'compact_boundary') meta.compactBoundaries++;
    if (rec.type === 'user' && !meta.firstUserPrompt && !rec.isCompactSummary && rec.message) {
      const c = rec.message.content;
      const s = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : '';
      if (s && !s.startsWith('<')) meta.firstUserPrompt = s.slice(0, 300);
    }
    if (!meta.cliVersion && rec.version) meta.cliVersion = rec.version;
    if (!meta.cwd && rec.cwd) meta.cwd = rec.cwd;
    if (rec.gitBranch) meta.gitBranch = rec.gitBranch;
  }
  return meta;
}

async function listSessions() {
  const root = path.join(DATA_DIR, 'sessions');
  const out = [];
  for (const id of await fsp.readdir(root)) {
    const dir = path.join(root, id);
    try {
      const st = await fsp.stat(dir);
      if (!st.isDirectory()) continue;
      let meta = {};
      try { meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8')); } catch {}
      let snapshots = [];
      try { snapshots = (await fsp.readdir(path.join(dir, 'snapshots'))).filter((f) => f.endsWith('.json')); } catch {}
      let files = [];
      try { files = await walkFiles(path.join(dir, 'files')); } catch {}
      out.push({ sessionId: id, ...meta, source: 'imported', snapshotCount: snapshots.length, fileCount: files.length });
    } catch {}
  }
  for (const [id, d] of demoSessions) {
    out.push({ sessionId: id, ...d.meta, source: 'demo', snapshotCount: Object.keys(d.snapshots).length, fileCount: Object.keys(d.files).length });
  }
  try { await scanHost(); } catch {}
  const importedIds = new Set(out.map((x) => x.sessionId));
  for (const e of hostIndex.values()) {
    if (importedIds.has(e.sessionId)) continue;
    out.push({ sessionId: e.sessionId, ...e.meta, source: 'disk', snapshotCount: 0, fileCount: e.companionDir ? 1 : 0 });
  }
  out.sort((a, b) => String(b.lastTimestamp || '').localeCompare(String(a.lastTimestamp || '')));
  return out;
}

async function walkFiles(dir, prefix = '') {
  const out = [];
  for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...(await walkFiles(path.join(dir, ent.name), rel)));
    else out.push(rel);
  }
  return out;
}

// ---------- routing ----------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    if (p === '/api/health') return send(res, 200, { ok: true, version: 1, fileHistoryMirror: fhStats });

    if (p.startsWith('/api/import/') && req.method === 'POST') {
      const sessionId = url.searchParams.get('session') || '';
      const dir = safeSessionDir(sessionId);
      if (!dir) return send(res, 400, { error: 'invalid or missing session id' });
      const body = await readBody(req);
      if (!body.length) return send(res, 400, { error: 'empty body' });

      if (p === '/api/import/transcript') {
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(path.join(dir, 'transcript.jsonl'), body);
        const meta = summarizeTranscript(body);
        meta.project = url.searchParams.get('project') || null;
        meta.importedAt = new Date().toISOString();
        await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
        return send(res, 200, { ok: true, sessionId, ...meta });
      }

      if (p === '/api/import/snapshot') {
        let snap;
        try { snap = JSON.parse(body.toString('utf8')); } catch { return send(res, 400, { error: 'snapshot must be valid JSON' }); }
        snap = resolveSnapshot(snap);
        snap.receivedAt = new Date().toISOString();
        const name = `snapshot-${snap.receivedAt.replace(/[:.]/g, '-')}.json`;
        await fsp.mkdir(path.join(dir, 'snapshots'), { recursive: true });
        await fsp.writeFile(path.join(dir, 'snapshots', name), JSON.stringify(snap, null, 2));
        return send(res, 200, { ok: true, sessionId, snapshot: name });
      }

      if (p === '/api/import/file') {
        const name = url.searchParams.get('name') || '';
        const filesDir = path.join(dir, 'files');
        const dest = safeJoin(filesDir, name);
        if (!name || !dest) return send(res, 400, { error: 'invalid file name' });
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, body);
        return send(res, 200, { ok: true, sessionId, file: name, bytes: body.length });
      }
      return send(res, 404, { error: 'unknown import endpoint' });
    }

    // actual file contents captured by Claude Code's edit tracking
    const fh = p.match(/^\/api\/filehistory\/([A-Za-z0-9-]+)(?:\/(.+))?$/);
    if (fh && req.method === 'GET') {
      const dirs = [FH_HOST && path.join(FH_HOST, fh[1]), path.join(FH_CACHE, fh[1])].filter((d) => d && fs.existsSync(d));
      if (!dirs.length) return send(res, 404, { error: 'no file history for this session (live or cached)' });
      if (!fh[2]) {
        const names = new Set();
        for (const d of dirs) for (const n of await fsp.readdir(d)) if (!n.startsWith('.')) names.add(n);
        return send(res, 200, [...names]);
      }
      for (const d of dirs) {
        const f = safeJoin(d, decodeURIComponent(fh[2]));
        if (f && fs.existsSync(f)) {
          res.setHeader('X-FileHistory-Source', d.startsWith(FH_CACHE) ? 'cache' : 'live');
          return send(res, 200, await fsp.readFile(f), 'text/plain; charset=utf-8');
        }
      }
      return send(res, 404, { error: 'version not found (live or cached)' });
    }

    if (p === '/api/library/manifest' && req.method === 'GET') {
      return send(res, 200, libManifest());
    }
    if (p === '/api/library/entry' && req.method === 'GET') {
      const e = libGet(url.searchParams.get('type') === 'section' ? 'section' : 'tool', url.searchParams.get('ref') || '');
      return e ? send(res, 200, e) : send(res, 404, { error: 'not in library' });
    }

    if (p === '/api/sessions' && req.method === 'GET') {
      return send(res, 200, await listSessions());
    }

    // full-content search across every known transcript (imported + on-disk)
    if (p === '/api/search' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      if (q.length < 3) return send(res, 200, []);
      try { await scanHost(); } catch {}
      const sources = [...hostIndex.values()].map((e) => ({ sid: e.sessionId, file: e.path }));
      for (const id of await fsp.readdir(path.join(DATA_DIR, 'sessions'))) {
        const t = path.join(DATA_DIR, 'sessions', id, 'transcript.jsonl');
        if (!hostIndex.has(id) && fs.existsSync(t)) sources.push({ sid: id, file: t });
      }
      const results = [];
      for (const src of sources) {
        try {
          const text = await fsp.readFile(src.file, 'utf8');
          const lower = text.toLowerCase();
          let i = lower.indexOf(q);
          if (i === -1) continue;
          let count = 0, j = i;
          while (j !== -1 && count < 500) { count++; j = lower.indexOf(q, j + q.length); }
          results.push({ sessionId: src.sid, count, snippet: text.slice(Math.max(0, i - 60), i + q.length + 60).replace(/\s+/g, ' ') });
        } catch {}
        if (results.length >= 50) break;
      }
      return send(res, 200, results);
    }

    const m = p.match(/^\/api\/sessions\/([^/]+)(\/.*)?$/);
    if (m) {
      const demo = demoSessions.get(m[1]);
      const dir = safeSessionDir(m[1]);
      const imported = !demo && dir && fs.existsSync(dir);
      let host = demo ? null : hostIndex.get(m[1]);
      if (!demo && !imported && !host) { try { await scanHost(); } catch {} host = hostIndex.get(m[1]); }
      if (!demo && !imported && !host) return send(res, 404, { error: 'session not found' });
      const rest = m[2] || '';
      if (demo) {
        if (req.method === 'DELETE') return send(res, 400, { error: 'demo session is in-memory and read-only' });
        if (rest === '/transcript') return send(res, 200, demo.transcript, MIME['.jsonl']);
        if (rest === '' || rest === '/') return send(res, 200, { sessionId: m[1], ...demo.meta, source: 'demo', snapshots: Object.keys(demo.snapshots).sort(), files: Object.keys(demo.files).sort() });
        if (rest.startsWith('/snapshots/')) {
          const b = demo.snapshots[decodeURIComponent(rest.slice('/snapshots/'.length))];
          return b ? send(res, 200, b, MIME['.json']) : send(res, 404, { error: 'snapshot not found' });
        }
        if (rest === '/memory') return send(res, 200, demo.memory || { files: [] });
        if (rest.startsWith('/files/')) {
          const b = demo.files[decodeURIComponent(rest.slice('/files/'.length))];
          return b ? send(res, 200, b, 'text/plain; charset=utf-8') : send(res, 404, { error: 'file not found' });
        }
        return send(res, 404, { error: 'not found' });
      }

      if (req.method === 'DELETE' && !rest) {
        if (!imported) return send(res, 400, { error: 'on-disk session — nothing imported to delete' });
        await fsp.rm(dir, { recursive: true, force: true });
        return send(res, 200, { ok: true });
      }
      if (rest === '/transcript') {
        const f = imported ? path.join(dir, 'transcript.jsonl') : host.path;
        return send(res, 200, await fsp.readFile(f), MIME['.jsonl']);
      }
      // Claude's persistent memory for the project this session belongs to
      if (rest === '/memory') {
        let slug = host?.slug || null;
        if (!slug && imported) {
          try { slug = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8')).project; } catch {}
        }
        const memDir = HOST_PROJECTS && slug ? path.join(HOST_PROJECTS, slug, 'memory') : null;
        if (!memDir || !fs.existsSync(memDir)) return send(res, 200, { files: [] });
        const out = [];
        for (const name of (await fsp.readdir(memDir)).sort()) {
          if (!name.endsWith('.md')) continue;
          const fp = path.join(memDir, name);
          try {
            const st2 = await fsp.stat(fp);
            if (st2.isFile()) out.push({ name, content: await fsp.readFile(fp, 'utf8'), modified: st2.mtime.toISOString() });
          } catch {}
        }
        return send(res, 200, { slug, files: out });
      }
      if (rest === '' || rest === '/') {
        if (imported) {
          let meta = {};
          try { meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8')); } catch {}
          let snapshots = [];
          try { snapshots = (await fsp.readdir(path.join(dir, 'snapshots'))).filter((f) => f.endsWith('.json')).sort(); } catch {}
          let files = [];
          try { files = await walkFiles(path.join(dir, 'files')); } catch {}
          return send(res, 200, { sessionId: m[1], ...meta, source: 'imported', snapshots, files });
        }
        let files = [];
        try { if (host.companionDir) files = await walkFiles(host.companionDir); } catch {}
        return send(res, 200, { sessionId: m[1], ...host.meta, source: 'disk', snapshots: [], files });
      }
      if (rest.startsWith('/snapshots/')) {
        if (!imported) return send(res, 404, { error: 'on-disk sessions have no snapshots — run /snapshot in that session' });
        const f = safeJoin(path.join(dir, 'snapshots'), rest.slice('/snapshots/'.length));
        if (!f || !fs.existsSync(f)) return send(res, 404, { error: 'snapshot not found' });
        return send(res, 200, await fsp.readFile(f), MIME['.json']);
      }
      if (rest.startsWith('/files/')) {
        const base = imported ? path.join(dir, 'files') : host.companionDir;
        const f = base ? safeJoin(base, decodeURIComponent(rest.slice('/files/'.length))) : null;
        if (!f || !fs.existsSync(f)) return send(res, 404, { error: 'file not found' });
        return send(res, 200, await fsp.readFile(f), MIME[path.extname(f)] || 'text/plain; charset=utf-8');
      }
      return send(res, 404, { error: 'not found' });
    }

    // static SPA
    if (req.method === 'GET') {
      let rel = p === '/' ? '/index.html' : p;
      const f = safeJoin(PUBLIC_DIR, rel);
      if (f && fs.existsSync(f) && fs.statSync(f).isFile()) {
        return send(res, 200, await fsp.readFile(f), MIME[path.extname(f)] || 'application/octet-stream');
      }
      // hash-routed SPA: any other GET falls through to the shell
      return send(res, 200, await fsp.readFile(path.join(PUBLIC_DIR, 'index.html')), MIME['.html']);
    }

    return send(res, 405, { error: 'method not allowed' });
  } catch (err) {
    send(res, err.status || 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ReClaude listening on http://${HOST}:${PORT} (data: ${DATA_DIR})`);
});
