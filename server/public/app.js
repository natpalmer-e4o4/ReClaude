/* ReClaude SPA — parses raw session JSONL client-side and reconstructs
   the effective context window at any selected record.
   Reconstruction rules (derived from real Claude Code transcripts):
   - records link via parentUuid: context-at-point = parent-chain walk to root
   - compact_boundary records have parentUuid null, so the chain walk naturally
     stops at the live context's edge after a compaction
   - isSidechain records are subagent turns; never part of the main context
   - attachment kinds have different semantics: deferred_tools_delta accumulates,
     skill_listing / output_style / agent_listing supersede, mcp_instructions accumulates */
'use strict';

/* Canvas palette is read from the stylesheet, so switching themes repaints the
   tape, minimap and lanes without any colour literals in the drawing code. */
const CANVAS = {};
function readThemeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
  KIND_COLORS.user = v('--k-user', '#4a8fdd');
  KIND_COLORS.attach = v('--k-attach', '#27a578');
  KIND_COLORS.assistant = v('--k-assistant', '#c08618');
  KIND_COLORS.tool = v('--k-tool', '#8a5fe8');
  KIND_COLORS.srvtool = KIND_COLORS.tool;
  KIND_COLORS.event = v('--k-event', '#d75d84');
  CANVAS.accent = v('--accent', '#e9b949');
  ACCENT = CANVAS.accent;
  CANVAS.curve = v('--c-curve', '#c08618');
  CANVAS.curveFill = v('--c-curve-fill', 'rgba(192,134,24,0.26)');
  CANVAS.hair = v('--c-hair', 'rgba(226,234,226,0.35)');
  CANVAS.band = v('--c-band', 'rgba(226,234,226,0.08)');
  CANVAS.viewport = v('--c-viewport', 'rgba(226,234,226,0.12)');
  CANVAS.grid = v('--c-grid', 'rgba(226,234,226,0.10)');
  CANVAS.gapText = v('--c-gaptext', 'rgba(226,234,226,0.75)');
  CANVAS.gapLine = v('--c-gapline', 'rgba(144,169,152,0.45)');
  CANVAS.gapFill = v('--c-gapfill', 'rgba(95,122,104,0.16)');
}

/* Themes are declared here so the picker can render its own swatches — a
   native <select> can't be themed, and its popup is drawn by the OS. */
// `dot` is what the theme reads as at a glance — its character, not always its
// accent (forest is green velvet even though its accent is brass)
const THEMES = [
  { id: 'forest', label: 'forest', mode: 'dark', bg: '#0f1a13', panel: '#16241b', dot: '#27a578' },
  { id: 'instrument', label: 'instrument', mode: 'dark', bg: '#14181f', panel: '#1b2029', dot: '#4a8fdd' },
  { id: 'ember', label: 'ember', mode: 'dark', bg: '#191512', panel: '#221d19', dot: '#e0904f' },
  { id: 'paper', label: 'paper', mode: 'light', bg: '#f4f2ec', panel: '#d9d5ca', dot: '#b07a12' },
  { id: 'linen', label: 'linen', mode: 'light', bg: '#eef1f4', panel: '#ccd4dc', dot: '#3574c4' },
  { id: 'sage', label: 'sage', mode: 'light', bg: '#eef2ec', panel: '#cbd6c5', dot: '#1a7d5e' },
];

function themeSwatch(t) {
  return `<span class="sw" style="background:${t.bg};border-color:${t.panel}"><i style="background:${t.dot}"></i></span>`;
}

function applyTheme(name, { persist = true } = {}) {
  const t = THEMES.find((x) => x.id === name) || THEMES[0];
  document.documentElement.dataset.theme = t.id;
  if (persist) { try { localStorage.setItem('reclaude-theme', t.id); } catch {} }
  readThemeColors();
  const btn = document.getElementById('themeBtn');
  if (btn) btn.innerHTML = `${themeSwatch(t)}<span class="theme-name">${esc(t.label)}</span><span class="caret">▾</span>`;
  document.querySelectorAll('#themeMenu [role="option"]').forEach((o) => {
    o.setAttribute('aria-selected', String(o.dataset.t === t.id));
  });
  const s = state.session;
  if (s) { drawTape(s); renderRailMap(s); renderLanes(s); }
}

function initTheme() {
  let saved = null;
  // 'ctx-theme' is the pre-rename key, read as a fallback so a returning user keeps their theme.
  try { saved = localStorage.getItem('reclaude-theme') || localStorage.getItem('ctx-theme'); } catch {}
  const menu = document.getElementById('themeMenu');
  const btn = document.getElementById('themeBtn');
  if (!menu || !btn) { applyTheme(saved || 'forest', { persist: false }); return; }

  const groups = [['dark', 'dark'], ['light', 'light']];
  menu.innerHTML = groups.map(([mode, label]) =>
    `<div class="theme-grp">${label}</div>` +
    THEMES.filter((t) => t.mode === mode).map((t) =>
      `<button type="button" role="option" data-t="${t.id}" aria-selected="false">${themeSwatch(t)}<span class="theme-name">${esc(t.label)}</span></button>`).join('')).join('');

  const opts = () => [...menu.querySelectorAll('[role="option"]')];
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  const open = () => {
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    (opts().find((o) => o.getAttribute('aria-selected') === 'true') || opts()[0])?.focus();
  };
  btn.addEventListener('click', () => (menu.hidden ? open() : close()));
  menu.addEventListener('click', (e) => {
    const o = e.target.closest('[role="option"]');
    if (!o) return;
    applyTheme(o.dataset.t);
    close();
    btn.focus();
  });
  menu.addEventListener('keydown', (e) => {
    const list = opts();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1) + list.length) % list.length]?.focus();
    } else if (e.key === 'Escape') { e.preventDefault(); close(); btn.focus(); }
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !document.getElementById('themePick').contains(e.target)) close();
  });

  const valid = saved && THEMES.some((t) => t.id === saved);
  applyTheme(valid ? saved : 'forest', { persist: false });
}

const KIND_COLORS = {
  user: '#4a8fdd',
  assistant: '#c08618',
  tool: '#8a5fe8',
  attach: '#27a578',
  event: '#d75d84',
  srvtool: '#8a5fe8', // tool family violet; hollow marks are the distinguisher
};
const KIND_LABELS = { user: 'user', assistant: 'assistant', tool: 'tool i/o', srvtool: 'server tool', attach: 'context Δ', event: 'event' };
const LEGEND = [
  { k: 'user', f: 'user', name: 'user', swatch: 'box',
    desc: 'A message a human typed (the transcript marks these origin: human). Skill loads and other harness-injected user-role records are classified as context Δ instead.' },
  { k: 'assistant', f: 'assistant', name: 'assistant', swatch: 'box',
    desc: "A turn from Claude: response text and thinking blocks. The token counts on these records are what the amber curve plots." },
  { k: 'tool', f: 'tool', name: 'tool i/o', swatch: 'box',
    desc: 'Tool traffic: Claude invoking a tool (Bash, Read, Edit, …) or the result coming back. Usually the bulk of a working session.' },
  { k: 'srvtool', f: 'srvtool', name: 'server tool', swatch: 'hollow',
    desc: "Tool traffic that runs on Anthropic's servers instead of this machine — the advisor consult, web search/fetch. Drawn hollow to set it apart from local tool i/o; results may come back encrypted." },
  { k: 'attach', f: 'attach', name: 'context Δ', swatch: 'box',
    desc: 'Things the harness injects into the context between messages: newly surfaced tool names, skill listings, MCP server instructions, output styles.' },
  { k: 'event', f: 'event', name: 'event', swatch: 'box',
    desc: 'Harness events outside the conversation: compaction boundaries, away-summaries, local command output.' },
  { k: 'event', f: 'compact', name: 'compaction splice', swatch: 'line',
    desc: 'Where the context window was compacted: everything left of the dashed line was dropped from the live window and replaced by a harness-written summary message (labeled "compact summary" — it is not a human turn). This filter matches both the boundary and its summary.' },
];
let ACCENT = '#e9b949'; // replaced from the stylesheet by readThemeColors()

const $view = document.getElementById('view');
const state = { sessions: null, session: null };

// ---------- utilities ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtInt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

/* ---------- JSON code blocks (CodeMirror, lazy) ----------
   jsonBlock(value) renders pretty-printed JSON with line numbers. Instances are
   created only when their content becomes visible (a <details> opens), so
   hundreds of collapsed blocks cost nothing. Falls back to a plain <pre> if
   CodeMirror is unavailable. */
let JSON_STORE = [];

/* Recursively expand string values that are themselves JSON (stringified
   payloads) so they indent properly instead of rendering as one escaped line.
   Sets state.expanded when it changed anything, so the block can say so. */
function deepPretty(v, state) {
  if (typeof v === 'string') {
    const t = v.trim();
    if ((t.startsWith('{') || t.startsWith('[')) && t.length > 2) {
      try {
        const parsed = JSON.parse(t);
        if (parsed && typeof parsed === 'object') { state.expanded = true; return deepPretty(parsed, state); }
      } catch { /* not JSON — leave as-is */ }
    }
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => deepPretty(x, state));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = deepPretty(val, state);
    return o;
  }
  return v;
}

function jsonBlock(value) {
  const state = { expanded: false };
  let text;
  try {
    let v = typeof value === 'string' ? JSON.parse(value) : value;
    v = deepPretty(v, state);
    text = JSON.stringify(v, null, 2);
  } catch {
    text = typeof value === 'string' ? value : String(value);
  }
  const note = state.expanded ? `<div class="blk-tag" style="margin-top:2px">embedded JSON strings expanded for display</div>` : '';
  if (text.length > CM_MAX_CHARS) return `<div class="blk-tag">large content — shown without line numbers</div><pre class="block">${esc(text)}</pre>${note}`;
  const jid = JSON_STORE.push({ text, json: true }) - 1;
  return `<div class="cm-json" data-jid="${jid}"><pre class="block">${esc(text)}</pre></div>${note}`;
}

/* Plain-text code block with line numbers (file contents, edit strings). */
const CM_MAX_CHARS = 512_000; // beyond this, CodeMirror's full render is too slow — plain <pre> instead

function codeBlock(text) {
  const t = String(text ?? '');
  if (t.length > CM_MAX_CHARS) return `<div class="blk-tag">large content — shown without line numbers</div><pre class="block">${esc(t)}</pre>`;
  const jid = JSON_STORE.push({ text: t, json: false }) - 1;
  return `<div class="cm-json" data-jid="${jid}"><pre class="block">${esc(t)}</pre></div>`;
}

/* Registry of previewable items for the current panel render; rows carry
   data-pvi indexes into it and clicks route the item to the preview pane. */
let PV_ITEMS = [];
function pvRow(item, opts = {}) {
  const i = PV_ITEMS.push(item) - 1;
  return `<div class="msg mrow" data-pvi="${i}" tabindex="0" role="button">
    <span class="role" style="color:${opts.color || 'var(--muted)'}">${esc(opts.icon || '·')}</span>
    <span class="prev">${esc(opts.label)}</span>${opts.sub ? `<span class="tok-d" style="color:var(--faint)">${esc(opts.sub)}</span>` : ''}</div>`;
}

function isJsonText(t) {
  if (typeof t !== 'string' || !/^\s*[\[{]/.test(t)) return false;
  try { JSON.parse(t); return true; } catch { return false; }
}

function initJsonBlocks(root) {
  if (!window.CodeMirror || !root?.querySelectorAll) return;
  root.querySelectorAll('.cm-json[data-jid]:not([data-init])').forEach((box) => {
    if (box.closest('details:not([open])')) return; // still hidden — wait for toggle
    const entry = JSON_STORE[+box.dataset.jid];
    if (entry == null) return;
    box.dataset.init = '1';
    try {
      box.textContent = '';
      const cm = CodeMirror(box, {
        value: entry.text,
        mode: entry.json ? { name: 'javascript', json: true } : null,
        theme: 'ctx',
        lineNumbers: true,
        readOnly: true,
        lineWrapping: true,
        viewportMargin: Infinity, // auto-height: render all lines or the rest is clipped
      });
      requestAnimationFrame(() => cm.refresh());
    } catch { /* keep the <pre> fallback */ }
  });
}

// <details> toggle events don't bubble; a capture listener catches them all
document.addEventListener('toggle', (e) => {
  if (e.target?.tagName === 'DETAILS' && e.target.open) initJsonBlocks(e.target);
}, true);

// CodeMirror registers its own wheel handler (bubble phase, on its scroller) and
// simulates scrolling even when its scroller can't move — swallowing the wheel.
// In the preview pane and center panel nothing scrolls internally, so stop the
// event in the capture phase before CM sees it; native pane scrolling proceeds.
// CM5 listens for the legacy 'mousewheel'/'DOMMouseScroll' events (not 'wheel');
// Safari dispatches those separately, so all three must be stopped.
for (const evt of ['wheel', 'mousewheel', 'DOMMouseScroll']) {
  document.addEventListener(evt, (e) => {
    if (e.target?.closest?.('.CodeMirror') && e.target.closest('.pv-body, #panel')) e.stopPropagation();
  }, { capture: true, passive: true });
}

/* Data source routing. By default the app talks to its Node server; a static
   export (see scripts/build-static-demo.py) sets window.CTX_STATIC and every
   request resolves to a relative file path instead, so the same SPA runs on any
   static host (GitHub Pages) with no server at all. */
const STATIC = typeof window !== 'undefined' && !!window.CTX_STATIC;
const API = {
  sessions: () => (STATIC ? 'data/sessions.json' : '/api/sessions'),
  session: (id) => (STATIC ? `data/s/${id}/meta.json` : `/api/sessions/${id}`),
  transcript: (id) => (STATIC ? `data/s/${id}/transcript.jsonl` : `/api/sessions/${id}/transcript`),
  snapshot: (id, name) => (STATIC ? `data/s/${id}/snapshots/${name}` : `/api/sessions/${id}/snapshots/${name}`),
  file: (id, rel) => (STATIC ? `data/s/${id}/files/${rel}` : `/api/sessions/${id}/files/${encodeURIComponent(rel)}`),
  fhList: (id) => (STATIC ? `data/s/${id}/filehistory.json` : `/api/filehistory/${id}`),
  fhVersion: (id, name) => (STATIC ? `data/s/${id}/fh/${name}` : `/api/filehistory/${id}/${encodeURIComponent(name)}`),
  memory: (id) => (STATIC ? `data/s/${id}/memory.json` : `/api/sessions/${id}/memory`),
};

async function jget(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}
async function tget(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

// ---------- transcript model ----------

function parseTranscript(jsonl) {
  const records = [];
  for (const line of jsonl.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { records.push(JSON.parse(t)); } catch { /* tolerate partial lines */ }
  }
  // content records: things that occupy (or mark the edge of) the context window
  const content = records.filter((r) =>
    r.type === 'user' || r.type === 'assistant' || r.type === 'attachment' ||
    (r.type === 'system' && r.subtype !== 'turn_duration'));
  const byUuid = new Map();
  for (const r of records) if (r.uuid) byUuid.set(r.uuid, r);
  const idxOf = new Map();
  content.forEach((r, i) => { if (r.uuid) idxOf.set(r.uuid, i); });
  return { records, content, byUuid, idxOf };
}

function recKind(r) {
  if (r.type === 'attachment') return 'attach';
  if (r.type === 'system') return 'event';
  if (r.type === 'assistant') {
    const blocks = Array.isArray(r.message?.content) ? r.message.content : [];
    if (blocks.some((b) => b.type === 'server_tool_use')) return 'srvtool';
    return blocks.length && blocks.every((b) => b.type === 'tool_use') ? 'tool' : 'assistant';
  }
  if (r.type === 'user') {
    const c = r.message?.content;
    if (Array.isArray(c)) {
      // advisor_tool_result etc. — server-side results have suffixed block types
      if (c.some((b) => /_tool_result$/.test(b.type || ''))) return 'srvtool';
      if (c.length && c.every((b) => b.type === 'tool_result')) return 'tool';
    }
    // the post-compaction summary is written by the harness on the user's
    // behalf — its isCompactSummary flag is the deterministic marker
    if (r.isCompactSummary) return 'event';
    // ground truth: the harness stamps human-typed turns with origin.kind='human'
    // (promptSource typed/queued/suggestion_accepted). Content plays no part.
    const o = r.origin?.kind;
    if (o === 'human') return 'user';
    if (o === 'task-notification') return 'event';
    if (r.isMeta) return 'attach'; // skill content, context dumps — harness-injected
    if (o != null || r.promptSource === 'sdk') return 'user'; // other explicit origins: programmatic prompts
    // legacy records with no origin field: conservative content-marker fallback
    const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b) => b.type === 'text')?.text || '') : '';
    if (/^\s*<(command-message|command-name|local-command|system-reminder|task-notification)/.test(text)) return 'attach';
    if (/^\s*\[Request interrupted/.test(text)) return 'event';
    return 'user';
  }
  return 'event';
}

function recPreview(r) {
  if (r.type === 'attachment') {
    const a = r.attachment || {};
    if (a.type === 'deferred_tools_delta') return `deferred tools ${a.addedNames ? '+' + a.addedNames.length : ''}`;
    if (a.type === 'skill_listing') return `skill listing (${a.skillCount ?? '?'} skills)`;
    if (a.type === 'total_tokens_reminder') {
      const m = String(a.text || '').match(/(\d[\d,]*)/);
      return m ? `token budget: ${fmtInt(+m[1].replace(/,/g, ''))} left` : 'token budget reminder';
    }
    return a.type || 'attachment';
  }
  if (r.type === 'system') {
    if (r.subtype === 'compact_boundary') {
      const m = r.compactMetadata || {};
      return `COMPACTION ${fmtInt(m.preTokens)} → ${fmtInt(m.postTokens)} tok (${m.trigger || '?'})`;
    }
    return `${r.subtype || 'system'}: ${String(r.content ?? '').slice(0, 120)}`;
  }
  const c = r.message?.content;
  if (typeof c === 'string') return c.slice(0, 160);
  if (Array.isArray(c)) {
    for (const b of c) {
      if (b.type === 'text' && b.text) return b.text.slice(0, 160);
      if (b.type === 'tool_use') return `→ ${b.name}(${JSON.stringify(b.input ?? {}).slice(0, 110)})`;
      if (b.type === 'tool_result') {
        const inner = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x) => x.text || '').join(' ') : '';
        return `← ${String(inner).slice(0, 150)}`;
      }
      if (b.type === 'thinking') return `[thinking] ${String(b.thinking || '').slice(0, 140)}`;
      if (b.type === 'server_tool_use') return `⇄ ${b.name}(${JSON.stringify(b.input ?? {}).slice(0, 100)})`;
      if (/_tool_result$/.test(b.type || '')) return `⇄ ${b.type.replace('_tool_result', '')} result (server-side)`;
    }
  }
  return r.type;
}

function usageOf(r) {
  const u = r.message?.usage;
  if (!u) return null;
  // multi-iteration turns (one logical turn, several API calls) report SUMMED
  // usage at the top level — the real window size is the last iteration's
  const last = Array.isArray(u.iterations) && u.iterations.length > 1 ? u.iterations[u.iterations.length - 1] : u;
  const ctx = (last.input_tokens || 0) + (last.cache_read_input_tokens || 0) + (last.cache_creation_input_tokens || 0);
  if (!ctx && !(u.output_tokens || 0)) return null; // errored/empty call — not a measurement
  return { ctx, out: u.output_tokens || 0, u: last === u ? u : { ...last, output_tokens: u.output_tokens } };
}

/* Effective context chain at a content record: walk parentUuid to root.
   Returns { chain, boundary } where boundary is the compact_boundary reached, if any. */
function chainAt(model, rec) {
  let start = rec;
  // meta/system rows without a chain link: anchor to the nearest prior linked record
  const idx = model.content.indexOf(rec);
  let i = idx;
  while (start && !start.uuid && i > 0) start = model.content[--i];
  const chain = [];
  const seen = new Set();
  let cur = start;
  while (cur && cur.uuid && !seen.has(cur.uuid)) {
    seen.add(cur.uuid);
    if (!cur.isSidechain) chain.push(cur);
    cur = cur.parentUuid ? model.byUuid.get(cur.parentUuid) : null;
  }
  chain.reverse();
  const boundary = chain.find((r) => r.type === 'system' && r.subtype === 'compact_boundary') || null;
  return { chain, boundary };
}

/* Session-lifetime attachment state accumulated chronologically up to (and incl.) index. */
function stateAt(model, idx) {
  const s = { deferredTools: new Set(), skillListing: null, mcpInstructions: [], outputStyle: null, agentListing: null, other: [] };
  for (let i = 0; i <= idx; i++) {
    const r = model.content[i];
    if (r.type !== 'attachment') continue;
    const a = r.attachment || {};
    switch (a.type) {
      case 'deferred_tools_delta':
        (a.addedNames || []).forEach((n) => s.deferredTools.add(n));
        (a.removedNames || []).forEach((n) => s.deferredTools.delete(n));
        break;
      case 'skill_listing': s.skillListing = a; break;
      case 'mcp_instructions_delta': s.mcpInstructions.push(a); break;
      case 'output_style': s.outputStyle = a; break;
      case 'agent_listing_delta': s.agentListing = a; break;
      default: s.other.push(a);
    }
  }
  return s;
}

/* In-session text search: case-insensitive substring over the raw record JSON,
   cached per record on first use. Empty query matches everything. */
function matchText(r, q) {
  if (!q) return true;
  if (r._st === undefined) { try { r._st = JSON.stringify(r).toLowerCase(); } catch { r._st = ''; } }
  return r._st.includes(q);
}
function matchesQuery(s, r) { return matchText(r, (s.q || '').toLowerCase()); }

/* Category filter: empty set = everything. 'compact' is a pseudo-kind matching
   only compaction boundaries (a sub-kind of 'event'). */
function matchesFilter(s, r) {
  if (!s.filter || !s.filter.size) return true;
  if (s.filter.has(recKind(r))) return true;
  if (s.filter.has('compact') && ((r.type === 'system' && r.subtype === 'compact_boundary') || r.isCompactSummary)) return true;
  return false;
}

/* Resolve a tool name to the best definition we have: the snapshot's
   transcribed definition, else MCP server instructions, else the honest truth
   about deferred names. */
function fullStateOf(model) {
  if (!model._fullState) model._fullState = stateAt(model, model.content.length - 1);
  return model._fullState;
}

function toolDefTarget(s, name) {
  const snap = s.snapshots[s.snapIdx]?.data;
  const t = snap?.tools?.find((x) => x.name === name);
  if (t) return { kind: 'tool', badge: 'tool definition', color: 'var(--k-tool)', tool: t, sub: t.provenance === 'library' ? 'from shared cache' : 'as transcribed' };
  const st = fullStateOf(s.model);
  if (name.startsWith('mcp__') && st.mcpInstructions.length) {
    return { kind: 'text', badge: 'mcp tool', color: 'var(--k-attach)', title: name,
      sub: 'no transcribed schema — showing the captured MCP server instructions',
      content: st.mcpInstructions.map((a) => String(a.content || '')).join('\n\n') };
  }
  if (st.deferredTools.has(name)) {
    return { kind: 'text', badge: 'deferred tool', color: 'var(--k-attach)', title: name,
      content: `"${name}" is a deferred tool: only its NAME was in the model's context (surfaced via a deferred_tools_delta attachment). Its full schema enters context only when fetched with ToolSearch during the session, and it was not transcribed into this session's snapshot.` };
  }
  return { kind: 'text', badge: 'tool definition', color: 'var(--k-tool)', title: name,
    content: `No definition for "${name}" was captured for this session. System-prompt tool definitions exist only when /snapshot transcribed them into a snapshot.` };
}

function toolNamesOf(r, model) {
  const names = new Set();
  const pairs = pairsOf(model);
  const c = r.message?.content;
  if (Array.isArray(c)) for (const b of c) {
    if ((b.type === 'tool_use' || b.type === 'server_tool_use') && b.name) names.add(b.name);
    else if (b.tool_use_id && /tool_result$/.test(b.type || '')) {
      const call = pairs.get(b.tool_use_id)?.call;
      const cr = call && model.byUuid.get(call);
      const cb = Array.isArray(cr?.message?.content) && cr.message.content.find((x) => x.id === b.tool_use_id);
      if (cb?.name) names.add(cb.name);
    }
  }
  return [...names];
}

/* Tool call ↔ result pairing: tool_use/server_tool_use blocks carry an id,
   result blocks reference it via tool_use_id. */
function pairsOf(model) {
  if (!model._pairs) {
    const m = new Map();
    for (const r of model.content) {
      const c = r.message?.content;
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if ((b.type === 'tool_use' || b.type === 'server_tool_use') && b.id) {
          (m.get(b.id) || m.set(b.id, {}).get(b.id)).call = r.uuid;
        } else if (b.tool_use_id && /tool_result$/.test(b.type || '')) {
          (m.get(b.tool_use_id) || m.set(b.tool_use_id, {}).get(b.tool_use_id)).result = r.uuid;
        }
      }
    }
    model._pairs = m;
  }
  return model._pairs;
}

function rowPairIds(r) {
  if (r._pids === undefined) {
    const ids = [];
    const c = r.message?.content;
    if (Array.isArray(c)) for (const b of c) {
      if ((b.type === 'tool_use' || b.type === 'server_tool_use') && b.id) ids.push(b.id);
      else if (b.tool_use_id && /tool_result$/.test(b.type || '')) ids.push(b.tool_use_id);
    }
    r._pids = ids;
  }
  return r._pids;
}

/* Elapsed wall-clock per event: time since the previous dated record — for an
   assistant record that's roughly how long that step (thinking + API) took. */
function durationsOf(model) {
  if (!model._durs) {
    const m = new Map();
    let prev = null;
    for (const r of model.content) {
      if (!r.timestamp) continue;
      const t = Date.parse(r.timestamp);
      if (prev != null && r.uuid) m.set(r.uuid, t - prev);
      prev = t;
    }
    model._durs = m;
  }
  return model._durs;
}

/* Window-token delta per record: how much the context grew (or shrank, e.g.
   compaction) at each usage-bearing record, plus tokens generated. */
function deltasOf(model) {
  if (!model._deltas) {
    const m = new Map();
    let last = 0;
    for (const r of model.content) {
      const u = usageOf(r);
      if (u && r.uuid) { m.set(r.uuid, { d: u.ctx - last, out: u.out }); last = u.ctx; }
    }
    model._deltas = m;
  }
  return model._deltas;
}

/* Nearest assistant usage at-or-before index → context size readout. */
function tokensAt(model, idx) {
  for (let i = idx; i >= 0; i--) {
    const u = usageOf(model.content[i]);
    if (u) return { ...u, at: i };
  }
  return null;
}

// ---------- router ----------

window.addEventListener('hashchange', route);
initTheme();
route();

async function route() {
  document.getElementById('lanePop')?.remove();
  const h = location.hash || '#/';
  try {
    const m = h.match(/^#\/s\/([A-Za-z0-9_-]+)/);
    if (m) await sessionView(m[1]);
    else await homeView();
  } catch (err) {
    document.body.classList.remove('session-mode');
    $view.innerHTML = `<div class="empty-state"><h2>Something broke</h2><p class="warn">${esc(err.message)}</p></div>`;
  }
}

// ---------- home ----------

/* Static mode has no search endpoint: scan the (few) bundled transcripts in the
   browser. Each transcript is fetched once and cached for the session. */
const staticTextCache = new Map();
async function staticSearch(sessions, q) {
  const needle = q.toLowerCase();
  const out = [];
  for (const s of sessions) {
    let text = staticTextCache.get(s.sessionId);
    if (text == null) {
      try { text = await tget(API.transcript(s.sessionId)); } catch { text = ''; }
      staticTextCache.set(s.sessionId, text);
    }
    const lower = text.toLowerCase();
    let i = lower.indexOf(needle);
    if (i === -1) continue;
    let count = 0, j = i;
    while (j !== -1 && count < 500) { count++; j = lower.indexOf(needle, j + needle.length); }
    out.push({ sessionId: s.sessionId, count, snippet: text.slice(Math.max(0, i - 60), i + needle.length + 60).replace(/\s+/g, ' ') });
  }
  return out;
}

async function homeView() {
  document.title = 'ReClaude';
  document.body.classList.remove('session-mode');
  const sessions = await jget(API.sessions()); // sorted by last activity, newest first
  const byRoot = {};
  sessions.forEach((s) => { if (s.rootUuid) (byRoot[s.rootUuid] ||= []).push(s); });
  const home = { sessions, byRoot, q: '', hits: null };
  state.home = home;

  $view.innerHTML = `
    <header class="masthead">
      <h1><span class="dim">Re</span>Claude</h1>
      <span class="sub">flight recorder for the Claude Code context window</span>
    </header>
    <div class="searchbar">
      <input id="q" class="search-input" type="search" autocomplete="off" spellcheck="false"
        placeholder="Search ${sessions.length} sessions — titles, prompts, projects, and full transcript content…">
      <span class="hint" id="qStatus"></span>
    </div>
    <div class="session-list" id="cards"></div>`;

  const renderCards = () => {
    const q = home.q.toLowerCase();
    const shown = sessions.filter((s) => {
      if (!q) return true;
      const meta = `${s.customTitle || ''} ${s.title || ''} ${s.firstUserPrompt || ''} ${s.project || ''} ${s.cwd || ''} ${s.sessionId}`.toLowerCase();
      return meta.includes(q) || home.hits?.has(s.sessionId);
    });
    document.getElementById('cards').innerHTML = shown.length ? shown.map((s) => {
      const title = s.customTitle || s.title || s.firstUserPrompt?.slice(0, 80) || s.sessionId;
      let lineage = '';
      const kin = s.rootUuid ? byRoot[s.rootUuid] : null;
      if (kin && kin.length > 1) {
        const newest = kin.reduce((m, x) => (String(x.lastTimestamp) > String(m.lastTimestamp) ? x : m));
        lineage = s.sessionId === newest.sessionId
          ? `<span style="color:var(--accent)">⎘ continuation — full history, ${kin.length} segments of one conversation</span>`
          : `<span style="color:var(--faint)">⎘ earlier segment — superseded by ${esc(newest.sessionId.slice(0, 8))}</span>`;
      }
      const hit = home.hits?.get(s.sessionId);
      const src = s.source === 'demo'
        ? '<span style="color:var(--accent)">demo · the session that built this app (redacted, in-memory)</span>'
        : s.source === 'disk'
        ? '<span style="color:var(--faint)">on-disk · not yet exported</span>'
        : `<b>${fmtInt(s.snapshotCount)}</b> snapshot${s.snapshotCount === 1 ? '' : 's'}`;
      return `
      <a class="session-card" href="#/s/${esc(s.sessionId)}">
        <div class="row1">
          <span class="title">${esc(title)}</span>
          <span class="proj">${esc(s.project || s.cwd || '')}</span>
        </div>
        ${s.firstUserPrompt ? `<div class="prompt">${esc(s.firstUserPrompt.slice(0, 160))}</div>` : ''}
        ${hit ? `<div class="prompt hit">⌕ ${fmtInt(hit.count)} content match${hit.count === 1 ? '' : 'es'} — <span class="snip">…${esc(hit.snippet)}…</span></div>` : ''}
        <div class="stats">
          <span><b>${fmtInt(s.lineCount)}</b> records</span>
          <span>${src}</span>
          <span><b>${fmtInt(s.compactBoundaries)}</b> compaction${s.compactBoundaries === 1 ? '' : 's'}</span>
          <span>${esc(fmtTime(s.firstTimestamp))} → ${esc(fmtTime(s.lastTimestamp))}</span>
          <span>cli ${esc(s.cliVersion || '?')}</span>
          ${lineage ? `<span>${lineage}</span>` : ''}
        </div>
      </a>`;
    }).join('') : `<div class="empty-state"><h2>${sessions.length ? 'No sessions match' : 'No sessions found'}</h2>
      <p>${sessions.length ? 'Try a different search — content search needs at least 3 characters.' : 'On-disk sessions appear automatically; run <code>/snapshot</code> in a live session to add snapshots.'}</p></div>`;
  };

  renderCards();
  const input = document.getElementById('q');
  const status = document.getElementById('qStatus');
  let timer = null;
  input.addEventListener('input', () => {
    home.q = input.value.trim();
    clearTimeout(timer);
    if (home.q.length >= 3) {
      status.textContent = 'searching transcript content…';
      timer = setTimeout(async () => {
        const q = home.q;
        try {
          const hits = STATIC ? await staticSearch(sessions, q) : await jget(`/api/search?q=${encodeURIComponent(q)}`);
          if (home.q === q) home.hits = new Map(hits.map((h) => [h.sessionId, h]));
        } catch { home.hits = null; }
        status.textContent = '';
        renderCards();
      }, 350);
    } else { home.hits = null; status.textContent = ''; }
    renderCards();
  });
}

// ---------- session ----------

async function sessionView(id) {
  document.body.classList.add('session-mode');
  $view.innerHTML = `<div class="crumb">loading transcript…</div>`;
  const [manifest, jsonl] = await Promise.all([
    jget(API.session(id)),
    tget(API.transcript(id)),
  ]);
  const model = parseTranscript(jsonl);
  const snapshots = [];
  for (const name of manifest.snapshots || []) {
    try { snapshots.push({ name, data: await jget(API.snapshot(id, name)) }); } catch {}
  }
  const title = manifest.customTitle || manifest.title || id;
  document.title = `${title} — ReClaude`;

  JSON_STORE = [];
  const s = {
    id, manifest, model, snapshots,
    sel: model.content.length - 1,
    tab: 'timeline',
    sortDesc: false,
    axis: 'time',
    railQ: '',
    railCollapsed: false,
    filter: new Set(),
    showSidechain: true,
    snapIdx: snapshots.length - 1,
  };
  state.session = s;

  $view.innerHTML = `
    <div class="crumb"><a href="#/">← sessions</a> &nbsp;/&nbsp; <span style="font-family:var(--mono)">${esc(id)}</span></div>
    <header class="masthead" style="padding-top:6px">
      <h1 style="letter-spacing:.02em;text-transform:none;font-size:19px">${esc(title)}</h1>
      <span class="sub">${esc(manifest.project || manifest.cwd || '')}</span>
    </header>
    ${snapshots.length ? '' : `<div class="banner">No export found for this session — data is limited to the on-disk transcript (no system prompt or tool definitions). Run <code>/snapshot</code> inside that session to capture them.</div>`}
    <div id="agentFocusBar" class="agent-focus-bar" style="display:none"></div>
    <div class="tape-wrap">
      <div class="tape-head">
        <span class="eyebrow">context tape — click to select a moment · drag to zoom · double-click resets</span>
        <span class="zoom-ctl">
          <span class="readout" id="zoomInfo"></span>
          <button id="zoomOut" type="button" title="Zoom out ×2">−</button>
          <button id="zoomReset" type="button" title="Show full session">⤢ all</button>
          <span class="readout" id="readout"></span>
        </span>
      </div>
      <canvas class="tape" id="tape" aria-label="Session timeline: context tokens per record; click to select a point in time"></canvas>
      <div id="lanes" class="lanes" style="display:none" aria-label="Agent and background task sub-timelines"></div>
      <div class="tape-head legend-row" style="padding-top:4px">
        <button id="axisToggle" class="mini-btn" type="button" title="switch the tape's x-axis">⏱ time axis</button>
        <span class="legend-right" id="legend"></span>
      </div>
    </div>
    <div class="panel-head">
      <div class="tabs" id="tabs"></div>
      <button id="sortToggle" class="mini-btn sortish" type="button" title="flip event order">▲ oldest first</button>
    </div>
    <div class="session-body">
      <div class="rail" id="railBox">
        <div class="rail-head">
          <span class="eyebrow" id="railCount">records (${model.content.length})</span>
          <span style="display:flex;gap:8px;align-items:center">
            <label><input type="checkbox" id="sidechainToggle" checked> subagent turns</label>
            <button id="railCollapse" class="mini-btn" type="button" title="collapse the records pane">⟨</button>
          </span>
        </div>
        <canvas id="railMap" class="rail-map" aria-label="Minimap of the full session; click to scroll the records list"></canvas>
        <div class="rail-search"><input id="sqRail" class="search-input sq" type="search" autocomplete="off" spellcheck="false" placeholder="find in records (this pane only)…"></div>
        <div class="rail-list" id="rail"></div>
      </div>
      <div class="ctx-panel">
        <div class="panel-search">
          <input id="sqMain" class="search-input sq" type="search" autocomplete="off" spellcheck="false" placeholder="find in view — filters rows, keeps the zoom range">
        </div>
        <div id="panel"></div>
      </div>
      <div class="preview-pane" id="preview"></div>
    </div>
    <div class="tape-tip" id="tapeTip"></div>`;

  const legendEl = document.getElementById('legend');
  legendEl.innerHTML = LEGEND.map((it, i) => {
    const sw = it.swatch === 'line'
      ? `<span style="display:inline-block;width:2px;height:11px;background:${KIND_COLORS[it.k]};margin-right:5px"></span>`
      : it.swatch === 'hollow'
      ? `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;border:2px solid ${KIND_COLORS[it.k]};margin-right:5px"></span>`
      : `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${KIND_COLORS[it.k]};margin-right:5px"></span>`;
    return `<span class="readout legend-item" data-li="${i}" tabindex="0">${sw}${esc(it.name)}</span>`;
  }).join('') + `<button id="filterClear" class="mini-btn" type="button" disabled>clear filters</button>`;
  const legendTip = document.getElementById('tapeTip');
  const showLegendTip = (it, x, y) => {
    const d = LEGEND[+it.dataset.li];
    legendTip.style.display = 'block';
    legendTip.style.left = Math.min(x + 14, window.innerWidth - 360) + 'px';
    legendTip.style.top = (y + 16) + 'px';
    legendTip.innerHTML = `<span class="k">${esc(d.name)}</span><br>${esc(d.desc)}<br><span class="k">click to filter by this · click again to remove</span>`;
  };
  const toggleFilter = (it) => {
    const f = LEGEND[+it.dataset.li].f;
    if (s.filter.has(f)) s.filter.delete(f); else s.filter.add(f);
    applyFilter(s);
  };
  legendEl.querySelectorAll('.legend-item').forEach((it) => {
    it.addEventListener('mousemove', (e) => showLegendTip(it, e.clientX, e.clientY));
    it.addEventListener('mouseleave', () => { legendTip.style.display = 'none'; });
    it.addEventListener('focus', () => { const r = it.getBoundingClientRect(); showLegendTip(it, r.left, r.bottom); });
    it.addEventListener('blur', () => { legendTip.style.display = 'none'; });
    it.addEventListener('click', () => toggleFilter(it));
    it.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFilter(it); } });
  });
  document.getElementById('filterClear').addEventListener('click', () => { s.filter.clear(); applyFilter(s); });

  let sqTimer = null;
  document.getElementById('sqMain').addEventListener('input', (e) => {
    clearTimeout(sqTimer);
    sqTimer = setTimeout(() => { s.q = e.target.value.trim(); renderPanel(s); drawTape(s); }, 200);
  });
  let railTimer = null;
  document.getElementById('sqRail').addEventListener('input', (e) => {
    clearTimeout(railTimer);
    railTimer = setTimeout(() => { s.railQ = e.target.value.trim(); renderRail(s); }, 200);
  });
  document.getElementById('railCollapse').addEventListener('click', () => {
    s.railCollapsed = !s.railCollapsed;
    document.getElementById('railBox').classList.toggle('collapsed', s.railCollapsed);
    document.querySelector('.session-body').classList.toggle('rail-collapsed', s.railCollapsed);
    document.getElementById('railCollapse').textContent = s.railCollapsed ? '⟩' : '⟨';
    if (!s.railCollapsed) { renderRail(s); }
    drawTape(s); // lanes/tape reflow to the new width
  });
  document.getElementById('rail').addEventListener('scroll', () => requestAnimationFrame(() => renderRailMap(s)), { passive: true });
  // minimap scrubbing: drag like a scrollbar (mousedown engages, window-level
  // moves track, proportional to the list's scroll range)
  const railMapEl = document.getElementById('railMap');
  // invert the click through the SAME scale the minimap is drawn with, so the
  // pointer, the viewport band, and the content stay aligned
  const scrubTo = (clientX) => {
    const rect = railMapEl.getBoundingClientRect();
    const px = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const rail = document.getElementById('rail');
    const rows = rail.querySelectorAll('.rec[data-i]');
    if (!rows.length) return;
    const mts = s.axis === 'record' ? null : timeScaleOf(s);
    let target;
    if (mts) {
      const mscale = buildTimePixelScale(s, mts.t0, mts.t1, rect.width, 2);
      target = idxAtTime(timeIndex(s), mscale.tOfX(px));
    } else {
      target = ((px - 2) / Math.max(1, rect.width - 4)) * (s.model.content.length - 1);
    }
    let hit = rows[rows.length - 1];
    for (const rrow of rows) { if (+rrow.dataset.i >= target) { hit = rrow; break; } }
    rail.scrollTop = hit.offsetTop - rail.clientHeight / 2 + hit.offsetHeight / 2;
  };
  let scrubbing = false;
  // held state is painted once on each edge; every frame in between repaints for
  // free, because scrubTo writes rail.scrollTop and the rail's scroll listener
  // already schedules a renderRailMap
  railMapEl.addEventListener('mousedown', (e) => {
    scrubbing = true;
    s._scrubbing = true;
    railMapEl.classList.add('scrubbing');
    document.body.classList.add('dragging');
    renderRailMap(s);
    scrubTo(e.clientX);
    e.preventDefault();
  });
  const mapMove = (e) => {
    if (document.getElementById('railMap') !== railMapEl) {
      window.removeEventListener('mousemove', mapMove);
      window.removeEventListener('mouseup', mapUp);
      return;
    }
    if (scrubbing) scrubTo(e.clientX);
  };
  const mapUp = () => {
    if (!scrubbing) return; // this fires on every mouseup in the view; only the release edge costs a repaint
    scrubbing = false;
    s._scrubbing = false;
    railMapEl.classList.remove('scrubbing');
    document.body.classList.remove('dragging');
    renderRailMap(s);
  };
  window.addEventListener('mousemove', mapMove);
  window.addEventListener('mouseup', mapUp);
  document.getElementById('sidechainToggle').addEventListener('change', (e) => {
    s.showSidechain = e.target.checked; // rail-local: other panes are unaffected
    renderRail(s);
  });

  document.getElementById('preview').addEventListener('click', (e) => {
    const dj = e.target.closest('.def-jump');
    if (dj) {
      s.preview = toolDefTarget(s, dj.dataset.name);
      renderPreview(s);
      return;
    }
    const pj = e.target.closest('.pair-jump');
    if (pj) {
      const idx = s.model.idxOf.get(pj.dataset.target);
      if (idx != null) select(s, idx, { scrollRail: true });
      return;
    }
    const l = e.target.closest('.fh-link');
    if (!l) return;
    s.preview = { kind: 'histfile', badge: 'file version', color: 'var(--k-assistant)', path: l.dataset.path, version: +l.dataset.version, name: l.dataset.name, prevName: l.dataset.prev || null };
    renderPreview(s);
  });
  // hovering a tool call highlights its result row(s) everywhere, and vice versa
  const clearPairHl = () => document.querySelectorAll('.pair-hl').forEach((n) => n.classList.remove('pair-hl'));
  const pairHover = (e) => {
    const row = e.target.closest?.('[data-pairs]');
    clearPairHl();
    if (!row) return;
    const ids = new Set(row.dataset.pairs.split(' '));
    document.querySelectorAll('[data-pairs]').forEach((n) => {
      if (n !== row && n.dataset.pairs.split(' ').some((id) => ids.has(id))) n.classList.add('pair-hl');
    });
  };
  for (const id of ['panel', 'rail']) {
    document.getElementById(id).addEventListener('mouseover', pairHover);
    document.getElementById(id).addEventListener('mouseleave', clearPairHl);
  }
  const onKey = (e) => {
    if (state.session !== s) { window.removeEventListener('keydown', onKey); return; }
    if (e.key === 'Escape' && s.agentFocus) exitAgentFocus(s);
  };
  window.addEventListener('keydown', onKey);
  renderRail(s);
  initTape(s);
  // clicking a row in the main view selects that record everywhere — rail, tape
  // cursor, readout — without rebuilding the panel (so expand/collapse still works)
  const rowActivate = (row) => {
    if (row.dataset.uuid) {
      const uuid = row.dataset.uuid, src = row.dataset.src || 'main';
      s.preview = { kind: 'record', uuid, src, mode: s.preview?.mode || 'fmt' };
      if (src === 'main') {
        const idx = s.model.idxOf.get(uuid);
        if (idx != null) select(s, idx, { scrollRail: true, skipPanel: true });
        else renderPreview(s);
      } else renderPreview(s);
    } else if (row.dataset.pvi != null) {
      const item = PV_ITEMS[+row.dataset.pvi];
      if (!item) return;
      s.preview = { ...item };
      renderPreview(s);
    } else return;
    document.querySelectorAll('#panel .msg.focus').forEach((m) => { if (m !== row) m.classList.remove('focus'); });
    row.classList.add('focus');
  };
  const sortBtn = document.getElementById('sortToggle');
  sortBtn.addEventListener('click', () => {
    s.sortDesc = !s.sortDesc;
    sortBtn.textContent = s.sortDesc ? '▼ newest first' : '▲ oldest first';
    renderPanel(s);
  });
  const chipToggle = (chip) => {
    const f = chip.dataset.f;
    if (s.filter.has(f)) s.filter.delete(f); else s.filter.add(f);
    applyFilter(s); // legend, tape, rail, and panel all resync
  };
  document.getElementById('panel').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip-f[data-f]');
    if (chip) return chipToggle(chip);
    const row = e.target.closest('.mrow');
    if (row) rowActivate(row);
  });
  document.getElementById('panel').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const chip = e.target.closest('.chip-f[data-f]');
    if (chip) { e.preventDefault(); return chipToggle(chip); }
    const row = e.target.closest('.mrow');
    if (row) { e.preventDefault(); rowActivate(row); }
  });
  renderPreview(s);
  select(s, s.sel, { scrollRail: true });
  loadAgents(s); // async; lanes appear when the companion files are parsed
  jget(API.memory(id)).then((m) => {
    s.memory = m;
    if (state.session === s) { renderTabs(s); if (s.tab === 'memory') renderPanel(s); }
  }).catch(() => { s.memory = { files: [] }; });
  // probe which real file backups exist on disk for this session
  fetch(API.fhList(id)).then((r) => (r.ok ? r.json() : null)).then((list) => {
    s.fhFiles = Array.isArray(list) ? new Set(list) : null;
    if (state.session === s && s.tab === 'files') renderPanel(s);
  }).catch(() => { s.fhFiles = null; });
  initStickyHeads(s);
  window.addEventListener('resize', () => drawTape(s), { passive: true });
}

function select(s, idx, opts = {}) {
  const prevSel = s.sel;
  s.sel = Math.max(0, Math.min(idx, s.model.content.length - 1));
  const vw = viewOf(s);
  let zoomed = false;
  if (s.sel < vw.a || s.sel > vw.b) {
    const half = (vw.b - vw.a) / 2;
    zoomed = true; // the window moved: pixel positions before/after are not comparable
    setView(s, s.sel - half, s.sel + half);
  }
  const rec = s.model.content[s.sel];
  // choose snapshot: latest whose exportedAt <= selected record time, else earliest after
  if (s.snapshots.length && !opts.keepSnap) {
    const t = rec.timestamp ? Date.parse(rec.timestamp) : Infinity;
    let pick = 0;
    s.snapshots.forEach((sn, i) => {
      const ts = Date.parse(sn.data.exportedAt || sn.data.receivedAt || 0);
      if (ts <= t || i === 0) pick = i;
    });
    s.snapIdx = pick;
  }
  document.querySelectorAll('.rec.sel').forEach((n) => n.classList.remove('sel'));
  const row = document.querySelector(`.rec[data-i="${s.sel}"]`);
  if (row) {
    row.classList.add('sel');
    if (opts.scrollRail) row.scrollIntoView?.({ block: 'center' });
  }
  glideSel(s, prevSel, zoomed);
  renderTabs(s);
  if (!opts.skipPanel) renderPanel(s);
  const selRec = s.model.content[s.sel];
  if (selRec?.uuid) {
    s.preview = { kind: 'record', uuid: selRec.uuid, src: 'main', mode: s.preview?.mode || 'fmt' };
    renderPreview(s);
  }
  const u = tokensAt(s.model, s.sel);
  document.getElementById('readout').innerHTML =
    `rec <b>${s.sel + 1}</b>/${s.model.content.length}` +
    ` · <b>${u ? fmtInt(u.ctx) : '—'}</b> tok in window` +
    (u ? ` <span style="color:var(--faint)">(read ${fmtInt(u.u.cache_read_input_tokens)} · write ${fmtInt(u.u.cache_creation_input_tokens)} · in ${fmtInt(u.u.input_tokens)} · out ${fmtInt(u.u.output_tokens)})</span>` : '') +
    ` · ${esc(fmtTime(rec.timestamp))}`;
}

// ---------- record rail ----------

function renderRail(s) {
  const railEl = document.getElementById('rail');
  if (s.railCollapsed || !railEl) { renderRailMap(s); return; }
  const frag = document.createDocumentFragment();
  if (s.model._hasSide === undefined) s.model._hasSide = s.model.content.some((r) => r.isSidechain);
  const toggleLabel = document.getElementById('sidechainToggle')?.closest('label');
  if (toggleLabel) toggleLabel.style.display = s.model._hasSide && !s.agentFocus ? '' : 'none';

  const v = viewOf(s);
  const n = s.model.content.length;
  const zoomed = !(v.a <= 0 && v.b >= n - 1);
  const lo = Math.floor(v.a), hi = Math.ceil(v.b);
  const q = (s.railQ || '').toLowerCase();

  let shown = 0;
  let prevIn = !zoomed || 0 >= lo; // zone of the first row
  let firstRow = true;
  s.model.content.forEach((r, i) => {
    if (r.isSidechain && !s.showSidechain) return;
    if (!matchText(r, q)) return;
    const inRange = !zoomed || (i >= lo && i <= hi);
    if (zoomed && !firstRow && inRange !== prevIn) {
      frag.appendChild(el(`<div class="zoom-edge">${inRange ? `⟦ zoom starts · record ${lo + 1} ⟧` : `⟦ zoom ends · record ${hi + 1} ⟧`}</div>`));
    }
    if (zoomed && firstRow && !inRange) { /* rows above the window are dimmed until the edge marker */ }
    prevIn = inRange; firstRow = false;
    shown++;
    const kind = recKind(r);
    const compact = r.type === 'system' && r.subtype === 'compact_boundary';
    const pids = rowPairIds(r);
    const dot = kind === 'srvtool'
      ? `<span class="dot dot-hollow" style="border-color:${KIND_COLORS[kind]}"></span>`
      : `<span class="dot" style="background:${KIND_COLORS[kind]}"></span>`;
    const row = el(`<div class="rec${r.isSidechain ? ' sidechain' : ''}${compact ? ' compact-row' : ''}${zoomed && !inRange ? ' zoom-out' : ''}" data-i="${i}"${pids.length ? ` data-pairs="${esc(pids.join(' '))}"` : ''} tabindex="0" role="button">
      ${dot}
      <span class="kind" title="${esc(roleOf(r, kind, { orchestrator: !!s.agentFocus }))}">${esc(roleOf(r, kind, { orchestrator: !!s.agentFocus }))}</span>
      <span class="prev">${esc(recPreview(r))}</span>
    </div>`);
    row.addEventListener('click', () => select(s, i));
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(s, i); } });
    frag.appendChild(row);
  });
  railEl.replaceChildren(frag);
  const count = document.getElementById('railCount');
  if (count) count.textContent = q || !s.showSidechain ? `records ${shown}/${n}` : `records (${n})`;
  renderRailMap(s);
}

/* Minimap: the whole session at rail width — token curve, zoom window,
   selection, and which slice of the list is on screen. Click to scroll. */
function ensurePts(s) {
  if (!s._pts) {
    let last = 0, maxTok = 1;
    const pts = [];
    s.model.content.forEach((r) => {
      const u = usageOf(r);
      if (u) { last = u.ctx; maxTok = Math.max(maxTok, u.ctx); }
      pts.push(last);
    });
    s._pts = pts; s._maxTok = maxTok;
  }
}

function renderRailMap(s) {
  const cv = document.getElementById('railMap');
  if (!cv || s.railCollapsed) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W) return;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, W, H);
  const n = s.model.content.length;
  if (!n) return;
  ensurePts(s);
  const mts = s.axis === 'record' ? null : timeScaleOf(s);
  const mtimes = timeIndex(s);
  const mscale = mts ? buildTimePixelScale(s, mts.t0, mts.t1, W, 2) : null;
  const x = mscale
    ? (i) => mscale.xOfT(timeAtIdx(mtimes, i))
    : (i) => (i / Math.max(1, n - 1)) * (W - 4) + 2;
  const uFracOf = (i) => (x(i) - 2) / Math.max(1, W - 4);
  const stripH = 10; // bottom strip: event-kind distribution
  if (mscale) {
    g.fillStyle = CANVAS.gapFill;
    for (const sg of mscale.segs) if (sg.gap) g.fillRect(sg.x0, 0, Math.max(1.5, sg.x1 - sg.x0), H);
  }
  const y = (t) => H - stripH - 2 - (t / s._maxTok) * (H - stripH - 6);
  // token curve (above the strip)
  g.beginPath();
  g.moveTo(x(0), y(s._pts[0]));
  for (let i = 1; i < n; i++) g.lineTo(x(i), y(s._pts[i]));
  g.strokeStyle = CANVAS.curve; g.lineWidth = 1; g.stroke();
  // kind distribution: bucket records into ~2px columns, stack each column's
  // kind mix proportionally — a best-effort density read at this scale
  const colW = 2;
  const cols = Math.max(1, Math.floor((W - 4) / colW));
  const KORDER = ['user', 'attach', 'assistant', 'tool', 'srvtool', 'event'];
  const buckets = Array.from({ length: cols }, () => ({}));
  s.model.content.forEach((r, i) => {
    const b = buckets[Math.min(cols - 1, Math.floor(uFracOf(i) * cols))];
    const k = recKind(r);
    b[k] = (b[k] || 0) + 1;
  });
  buckets.forEach((b, ci) => {
    const total = Object.values(b).reduce((a, v) => a + v, 0);
    if (!total) return;
    let yCur = H - 1;
    for (const k of KORDER) {
      if (!b[k]) continue;
      const h = Math.max(total > 0 && b[k] > 0 ? 1 : 0, (b[k] / total) * (stripH - 1));
      g.fillStyle = KIND_COLORS[k];
      g.globalAlpha = 0.85;
      g.fillRect(2 + ci * colW, yCur - h, colW - 0.5, h);
      yCur -= h;
    }
    g.globalAlpha = 1;
  });
  // zoom window
  const v = viewOf(s);
  if (!(v.a <= 0 && v.b >= n - 1)) {
    g.fillStyle = 'rgba(233,185,73,0.16)';
    g.fillRect(x(v.a), 0, Math.max(2, x(v.b) - x(v.a)), H);
    g.strokeStyle = 'rgba(233,185,73,0.6)';
    g.strokeRect(x(v.a) + 0.5, 0.5, Math.max(2, x(v.b) - x(v.a)) - 1, H - 1);
  }
  // visible slice of the list
  const rail = document.getElementById('rail');
  const rows = rail ? rail.querySelectorAll('.rec[data-i]') : [];
  if (rail && rows.length) {
    const total = rail.scrollHeight || 1;
    const k1 = Math.max(0, Math.min(rows.length - 1, Math.floor((rail.scrollTop / total) * rows.length)));
    const k2 = Math.max(0, Math.min(rows.length - 1, Math.ceil(((rail.scrollTop + rail.clientHeight) / total) * rows.length) - 1));
    const i1 = +rows[k1].dataset.i, i2 = +rows[k2].dataset.i;
    const bx0 = x(i1), bw = Math.max(3, x(i2) - x(i1));
    // idle: a hint. held: a grabbed object — brighter, with accent edges.
    g.fillStyle = s._scrubbing ? CANVAS.hair : CANVAS.viewport;
    g.fillRect(bx0, 0, bw, H);
    if (s._scrubbing) {
      g.fillStyle = ACCENT;
      g.fillRect(bx0, 0, 1, H);
      g.fillRect(bx0 + bw - 1, 0, 1, H);
    }
  }
  // selection
  g.strokeStyle = ACCENT; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(x(s.sel), 0); g.lineTo(x(s.sel), H); g.stroke();
}

// ---------- the tape (canvas instrument) ----------
/* Zoomable: drag a range on the tape to zoom into it (trace-viewer style),
   double-click or "⤢ all" to reset, "−" to zoom out ×2. A slim overview band
   at the bottom always shows the full session with the visible window; clicking
   the band pans the window there. */

const TAPE = { pad: 4, stripH: 14, bandH: 8 };

function viewOf(s) {
  const n = s.model.content.length;
  if (!s.view) s.view = { a: 0, b: Math.max(0, n - 1) };
  return s.view;
}

function setView(s, a, b) {
  const max = s.model.content.length - 1;
  if (b - a < 4) { const c = (a + b) / 2; a = c - 2; b = c + 2; }   // floor: ~5 records
  if (a < 0) { b -= a; a = 0; }
  if (b > max) { a -= (b - max); b = max; }
  s.view = { a: Math.max(0, a), b: Math.min(max, b) };
  drawTape(s);
  updateZoomReadout(s);
  renderRail(s);
  renderTabs(s);
  if (s.tab === 'range') renderPanel(s);
}

function applyFilter(s) {
  document.querySelectorAll('#legend .legend-item').forEach((el) => {
    el.classList.toggle('on', s.filter.has(LEGEND[+el.dataset.li].f));
  });
  // always present, disabled when there is nothing to clear — hiding it would
  // reflow the legend row the moment you click your first filter
  const btn = document.getElementById('filterClear');
  if (btn) btn.disabled = !s.filter.size;
  drawTape(s);
  renderRail(s);
  renderPanel(s);
}

function updateZoomReadout(s) {
  const info = document.getElementById('zoomInfo');
  if (!info) return;
  const v = viewOf(s), n = s.model.content.length;
  const full = v.a <= 0 && v.b >= n - 1;
  info.textContent = full ? '' : `zoomed: ${Math.floor(v.a) + 1}–${Math.ceil(v.b) + 1} of ${n}`;
  for (const id of ['zoomOut', 'zoomReset']) {
    const btn = document.getElementById(id);
    if (btn) btn.style.visibility = full ? 'hidden' : 'visible';
  }
}

/* Time helpers for the gridlines: content records carry timestamps, but the tape
   x-axis is record-index-based, so wall-clock gridlines land non-uniformly —
   dense activity pulls them apart, idle gaps bunch them together. */
function timeIndex(s) {
  if (!s._times) {
    s._times = [];
    s.model.content.forEach((r, i) => {
      if (r.timestamp) {
        const t = Date.parse(r.timestamp);
        if (!Number.isNaN(t)) s._times.push({ i, t });
      }
    });
  }
  return s._times;
}

function idxAtTime(times, t) {
  if (t <= times[0].t) return times[0].i;
  const last = times[times.length - 1];
  if (t >= last.t) return last.i;
  let lo = 0, hi = times.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (times[m].t <= t) lo = m; else hi = m; }
  const a = times[lo], b = times[hi];
  const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  return a.i + f * (b.i - a.i);
}

function timeAtIdx(times, i) {
  if (i <= times[0].i) return times[0].t;
  const last = times[times.length - 1];
  if (i >= last.i) return last.t;
  let lo = 0, hi = times.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (times[m].i <= i) lo = m; else hi = m; }
  const a = times[lo], b = times[hi];
  const f = b.i === a.i ? 0 : (i - a.i) / (b.i - a.i);
  return a.t + f * (b.t - a.t);
}

/* Piecewise "compressed time" scale: active periods map linearly to the axis,
   idle gaps (>10 min between dated records) collapse to a fixed sliver so an
   overnight pause doesn't consume the tape. */
const GAP_MIN_MS = 10 * 60e3;
function timeScaleOf(s) {
  const times = timeIndex(s);
  if (times.length < 2) return null;
  if (s._tscale) return s._tscale;
  const t0 = times[0].t, t1 = times[times.length - 1].t;
  const gaps = [];
  for (let k = 1; k < times.length; k++) {
    const dt = times[k].t - times[k - 1].t;
    if (dt > GAP_MIN_MS) gaps.push({ t0: times[k - 1].t, t1: times[k].t, dur: dt });
  }
  const active = Math.max(1, (t1 - t0) - gaps.reduce((a, g) => a + g.dur, 0));
  const gapU = Math.max(30e3, active * 0.02);
  const segs = [];
  let u = 0, prev = t0;
  for (const g of gaps) {
    if (g.t0 > prev) { segs.push({ t0: prev, t1: g.t0, u0: u, u1: u + (g.t0 - prev), gap: false }); u += g.t0 - prev; }
    segs.push({ t0: g.t0, t1: g.t1, u0: u, u1: u + gapU, gap: true, dur: g.dur }); u += gapU;
    prev = g.t1;
  }
  if (t1 > prev || !segs.length) { const end = Math.max(t1, prev + 1); segs.push({ t0: prev, t1: end, u0: u, u1: u + (end - prev), gap: false }); u += end - prev; }
  const uOf = (t) => {
    if (t <= t0) return 0;
    if (t >= t1) return u;
    for (const sg of segs) if (t <= sg.t1) return sg.u0 + ((t - sg.t0) / Math.max(1, sg.t1 - sg.t0)) * (sg.u1 - sg.u0);
    return u;
  };
  const tOf = (uu) => {
    if (uu <= 0) return t0;
    if (uu >= u) return t1;
    for (const sg of segs) if (uu <= sg.u1) return sg.t0 + ((uu - sg.u0) / Math.max(1e-9, sg.u1 - sg.u0)) * (sg.t1 - sg.t0);
    return t1;
  };
  const inGap = (t) => segs.some((sg) => sg.gap && t > sg.t0 && t < sg.t1);
  return (s._tscale = { segs, totalU: u, uOf, tOf, inGap, t0, t1 });
}

/* Pixel-space time scale for a given time range and width: idle gaps get a
   CONSTANT pixel sliver regardless of zoom; active time shares the rest
   linearly. */
const GAP_PX = 26;
function buildTimePixelScale(s, tA, tB, W, pad) {
  const ts = timeScaleOf(s);
  const inner = W - 2 * pad;
  const gaps = ts.segs
    .filter((sg) => sg.gap && sg.t1 > tA && sg.t0 < tB)
    .map((sg) => ({ t0: Math.max(sg.t0, tA), t1: Math.min(sg.t1, tB), dur: sg.t1 - sg.t0 }));
  const activeMs = Math.max(1, (tB - tA) - gaps.reduce((a, g) => a + (g.t1 - g.t0), 0));
  const gapPx = gaps.length ? Math.min(GAP_PX, (inner * 0.4) / gaps.length) : 0;
  const activePx = inner - gapPx * gaps.length;
  const segs = [];
  let px = pad, t = tA;
  for (const g of gaps) {
    if (g.t0 > t) { const w = ((g.t0 - t) / activeMs) * activePx; segs.push({ t0: t, t1: g.t0, x0: px, x1: px + w, gap: false }); px += w; }
    segs.push({ t0: g.t0, t1: g.t1, x0: px, x1: px + gapPx, gap: true, dur: g.dur }); px += gapPx;
    t = g.t1;
  }
  if (tB > t || !segs.length) { const w = ((tB - t) / activeMs) * activePx; segs.push({ t0: t, t1: tB, x0: px, x1: px + w, gap: false }); px += w; }
  const xOfT = (tt) => {
    if (tt <= tA) return pad;
    if (tt >= tB) return pad + inner;
    for (const sg of segs) if (tt <= sg.t1) return sg.x0 + ((tt - sg.t0) / Math.max(1, sg.t1 - sg.t0)) * (sg.x1 - sg.x0);
    return pad + inner;
  };
  const tOfX = (xx) => {
    if (xx <= pad) return tA;
    if (xx >= pad + inner) return tB;
    for (const sg of segs) if (xx <= sg.x1) return sg.t0 + ((xx - sg.x0) / Math.max(1e-9, sg.x1 - sg.x0)) * (sg.t1 - sg.t0);
    return tB;
  };
  return { segs, xOfT, tOfX };
}

const GRID_STEPS = [10e3, 30e3, 60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3,
  3600e3, 2 * 3600e3, 6 * 3600e3, 12 * 3600e3, 24 * 3600e3, 7 * 24 * 3600e3];

function fmtClock(t, step) {
  const d = new Date(t);
  if (step >= 24 * 3600e3) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (step < 60e3) return `${hh}:${mm}:${String(d.getSeconds()).padStart(2, '0')}`;
  return `${hh}:${mm}`;
}

function fmtDur(ms) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return sec % 60 ? `${m}m ${String(sec % 60).padStart(2, '0')}s` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function tapeGeom(s, W) {
  const v = viewOf(s);
  const ts = s.axis === 'record' ? null : timeScaleOf(s);
  const inner = W - 2 * TAPE.pad;
  if (!ts) {
    const span = Math.max(1e-9, v.b - v.a);
    return { v, ts: null,
      x: (i) => ((i - v.a) / span) * inner + TAPE.pad,
      idx: (px) => v.a + ((px - TAPE.pad) / inner) * span };
  }
  const times = timeIndex(s);
  const tA = timeAtIdx(times, v.a);
  const tB = Math.max(tA + 1, timeAtIdx(times, v.b));
  const scale = buildTimePixelScale(s, tA, tB, W, TAPE.pad);
  return {
    v, ts, scale,
    x: (i) => scale.xOfT(timeAtIdx(times, i)),
    idx: (px) => idxAtTime(times, scale.tOfX(px)),
  };
}

function initTape(s) {
  const cv = document.getElementById('tape');
  const tip = document.getElementById('tapeTip');
  const n = () => s.model.content.length;
  const pxOf = (e) => e.clientX - cv.getBoundingClientRect().left;
  const idxFromEvent = (e) => {
    const i = Math.round(tapeGeom(s, cv.getBoundingClientRect().width).idx(pxOf(e)));
    return Math.max(0, Math.min(i, n() - 1));
  };
  const inBand = (e) => {
    const r = cv.getBoundingClientRect();
    return e.clientY - r.top >= r.height - TAPE.bandH - 2;
  };

  // the tape does three things by region; the pointer should say which.
  // cached so the per-pixel mousemove writes style only on an actual change
  const setCur = (c) => { if (cv.dataset.cur !== c) { cv.dataset.cur = c; cv.style.cursor = c; } };

  let downX = null, dragging = false;

  cv.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || inBand(e)) return;
    downX = pxOf(e);
    dragging = false;
    e.preventDefault();
  });

  // window-level so a drag keeps working outside the canvas; self-detaches when
  // this canvas is replaced by a route change
  const onWinMove = (e) => {
    if (document.getElementById('tape') !== cv) {
      window.removeEventListener('mousemove', onWinMove);
      window.removeEventListener('mouseup', onWinUp);
      return;
    }
    if (downX == null) return;
    const px = pxOf(e);
    if (!dragging && Math.abs(px - downX) > 4) {
      dragging = true;
      tip.style.display = 'none';
      // latch ew-resize only once the gesture is real — body.dragging * restyles
      // the entire document, and a plain click on the tape is the common case
      document.body.classList.add('dragging');
    }
    if (dragging) { s.dragSel = [downX, px]; drawTape(s); }
  };
  const onWinUp = (e) => {
    document.body.classList.remove('dragging'); // unconditional: a plain click must never strand it
    if (downX == null) return;
    const wasDrag = dragging;
    const startPx = downX, endPx = pxOf(e);
    downX = null; dragging = false;
    if (wasDrag) {
      s.dragSel = null;
      s._suppressClick = true;
      s.tab = 'timeline'; // zooming into a section means: show me what happened there
      const g = tapeGeom(s, cv.getBoundingClientRect().width);
      setView(s, g.idx(Math.min(startPx, endPx)), g.idx(Math.max(startPx, endPx)));
    }
  };
  window.addEventListener('mousemove', onWinMove);
  window.addEventListener('mouseup', onWinUp);

  cv.addEventListener('click', (e) => {
    if (s._suppressClick) { s._suppressClick = false; return; }
    if (inBand(e)) {
      const r = cv.getBoundingClientRect();
      const frac = (pxOf(e) - TAPE.pad) / (r.width - 2 * TAPE.pad);
      const v = viewOf(s), half = (v.b - v.a) / 2;
      const center = Math.max(0, Math.min(1, frac)) * (n() - 1);
      setView(s, center - half, center + half);
      return;
    }
    select(s, idxFromEvent(e), { scrollRail: true });
  });
  cv.addEventListener('dblclick', () => {
    setView(s, 0, n() - 1);
    select(s, n() - 1, { scrollRail: true }); // full reset: un-pin, back to the latest record
  });

  cv.addEventListener('mousemove', (e) => {
    setCur(inBand(e) ? 'grab' : 'crosshair'); // band pans, plot scrubs/zooms
    if (downX != null && dragging) return; // no tooltip mid-drag
    const px = pxOf(e);
    const i = idxFromEvent(e);
    s.hover = i;
    drawTape(s);
    tip.style.display = 'block';
    tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 360) + 'px';
    tip.style.top = (e.clientY + 16) + 'px';
    // a collapsed idle gap owns the tooltip inside its band
    const gap = (s._gapBands || []).find((b) => px >= b.px0 && px <= b.px1);
    if (gap) {
      tip.innerHTML = `<b>${esc(fmtDur(gap.dur))}</b> elapsed · idle gap (compressed to a sliver)<br>` +
        `<span class="k">${esc(fmtTime(gap.t0))} → ${esc(fmtTime(gap.t1))} · no recorded activity</span>`;
      return;
    }
    // a gridline within 5px owns the tooltip
    let near = null;
    for (const gl of s._grid || []) {
      if (Math.abs(gl.px - px) <= 5 && (!near || Math.abs(gl.px - px) < Math.abs(near.px - px))) near = gl;
    }
    if (near) {
      const times = timeIndex(s);
      const startT = times[0].t, endT = times[times.length - 1].t;
      const ri = Math.max(0, Math.min(n() - 1, Math.round(near.idx)));
      const u = tokensAt(s.model, ri);
      tip.innerHTML = `<span class="k">${esc(fmtTime(near.t))}</span><br>` +
        `+${esc(fmtDur(near.t - startT))} into session · ${esc(fmtDur(endT - near.t))} to end<br>` +
        `~record ${ri + 1}/${n()} · ${u ? fmtInt(u.ctx) + ' tok in window' : 'no usage yet'}`;
      return;
    }
    const rec = s.model.content[i];
    const u = tokensAt(s.model, i);
    tip.innerHTML = `<span class="k">#${i + 1} ${esc(rec.subtype || rec.type)}</span> · ${u ? fmtInt(u.ctx) + ' tok' : ''}<br>${esc(recPreview(rec).slice(0, 120))}`;
  });
  cv.addEventListener('mouseleave', () => {
    s.hover = null; tip.style.display = 'none';
    cv.dataset.cur = ''; cv.style.cursor = '';
    drawTape(s);
  });

  document.getElementById('zoomOut').addEventListener('click', () => {
    const v = viewOf(s), c = (v.a + v.b) / 2, half = v.b - v.a;
    setView(s, c - half, c + half);
  });
  document.getElementById('zoomReset').addEventListener('click', () => setView(s, 0, n() - 1));
  document.getElementById('axisToggle').addEventListener('click', (e) => {
    s.axis = s.axis === 'record' ? 'time' : 'record';
    e.target.textContent = s.axis === 'record' ? '# record axis' : '⏱ time axis';
    drawTape(s);
    renderRailMap(s);
  });
  updateZoomReadout(s);
}

/* The selection cursor eases to its new record instead of teleporting, so the eye keeps
   hold of both origin and destination. ~150ms of easeOutCubic on one rAF loop —
   the same work a single tape hover already costs, times ~9 frames.
   It snaps (no loop, no state left behind) when motion is off, when the
   selection moved the zoom window (before/after pixels are not comparable, and
   setView has already redrawn), or when the jump is wider than the visible
   window — that far, a slide is a distraction, not continuity. */
function glideSel(s, prevSel, zoomed) {
  if (s._glideRaf) { cancelAnimationFrame(s._glideRaf); s._glideRaf = 0; }
  const cv = document.getElementById('tape');
  const v = viewOf(s);
  const snap = !cv || zoomed
    || prevSel == null || !Number.isFinite(prevSel) || prevSel === s.sel
    || Math.abs(s.sel - prevSel) > (v.b - v.a)
    || matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (snap) {
    s.selDraw = null; s._glideFrame = false;
    drawTape(s);
    return;
  }
  const from = s.selDraw ?? prevSel; // re-click mid-flight resumes from where it looks
  const to = s.sel;
  const t0 = performance.now();
  const step = (now) => {
    if (document.getElementById('tape') !== cv || state.session !== s) {
      s._glideRaf = 0; s._glideFrame = false; s.selDraw = null; // route changed under us
      return;
    }
    const k = Math.min(1, (now - t0) / 150);
    if (k >= 1) {
      s.selDraw = null; s._glideFrame = false; s._glideRaf = 0;
      drawTape(s); // cleared first, so the lanes rebuild exactly once — here
      return;
    }
    s.selDraw = from + (to - from) * (1 - Math.pow(1 - k, 3));
    s._glideFrame = true; // intermediate frames skip the lane DOM rebuild
    drawTape(s);
    s._glideRaf = requestAnimationFrame(step);
  };
  s._glideRaf = requestAnimationFrame(step);
}

function drawTape(s) {
  const cv = document.getElementById('tape');
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, W, H);

  const n = s.model.content.length;
  if (!n) return;
  const geom = tapeGeom(s, W);
  const { v, x, ts } = geom;
  const bandTop = H - TAPE.bandH;
  const stripTop = bandTop - 2 - TAPE.stripH;
  const chartH = stripTop - 4;

  // token series over the full session, cached (context size stepped forward)
  if (!s._pts) {
    let last = 0, maxTok = 1;
    const pts = [];
    s.model.content.forEach((r) => {
      const u = usageOf(r);
      if (u) { last = u.ctx; maxTok = Math.max(maxTok, u.ctx); }
      pts.push(last);
    });
    s._pts = pts; s._maxTok = maxTok;
  }
  const pts = s._pts;
  const y = (t) => chartH - (t / s._maxTok) * (chartH - 10) + 4;

  const i0 = Math.max(0, Math.floor(v.a)), i1 = Math.min(n - 1, Math.ceil(v.b));

  // collapsed idle gaps: hatched slivers with the compressed duration
  s._gapBands = [];
  if (ts && geom.scale) {
    for (const sg of geom.scale.segs) {
      if (!sg.gap) continue;
      const px0 = sg.x0, px1 = sg.x1;
      if (px1 < 0 || px0 > W) continue;
      s._gapBands.push({ px0, px1, dur: sg.dur, t0: sg.t0, t1: sg.t1 });
      g.save();
      g.beginPath(); g.rect(px0, 2, px1 - px0, bandTop - 4); g.clip();
      g.fillStyle = CANVAS.gapFill;
      g.fillRect(px0, 2, px1 - px0, bandTop - 4);
      g.strokeStyle = CANVAS.gapLine; g.lineWidth = 1;
      for (let hx = px0 - bandTop; hx < px1; hx += 7) {
        g.beginPath(); g.moveTo(hx, bandTop); g.lineTo(hx + bandTop, 0); g.stroke();
      }
      g.restore();
      g.strokeStyle = CANVAS.gapLine;
      g.beginPath(); g.moveTo(px0 + 0.5, 2); g.lineTo(px0 + 0.5, bandTop - 2);
      g.moveTo(px1 - 0.5, 2); g.lineTo(px1 - 0.5, bandTop - 2); g.stroke();
      if (px1 - px0 >= 44) {
        g.fillStyle = CANVAS.gapText;
        g.font = '9.5px ui-monospace, Menlo, monospace';
        g.textAlign = 'center';
        g.fillText(`⋯ ${fmtDur(sg.dur)}`, (px0 + px1) / 2, 20);
        g.textAlign = 'start';
      }
    }
  }

  // adaptive time-slice gridlines — behind the data; step chosen so the visible
  // window carries at most ~12 lines
  s._grid = [];
  const times = timeIndex(s);
  if (times.length > 1) {
    const t0 = timeAtIdx(times, v.a), t1 = timeAtIdx(times, v.b);
    const tspan = t1 - t0;
    if (tspan > 15e3) {
      const step = GRID_STEPS.find((st) => tspan / st <= 12) || GRID_STEPS[GRID_STEPS.length - 1];
      for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
        if (ts?.inGap(t)) continue; // no gridlines inside collapsed idle gaps
        const gi = idxAtTime(times, t);
        s._grid.push({ px: x(gi), t, idx: gi, step });
      }
      // time steps map to record-index positions, so idle gaps bunch lines into
      // a few pixels — keep only lines with breathing room
      const MIN_GAP = 32;
      let lastX = -Infinity;
      s._grid = s._grid.filter((gl) => (gl.px - lastX >= MIN_GAP ? ((lastX = gl.px), true) : false));
      g.strokeStyle = CANVAS.grid;
      g.lineWidth = 1;
      for (const gl of s._grid) {
        g.beginPath(); g.moveTo(gl.px + 0.5, 2); g.lineTo(gl.px + 0.5, bandTop - 2); g.stroke();
      }
      let lastLabelX = -1e9;
      g.fillStyle = CANVAS.gapText;
      g.font = '9.5px ui-monospace, Menlo, monospace';
      for (const gl of s._grid) {
        if (gl.px - lastLabelX < 64) continue;
        g.fillText(fmtClock(gl.t, step), gl.px + 4, 11);
        lastLabelX = gl.px;
      }
    }
  }

  // area (single amber series)
  g.beginPath();
  g.moveTo(x(i0), y(pts[i0]));
  for (let i = i0 + 1; i <= i1; i++) g.lineTo(x(i), y(pts[i]));
  g.lineTo(x(i1), chartH + 4); g.lineTo(x(i0), chartH + 4); g.closePath();
  g.fillStyle = CANVAS.curveFill;
  g.fill();
  g.beginPath();
  g.moveTo(x(i0), y(pts[i0]));
  for (let i = i0 + 1; i <= i1; i++) g.lineTo(x(i), y(pts[i]));
  g.strokeStyle = CANVAS.curve; g.lineWidth = 2; g.stroke();

  // tick strip by kind — ticks widen as the zoom deepens
  const tickW = Math.max(1.5, Math.min(10, ((W - 8) / (i1 - i0 + 1)) * 0.66));
  for (let i = i0; i <= i1; i++) {
    const r = s.model.content[i];
    if (!matchesFilter(s, r)) continue;
    const kind = recKind(r);
    g.globalAlpha = r.isSidechain ? 0.35 : 0.9;
    if (kind === 'srvtool') {
      g.strokeStyle = KIND_COLORS.srvtool; g.lineWidth = 1.5;
      g.strokeRect(x(i) - tickW / 2 + 0.75, stripTop + 0.75, Math.max(1.5, tickW - 1.5), TAPE.stripH - 3.5);
    } else {
      g.fillStyle = KIND_COLORS[kind];
      g.fillRect(x(i) - tickW / 2, stripTop, tickW, TAPE.stripH - 2);
    }
    g.globalAlpha = 1;
  }

  // compaction splices: full-height, dashed (shape = secondary encoding)
  for (let i = i0; i <= i1; i++) {
    const r = s.model.content[i];
    if (!matchesFilter(s, r)) continue;
    if (r.type === 'system' && r.subtype === 'compact_boundary') {
      g.strokeStyle = KIND_COLORS.event; g.lineWidth = 2;
      g.setLineDash([5, 3]);
      g.beginPath(); g.moveTo(x(i), 2); g.lineTo(x(i), bandTop - 4); g.stroke();
      g.setLineDash([]);
    }
  }

  // overview band: full session extent (compressed-time axis) + window + selection
  const bandTimes = timeIndex(s);
  const bandScale = ts ? buildTimePixelScale(s, ts.t0, ts.t1, W, TAPE.pad) : null;
  const fx = bandScale
    ? (i) => bandScale.xOfT(timeAtIdx(bandTimes, i))
    : (i) => (i / Math.max(1, n - 1)) * (W - 2 * TAPE.pad) + TAPE.pad;
  g.fillStyle = CANVAS.band;
  g.fillRect(TAPE.pad, bandTop, W - 2 * TAPE.pad, TAPE.bandH);
  g.fillStyle = 'rgba(233,185,73,0.35)';
  g.fillRect(fx(v.a), bandTop, Math.max(2, fx(v.b) - fx(v.a)), TAPE.bandH);
  // active filters: paint every match on the full extent so you can see where they live
  if (s.filter && s.filter.size) {
    for (let i = 0; i < n; i++) {
      const r = s.model.content[i];
      if (r.isSidechain && !s.showSidechain) continue;
      if (!matchesFilter(s, r)) continue;
      g.fillStyle = KIND_COLORS[recKind(r)];
      g.fillRect(fx(i) - 0.75, bandTop, 1.5, TAPE.bandH);
    }
  }
  const sx = s.selDraw ?? s.sel; // float drawn-index while the cursor glides
  g.fillStyle = ACCENT;
  g.fillRect(fx(sx) - 1, bandTop, 2, TAPE.bandH);

  // live drag-selection overlay
  if (s.dragSel) {
    const ax = Math.min(s.dragSel[0], s.dragSel[1]);
    const bx = Math.max(s.dragSel[0], s.dragSel[1]);
    const ia = geom.idx(ax), ib = geom.idx(bx);
    // setView recenters anything under ~5 records; show that floor while dragging
    // rather than springing it on the user after release
    const belowFloor = Math.abs(ib - ia) < 4;
    const jawH = bandTop - 4;
    if (belowFloor) {
      g.fillStyle = 'rgba(223,228,236,0.06)';
      g.fillRect(ax, 0, bx - ax, jawH);
      g.fillStyle = 'rgba(223,228,236,0.45)';
      g.fillRect(ax, 0, 1, jawH);
      g.fillRect(bx - 1, 0, 1, jawH);
    } else {
      g.fillStyle = 'rgba(233,185,73,0.15)';
      g.fillRect(ax, 0, bx - ax, jawH);
      g.fillStyle = ACCENT;
      g.fillRect(ax - 1, 0, 2, jawH);
      g.fillRect(bx - 1, 0, 2, jawH);
      // serifs point inward, so the pair reads as calipers closing on the trace
      g.fillRect(ax - 1, 0, 5, 1); g.fillRect(ax - 1, bandTop - 5, 5, 1);
      g.fillRect(bx - 4, 0, 5, 1); g.fillRect(bx - 4, bandTop - 5, 5, 1);
    }
    if (bx - ax > 90) {
      let label = `${Math.round(Math.abs(ib - ia)) + 1} rec`;
      const dtimes = timeIndex(s);
      if (s.axis === 'time' && dtimes.length > 1) {
        label += ` · ${fmtDur(Math.abs(timeAtIdx(dtimes, ib) - timeAtIdx(dtimes, ia)))}`;
      }
      g.fillStyle = belowFloor ? 'rgba(223,228,236,.5)' : 'rgba(233,185,73,.85)';
      g.font = '10.5px ui-monospace, Menlo, monospace';
      g.textAlign = 'center';
      g.fillText(label, (ax + bx) / 2, bandTop + TAPE.bandH - 1);
      g.textAlign = 'start';
    }
  }

  // hover crosshair
  if (s.hover != null && s.hover >= i0 && s.hover <= i1) {
    g.strokeStyle = CANVAS.hair; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x(s.hover), 0); g.lineTo(x(s.hover), bandTop - 2); g.stroke();
  }
  // selection cursor
  if (s.sel >= v.a - 0.5 && s.sel <= v.b + 0.5) {
    g.strokeStyle = ACCENT; g.lineWidth = 2;
    g.beginPath(); g.moveTo(x(sx), 0); g.lineTo(x(sx), bandTop - 2); g.stroke();
    g.fillStyle = ACCENT;
    g.beginPath(); g.moveTo(x(sx) - 5, 0); g.lineTo(x(sx) + 5, 0); g.lineTo(x(sx), 7); g.closePath(); g.fill();
  }
  if (s.agents?.length && !s._glideFrame) renderLanes(s); // lanes rebuild DOM: once, on arrival
}

// ---------- agent sub-timelines ----------
/* Subagents ship as companion files: subagents/agent-<id>.jsonl (a full
   transcript) + .meta.json ({agentType, description, toolUseId, spawnDepth}).
   toolUseId ties each agent to the Agent tool call in the main transcript.
   Lanes are wall-clock spans mapped onto the main tape's x-axis. */

async function loadAgents(s) {
  const files = s.manifest.files || [];
  const metaFiles = files.filter((f) => /^subagents\/.*\.meta\.json$/.test(f));
  if (!metaFiles.length) return;
  const agents = [];
  await Promise.all(metaFiles.map(async (mf) => {
    try {
      const jf = mf.replace('.meta.json', '.jsonl');
      if (!files.includes(jf)) return;
      const [meta, text] = await Promise.all([
        jget(API.file(s.id, mf)),
        tget(API.file(s.id, jf)),
      ]);
      const model = parseTranscript(text);
      const stamps = model.content.filter((r) => r.timestamp);
      if (!stamps.length) return;
      agents.push({
        id: (mf.match(/agent-([A-Za-z0-9]+)\./) || [null, mf])[1],
        meta, model, file: jf,
        t0: Date.parse(stamps[0].timestamp),
        t1: Date.parse(stamps[stamps.length - 1].timestamp),
      });
    } catch { /* skip unreadable agent */ }
  }));
  if (!agents.length) return;
  agents.sort((a, b) => a.t0 - b.t0);
  // pack overlapping spans into rows (first row whose last span ended before we start)
  const rowEnds = [];
  for (const a of agents) {
    let ri = rowEnds.findIndex((end) => end <= a.t0);
    if (ri === -1) { rowEnds.push(0); ri = rowEnds.length - 1; }
    rowEnds[ri] = a.t1;
    a.row = ri;
  }
  s.agents = agents;
  s.laneRows = rowEnds.length;
  renderLanes(s);
}

function openAgent(s, id) {
  const a = s.agents?.find((x) => x.id === id);
  if (!a || s.agentFocus === a) return;
  enterAgentFocus(s, a);
}

/* Focus mode: the whole session view — tape, rail, tabs, preview — takes on the
   agent's transcript. The previous main-view state (zoom, selection, tab,
   preview) is saved and restored exactly on exit. */
function resetModelCaches(s) {
  s._pts = null; s._maxTok = null; s._times = null; s._grid = []; s._tscale = null;
}

function enterAgentFocus(s, a) {
  if (s.agentFocus) exitAgentFocus(s, { silent: true });
  s._saved = { model: s.model, view: s.view, sel: s.sel, tab: s.tab, preview: s.preview, agentSel: s.agentSel };
  // spawn point in the parent transcript, for the bar's jump link
  let spawnIdx = -1;
  if (a.meta.toolUseId) {
    spawnIdx = s._saved.model.content.findIndex((r) => Array.isArray(r.message?.content) &&
      r.message.content.some((b) => b.type === 'tool_use' && b.id === a.meta.toolUseId));
  }
  s.agentFocus = a;
  s.agentSel = a.id;
  s.model = a.model;
  s.view = null;
  resetModelCaches(s);
  s.sel = Math.max(0, a.model.content.length - 1);
  s.tab = 'timeline'; // an agent run reads best as its full event stream
  s.preview = null;
  const bar = document.getElementById('agentFocusBar');
  bar.style.display = '';
  bar.innerHTML = `
    <button class="mini-btn" id="afbBack" type="button">⟵ back to session (Esc)</button>
    <span class="afb-label">⧉ sub-agent · <b>${esc(a.meta.agentType || 'agent')}</b> — ${esc(a.meta.description || a.id)} · ${a.model.content.length} records · ${esc(fmtDur(a.t1 - a.t0))} · depth ${a.meta.spawnDepth ?? '?'}</span>
    ${spawnIdx >= 0 ? `<button class="mini-btn" id="afbSpawn" type="button">↧ spawn point</button>` : ''}`;
  document.getElementById('afbBack').addEventListener('click', () => exitAgentFocus(s));
  const sp = document.getElementById('afbSpawn');
  if (sp) sp.addEventListener('click', () => { exitAgentFocus(s); select(s, spawnIdx, { scrollRail: true }); });
  renderRail(s);
  renderTabs(s);
  select(s, s.sel, { scrollRail: true });
  updateZoomReadout(s);
  renderLanes(s); // hides itself in focus mode
}

function exitAgentFocus(s, opts = {}) {
  const sv = s._saved;
  if (!sv) return;
  s.agentFocus = null;
  s._saved = null;
  s.model = sv.model;
  s.view = sv.view;
  s.tab = sv.tab;
  s.agentSel = sv.agentSel;
  resetModelCaches(s);
  document.getElementById('agentFocusBar').style.display = 'none';
  if (opts.silent) return;
  renderRail(s);
  renderTabs(s);
  select(s, sv.sel, { scrollRail: true });
  if (sv.preview) { s.preview = sv.preview; renderPreview(s); }
  updateZoomReadout(s);
  renderLanes(s);
}

function renderLanes(s) {
  const wrap = document.getElementById('lanes');
  if (!wrap) return;
  if (!s.agents?.length || s.agentFocus) { wrap.style.display = 'none'; return; }
  const cv = document.getElementById('tape');
  const W = cv.clientWidth;
  const { x } = tapeGeom(s, W);
  const times = timeIndex(s);
  const ROW_H = 17;

  // cluster agents whose wall-clock spans overlap (agents are sorted by t0);
  // 1–2 agents render as bars, larger fan-outs collapse into one chip
  const clusters = [];
  for (const a of s.agents) {
    const cur = clusters[clusters.length - 1];
    if (cur && a.t0 <= cur.t1) { cur.items.push(a); cur.t1 = Math.max(cur.t1, a.t1); }
    else clusters.push({ t0: a.t0, t1: a.t1, items: [a] });
  }
  const rows = clusters.some((c) => c.items.length === 2) ? 2 : 1;
  wrap.style.display = '';
  wrap.style.height = rows * ROW_H + 11 + 'px'; // includes the channel padding

  wrap.innerHTML = clusters.map((cl, ci) => {
    const x0 = x(idxAtTime(times, cl.t0)), x1 = x(idxAtTime(times, cl.t1));
    if (x1 < 4 || x0 > W - 4) return '';
    const left = Math.max(2, x0);
    if (cl.items.length <= 2) {
      return cl.items.map((a, i) => {
        const ax0 = Math.max(2, x(idxAtTime(times, a.t0)));
        const aw = Math.max(7, Math.min(W - 2, x(idxAtTime(times, a.t1))) - ax0);
        return `<div class="lane-bar${s.agentSel === a.id ? ' on' : ''}" data-cl="${ci}" data-it="${i}" role="button" tabindex="0"
          style="top:${i * ROW_H + 4}px;left:${ax0}px;width:${aw}px">${esc(`${a.meta.agentType || 'agent'} · ${a.meta.description || a.id}`)}</div>`;
      }).join('');
    }
    const width = Math.max(34, Math.min(W - 2, x1) - left);
    const active = cl.items.some((a) => a.id === s.agentSel);
    const typeCounts = {};
    cl.items.forEach((a) => { const t = a.meta.agentType || 'agent'; typeCounts[t] = (typeCounts[t] || 0) + 1; });
    const types = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
    const label = types.length === 1
      ? `⧉ ${cl.items.length} × ${types[0][0]}`
      : `⧉ ${cl.items.length} · ${types.slice(0, 2).map(([t, n]) => `${t} ${n}`).join(' · ')}${types.length > 2 ? ` +${types.length - 2}` : ''}`;
    return `<div class="lane-chip${active ? ' on' : ''}" data-cl="${ci}" role="button" tabindex="0"
      style="top:4px;left:${left}px;width:${width}px">${esc(label)}</div>`;
  }).join('');

  const tip = document.getElementById('tapeTip');
  let hideT = null;
  const hidePop = () => { document.getElementById('lanePop')?.remove(); };
  const scheduleHide = () => { clearTimeout(hideT); hideT = setTimeout(hidePop, 250); };
  const showPop = (cl, anchor) => {
    clearTimeout(hideT);
    hidePop();
    const pop = document.createElement('div');
    pop.id = 'lanePop';
    pop.className = 'lane-pop';
    const groups = new Map();
    cl.items.forEach((a) => { const t = a.meta.agentType || 'agent'; if (!groups.has(t)) groups.set(t, []); groups.get(t).push(a); });
    const item = (a) => `<div class="lane-pop-item" data-id="${esc(a.id)}" role="button" tabindex="0">
        <span class="dot" style="background:${KIND_COLORS.tool};width:8px;height:8px;border-radius:2px;flex:none"></span>
        <span class="lp-name">${esc(a.meta.description || a.id)}</span>
        <span class="lp-dur">${esc(fmtDur(a.t1 - a.t0))} · ${a.model.content.length} rec</span>
      </div>`;
    pop.innerHTML = `<div class="eyebrow" style="margin-bottom:6px">${cl.items.length} parallel agents · ${esc(fmtTime(cl.t0))} → ${esc(fmtTime(cl.t1))}</div>` +
      [...groups.entries()].map(([t, arr]) =>
        `<div class="lp-group">${esc(t)} × ${arr.length}</div>` + arr.map(item).join('')).join('');
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 400)) + 'px';
    pop.style.top = (r.bottom + 6) + 'px';
    pop.addEventListener('mouseenter', () => clearTimeout(hideT));
    pop.addEventListener('mouseleave', scheduleHide);
    pop.querySelectorAll('.lane-pop-item').forEach((it) => {
      const activate = () => { hidePop(); openAgent(s, it.dataset.id); };
      it.addEventListener('click', activate);
      it.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });
    });
  };

  wrap.querySelectorAll('.lane-bar').forEach((b) => {
    const a = clusters[+b.dataset.cl].items[+b.dataset.it];
    const open = () => openAgent(s, a.id);
    b.addEventListener('click', open);
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    b.addEventListener('mousemove', (e) => {
      tip.style.display = 'block';
      tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 360) + 'px';
      tip.style.top = (e.clientY + 16) + 'px';
      tip.innerHTML = `<span class="k">${esc(a.meta.agentType || 'agent')} agent · depth ${a.meta.spawnDepth ?? '?'}</span><br>` +
        `${esc(a.meta.description || a.id)}<br>` +
        `<span class="k">${esc(fmtTime(a.t0))} → ${esc(fmtTime(a.t1))} · ${esc(fmtDur(a.t1 - a.t0))} · ${a.model.content.length} records — click to open</span>`;
    });
    b.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  });
  wrap.querySelectorAll('.lane-chip').forEach((ch) => {
    const cl = clusters[+ch.dataset.cl];
    ch.addEventListener('mouseenter', () => showPop(cl, ch));
    ch.addEventListener('mouseleave', scheduleHide);
    ch.addEventListener('click', () => showPop(cl, ch));
    ch.addEventListener('focus', () => showPop(cl, ch));
  });
}

// ---------- tabs + panels ----------

function renderTabs(s) {
  const snap = s.snapshots[s.snapIdx]?.data;
  const st = stateAt(s.model, s.sel);
  // short labels + counts as light superscripts: nine tabs have to fit one row
  // without wrapping or horizontal scrolling
  const tabs = [
    ['timeline', 'Timeline', 0],
    ['context', 'Context', 0],
    ['sep1', '', 0],
    ['sysprompt', 'Prompt', (snap?.systemPrompt || []).length],
    ['tools', 'Tools', (snap?.tools || []).length || st.deferredTools.size],
    ['skills', 'Skills', st.skillListing?.skillCount || 0],
    ['mcp', 'MCP', st.mcpInstructions.length],
    ['memory', 'Memory', (s.memory?.files || []).filter((f) => f.name !== 'MEMORY.md').length],
    ['sep2', '', 0],
    ['snapshot', 'Snapshot', s.snapshots.length],
    ['files', 'Files', (s.manifest.files || []).length],
  ];
  // build once, then update in place: select() calls renderTabs on every
  // selection, and rebuilding the nodes both restarts the pill transition and
  // re-binds four click listeners thousands of times a session
  const tabsEl = document.getElementById('tabs');
  const realTabs = tabs.filter(([k]) => !k.startsWith('sep')); // separators aren't buttons
  let btns = [...tabsEl.querySelectorAll('button')];
  if (btns.length !== realTabs.length) {
    tabsEl.innerHTML = tabs.map(([k]) => (k.startsWith('sep')
      ? '<span class="tab-sep" aria-hidden="true"></span>'
      : `<button data-tab="${k}"></button>`)).join('');
    btns = [...tabsEl.querySelectorAll('button')];
    btns.forEach((b) => b.addEventListener('click', () => { s.tab = b.dataset.tab; renderTabs(s); renderPanel(s); }));
  }
  btns.forEach((b, i) => {
    const [k, label, count] = realTabs[i];
    if (b.dataset.tab !== k) b.dataset.tab = k;
    const sig = `${label}|${count}`;
    if (b.dataset.sig !== sig) { // counts are live; only touch the DOM when they move
      b.dataset.sig = sig;
      b.innerHTML = `${esc(label)}${count ? `<span class="tab-n">${count}</span>` : ''}`;
    }
    b.classList.toggle('on', s.tab === k);
  });
  // sort order and find-in-view only make sense on the event-list tabs
  const listy = s.tab === 'timeline' || s.tab === 'context';
  const searchable = listy || ['sysprompt', 'tools', 'skills', 'mcp', 'memory'].includes(s.tab);
  const sortBtn = document.getElementById('sortToggle');
  if (sortBtn) sortBtn.style.display = listy ? '' : 'none';
  const sqWrap = document.querySelector('.panel-search');
  if (sqWrap) sqWrap.style.display = searchable ? '' : 'none';
  // section heads pin below the finder band when it is showing, so the two
  // never overlap (the finder would otherwise clip the head card's corners)
  const panelEl = document.querySelector('.ctx-panel');
  if (panelEl) {
    const band = panelEl.querySelector('.panel-search');
    const h = band && band.style.display !== 'none' ? band.offsetHeight : 0;
    panelEl.style.setProperty('--pheadH', h + 'px');
  }
}

function roleOf(r, kind, opts = {}) {
  return r.isCompactSummary ? 'compact summary'
    : r.type === 'attachment' ? (r.attachment?.type || 'attachment')
    : r.type === 'system' ? (r.subtype || 'system')
    : kind === 'srvtool' ? (r.type === 'user' ? 'server tool result' : 'server tool call')
    : kind === 'tool' ? (r.type === 'user' ? 'tool result' : 'tool call')
    : opts.orchestrator && kind === 'user' ? 'orchestrator'
    : r.type;
}

function chipsHtml(counts, s) {
  return Object.keys(counts).map((k) =>
    `<span class="chip chip-f${s.filter?.has(k) ? ' on' : ''}" data-f="${esc(k)}" role="button" tabindex="0" title="click to filter by ${esc(KIND_LABELS[k] || k)} · click again to remove" style="--chip-c:${KIND_COLORS[k] || 'var(--line)'}">${esc(KIND_LABELS[k] || k)} ${counts[k]}</span>`).join('');
}

function layer(title, badge, bodyHtml, open = false, cls = '') {
  return `<details class="layer${cls ? ' ' + cls : ''}"${open ? ' open' : ''}>
    <summary><span class="eyebrow">${title}</span><span class="badge">${badge}</span></summary>
    <div class="body">${bodyHtml}</div>
  </details>`;
}

/* Scroll a panel row into view without the long useless ride: smooth only when
   the trip is short enough to read as motion, plain jump otherwise. The global
   prefers-reduced-motion transition kill in the stylesheet does not cover
   scroll behaviour, so check it here. */
function settleIntoView(el, opts = {}) {
  if (!el?.scrollIntoView) return;
  let behavior = 'auto';
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const box = el.closest('.ctx-panel');
    const h = box?.clientHeight || 0;
    if (h && box.scrollHeight > box.clientHeight + 1) {
      const delta = Math.abs(el.getBoundingClientRect().top - box.getBoundingClientRect().top - h / 2);
      if (delta < h * 1.5) behavior = 'smooth';
    }
  }
  el.scrollIntoView({ ...opts, behavior });
}

/* Sticky heads earn their shadow: flat while the pane sits at the top, lifted
   the moment content slides under them. One class toggle per frame, per pane —
   nothing here touches the rows themselves. */
function initStickyHeads(s) {
  const watch = (scroller, target, cls) => {
    if (!scroller || !target) return;
    let t = 0;
    scroller.addEventListener('scroll', () => {
      if (t) return;
      t = requestAnimationFrame(() => { t = 0; target.classList.toggle(cls, scroller.scrollTop > 2); });
    }, { passive: true });
  };
  const panel = document.querySelector('.ctx-panel');
  watch(panel, panel, 'stuck');
  watch(document.getElementById('rail'), document.getElementById('railBox'), 'scrolled');
}

function renderPanel(s) {
  const panel = document.getElementById('panel');
  PV_ITEMS = [];
  if (s.tab === 'context') renderContextTab(s, panel);
  else if (s.tab === 'sysprompt') renderSysPromptTab(s, panel);
  else if (s.tab === 'tools') renderToolsTab(s, panel);
  else if (s.tab === 'skills') renderSkillsTab(s, panel);
  else if (s.tab === 'mcp') renderMcpTab(s, panel);
  else if (s.tab === 'memory') renderMemoryTab(s, panel);
  else if (s.tab === 'snapshot') renderSnapshotTab(s, panel);
  else if (s.tab === 'files') renderFilesTab(s, panel);
  else renderTimelineTab(s, panel); // 'timeline' and any legacy tab id
  initJsonBlocks(panel);
  const head = panel.querySelector('.range-head');
  panel.parentElement?.style.setProperty('--rheadH', (head ? head.offsetHeight : 0) + 'px');
}

/* Range view: what happened inside the zoomed window — the span complement to
   the point-in-time context view. Rail-aligned: the selected record, if inside
   the range, is highlighted and scrolled to. */
function renderTimelineTab(s, panel) {
  const v = viewOf(s);
  const n = s.model.content.length;
  const lo = Math.max(0, Math.floor(v.a)), hi = Math.min(n - 1, Math.ceil(v.b));
  const full = lo <= 0 && hi >= n - 1;
  const base = [];
  for (let i = lo; i <= hi; i++) {
    const r = s.model.content[i];
    if (!matchesQuery(s, r)) continue;
    base.push(r);
  }
  const recs = base.filter((r) => matchesFilter(s, r));
  const counts = {};
  base.forEach((r) => { const k = recKind(r); counts[k] = (counts[k] || 0) + 1; });
  const uStart = tokensAt(s.model, lo), uEnd = tokensAt(s.model, hi);
  const tStart = s.model.content[lo]?.timestamp, tEnd = s.model.content[hi]?.timestamp;
  const dur = tStart && tEnd ? fmtDur(Date.parse(tEnd) - Date.parse(tStart)) : '—';
  const delta = uStart && uEnd ? uEnd.ctx - uStart.ctx : null;
  const chips = chipsHtml(counts, s);
  const selRec = s.model.content[s.sel];
  const focusUuid = s.sel >= lo && s.sel <= hi ? selRec?.uuid : null;

  let emptyState = '', nearest = null;
  if (!recs.length) {
    const matches = [];
    for (let i = 0; i < n; i++) {
      const r = s.model.content[i];
      if (r.isSidechain && !s.showSidechain) continue;
      if (!matchesFilter(s, r)) continue;
      matches.push(i);
    }
    const center = (lo + hi) / 2;
    for (const i of matches) if (nearest == null || Math.abs(i - center) < Math.abs(nearest - center)) nearest = i;
    emptyState = matches.length
      ? `<div class="layer"><div class="body">
           <p class="hint">No matching events inside this range — the active filters are fine, the matches just live elsewhere: <b style="color:var(--ink)">${matches.length}</b> across the whole session (see the colored marks on the overview band).</p>
           <p class="hint" style="margin-top:6px">Nearest: record #${nearest + 1} — ${esc(recPreview(s.model.content[nearest]).slice(0, 90))}</p>
           <button class="mini-btn" id="jumpNearest" type="button" style="margin-top:8px">jump to record #${nearest + 1}</button>
         </div></div>`
      : `<div class="layer"><div class="body"><p class="hint">No records match the active filters anywhere in this session.</p></div></div>`;
  }

  panel.innerHTML = `
    <div class="range-head">
      <div class="range-card">
        <div class="rh-row">
          <span class="eyebrow" style="color:var(--accent)">timeline · ${full ? 'whole session' : 'zoomed range'}</span>
          <span class="rh-badge">records ${lo + 1}–${hi + 1} of ${n}${s.filter?.size || s.q ? ' · filtered' : ''}</span>
        </div>
        <div class="kv" style="margin:8px 0 10px">
          <span class="k">events shown</span><span>${recs.length}${s.filter?.size ? ' (filtered)' : ''}</span>
          <span class="k">wall clock</span><span>${esc(fmtTime(tStart))} → ${esc(fmtTime(tEnd))} · ${esc(dur)}</span>
          <span class="k">window tokens</span><span>${uStart ? fmtInt(uStart.ctx) : '—'} → ${uEnd ? fmtInt(uEnd.ctx) : '—'}${delta != null ? ` <b style="color:var(--accent)">(${delta >= 0 ? '+' : ''}${fmtInt(delta)})</b>` : ''}</span>
        </div>
        <div class="chiplist">${chips}</div>
      </div>
    </div>
    <div class="ctx-group">
      ${emptyState}${(s.sortDesc ? [...recs].reverse() : recs).map((r) => renderMsg(r, focusUuid, deltasOf(s.model), { orchestrator: !!s.agentFocus, durs: durationsOf(s.model) })).join('')}
    </div>`;
  const jump = document.getElementById('jumpNearest');
  if (jump && nearest != null) jump.addEventListener('click', () => {
    const span = Math.max(4, hi - lo);
    setView(s, nearest - span / 2, nearest + span / 2);
    select(s, nearest, { scrollRail: true });
    // select() has re-rendered the panel; flag where the jump landed
    // reduced motion kills the keyframes, so animationend would never fire and
    // the class would stick — skip it entirely; the amber .focus bar already
    // says where the jump landed
    const landed = matchMedia('(prefers-reduced-motion: reduce)').matches
      ? null : document.getElementById('panel').querySelector('.msg.focus');
    if (landed) {
      landed.classList.add('arrived');
      landed.addEventListener('animationend', () => landed.classList.remove('arrived'), { once: true });
    }
  });
  const focusEl = panel.querySelector('.msg.focus');
  if (focusEl) settleIntoView(focusEl, { block: 'center' });
}

/* Ground-truth tabs. These four render the material that governs the whole
   session — the prompt head — split by kind so each is browsable on its own.
   All of them honour the in-view search. */
function groundHead(s, title, badge, note) {
  return `<div class="range-head"><div class="range-card">
      <div class="rh-row">
        <span class="eyebrow" style="color:var(--accent)">${esc(title)}</span>
        <span class="rh-badge">${esc(badge)}${s.q ? ' · filtered' : ''}</span>
      </div>
      ${note ? `<p class="note" style="margin:8px 0 0">${note}</p>` : ''}
    </div></div>`;
}

const noSnapshotWarning = `<div class="layer"><div class="body"><p class="warn">No snapshot exported for this session — the system prompt and tool schemas exist only inside the model's context, so only <code>/snapshot</code> run from within the live session can capture them.</p></div></div>`;

function snapPicker(s) {
  return s.snapshots.length > 1
    ? `<select class="pill-select" id="snapSel">${s.snapshots.map((sn, i) =>
        `<option value="${i}"${i === s.snapIdx ? ' selected' : ''}>${esc(sn.data.exportedAt || sn.name)}</option>`).join('')}</select>`
    : '';
}

function wireSnapPicker(s) {
  const el = document.getElementById('snapSel');
  if (el) el.addEventListener('change', (e) => { s.snapIdx = +e.target.value; select(s, s.sel, { keepSnap: true }); });
}

function qmOf(s) {
  const q = (s.q || '').toLowerCase();
  return (...texts) => !q || texts.some((t) => String(t || '').toLowerCase().includes(q));
}

function renderSysPromptTab(s, panel) {
  const snap = s.snapshots[s.snapIdx]?.data;
  const st = stateAt(s.model, s.sel);
  const qm = qmOf(s);
  const secs = (snap?.systemPrompt || []).filter((x) => qm(x.title, x.content));
  const rules = (snap?.rules || []).filter((f) => qm(f.path, f.content));
  const parts = [groundHead(s, 'system prompt · ground truth',
    snap ? `${secs.length} sections · exported ${fmtTime(snap.exportedAt)} ${snapPicker(s)}` : 'no snapshot',
    'Transcribed by the model from its own context at export time — the model is the sensor here, and transcription can be lossy. This text is never stored on disk by Claude Code.')];
  parts.push(snap
    ? layer('Sections, in prompt order', `${secs.length}`, secs.length ? secs.map((sec) => pvRow(
        { kind: 'text', badge: 'system prompt section', color: 'var(--k-attach)', title: sec.title, sub: sec.provenance === 'library' ? 'from shared cache' : 'as transcribed', content: sec.content },
        { icon: '§', color: 'var(--k-attach)', label: sec.title, sub: sec.provenance === 'library' ? '⟲ cached' : '' })).join('') : '<p class="hint">No sections match the search.</p>', true)
    : noSnapshotWarning);
  if (rules.length) {
    parts.push(layer('Rules & memory files', `${rules.length} files`, rules.map((f) => pvRow(
      { kind: 'text', badge: 'rules file', color: 'var(--k-user)', title: f.path, content: f.content },
      { icon: '✎', color: 'var(--k-user)', label: f.path })).join(''), true));
  }
  if (st.outputStyle) {
    parts.push(layer('Output style in effect', 'latest supersedes',
      `<pre class="block">${esc(String(st.outputStyle.content || JSON.stringify(st.outputStyle, null, 2)))}</pre>`));
  }
  panel.innerHTML = parts.join('');
  wireSnapPicker(s);
}

function renderToolsTab(s, panel) {
  const snap = s.snapshots[s.snapIdx]?.data;
  const st = stateAt(s.model, s.sel);
  const qm = qmOf(s);
  const tools = (snap?.tools || []).filter((t) => qm(t.name, t.description));
  const deferred = [...st.deferredTools].sort().filter((t) => qm(t));
  const parts = [groundHead(s, 'tools · ground truth',
    `${tools.length} transcribed · ${deferred.length} deferred names`,
    'Transcribed definitions are the full schemas the model could see. Deferred tools are names surfaced into context whose schemas only load when fetched with ToolSearch.')];
  parts.push(snap
    ? layer('Definitions — as transcribed', `${tools.length} tools ${snapPicker(s)}`, tools.length ? tools.map((t) => pvRow(
        { kind: 'tool', badge: 'tool definition', color: 'var(--k-tool)', tool: t, sub: t.provenance === 'library' ? 'from shared cache' : 'as transcribed' },
        { icon: '⚒', color: 'var(--k-tool)', label: `${t.name} — ${(t.description || '').slice(0, 80)}`, sub: t.provenance === 'library' ? '⟲ cached' : '' })).join('') : '<p class="hint">No tools match the search.</p>', true)
    : noSnapshotWarning);
  parts.push(layer('Deferred tools surfaced so far', `${deferred.length} names · cumulative up to the selected record`,
    deferred.length ? `<div class="chiplist">${deferred.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : '<p class="hint">None at this point in the session.</p>', true));
  panel.innerHTML = parts.join('');
  wireSnapPicker(s);
}

function renderSkillsTab(s, panel) {
  const st = stateAt(s.model, s.sel);
  const listing = st.skillListing;
  const body = listing ? String(listing.content || (listing.names || []).join('\n')) : '';
  const q = (s.q || '').toLowerCase();
  const shown = q ? body.split('\n').filter((l) => l.toLowerCase().includes(q)).join('\n') : body;
  panel.innerHTML = groundHead(s, 'skills · ground truth',
    listing ? `${listing.skillCount ?? '?'} skills${listing.isInitial ? ' · initial listing' : ''}` : 'none in context',
    'The skill listing injected into context — what the model could invoke at this point in the session.') +
    (listing
      ? layer('Skill listing in effect', `${listing.skillCount ?? '?'} skills`,
          `<pre class="block">${esc(shown || '(no lines match the search)')}</pre>`, true)
      : `<div class="layer"><div class="body"><p class="hint">No skill listing had been injected into context by this point.</p></div></div>`);
}

function renderMcpTab(s, panel) {
  const st = stateAt(s.model, s.sel);
  const qm = qmOf(s);
  const deltas = st.mcpInstructions.filter((a) => qm(a.content));
  panel.innerHTML = groundHead(s, 'mcp · ground truth',
    `${st.mcpInstructions.length} delta(s)`,
    'Instructions supplied by connected MCP servers, injected into context as they connect. Tool schemas for MCP tools arrive separately and appear under Tools once fetched.') +
    (deltas.length
      ? deltas.map((a, i) => layer(`Server instructions · delta ${i + 1}`, '',
          `<pre class="block">${esc(String(a.content || JSON.stringify(a, null, 2)))}</pre>`, deltas.length === 1)).join('')
      : `<div class="layer"><div class="body"><p class="hint">${st.mcpInstructions.length ? 'No deltas match the search.' : 'No MCP server instructions in context at this point.'}</p></div></div>`);
}

function renderMemoryTab(s, panel) {
  const mem = s.memory;
  if (!mem) { panel.innerHTML = groundHead(s, 'memory · ground truth', 'loading…', ''); return; }
  const qm = qmOf(s);
  const files = (mem.files || []).filter((f) => qm(f.name, f.content));
  const index = files.find((f) => f.name === 'MEMORY.md');
  const entries = files.filter((f) => f.name !== 'MEMORY.md');
  // frontmatter is metadata, not prose: surface type/description in the row
  const meta = (content) => {
    const m = /^---\n([\s\S]*?)\n---/.exec(content || '');
    if (!m) return {};
    const get = (k) => (new RegExp(`^\\s*${k}:\\s*(.+)$`, 'm').exec(m[1]) || [])[1]?.replace(/^["']|["']$/g, '').trim();
    return { type: get('type'), description: get('description') };
  };
  const parts = [groundHead(s, 'memory · ground truth',
    `${entries.length} memories${mem.slug ? ` · ${mem.slug}` : ''}`,
    'Claude\'s persistent memory for this project — the facts it carries into every session here. MEMORY.md is the index loaded at startup; each entry is a single fact with typed frontmatter. Read-only.')];
  if (index) {
    parts.push(layer('MEMORY.md — the index loaded every session', `${(index.content || '').split('\n').filter((l) => l.trim()).length} lines`,
      `<pre class="block">${esc(index.content)}</pre>`, true));
  }
  parts.push(layer('Memories', `${entries.length}`, entries.length
    ? entries.map((f) => {
        const md = meta(f.content);
        return pvRow(
          { kind: 'text', badge: `memory · ${md.type || 'untyped'}`, color: 'var(--k-attach)', title: f.name, sub: f.modified ? fmtTime(f.modified) : '', content: f.content },
          { icon: '⌘', color: 'var(--k-attach)', label: md.description ? `${f.name} — ${md.description}` : f.name, sub: md.type || '' });
      }).join('')
    : `<p class="hint">${(mem.files || []).length ? 'No memories match the search.' : 'No memory directory for this project yet — Claude writes one when it learns something durable.'}</p>`, true));
  panel.innerHTML = parts.join('');
}

/* The Context window tab: what the model sees at the selected record, laid out like a
   real context window — prompt head first, then the message window. */
function renderContextTab(s, panel) {
  const rec = s.model.content[s.sel];
  const { chain, boundary } = chainAt(s.model, rec);
  const focusUuid = chain.length ? chain[chain.length - 1].uuid : null;
  const dropped = boundary?.compactMetadata;
  const base = chain.filter((r) => matchesQuery(s, r));
  const shown = base.filter((r) => matchesFilter(s, r));
  const counts = {};
  base.forEach((r) => { const k = recKind(r); counts[k] = (counts[k] || 0) + 1; });
  const u = tokensAt(s.model, s.sel);
  const t0 = chain[0]?.timestamp, t1 = chain[chain.length - 1]?.timestamp;
  panel.innerHTML = `
    <div class="range-head">
      <div class="range-card">
        <div class="rh-row">
          <span class="eyebrow" style="color:var(--accent)">context window · at the selected record</span>
          <span class="rh-badge">record ${s.sel + 1} of ${s.model.content.length}${s.filter?.size || s.q ? ' · filtered' : ''}</span>
        </div>
        <div class="kv" style="margin:8px 0 10px">
          <span class="k">messages in window</span><span>${shown.length}${shown.length !== chain.length ? ` of ${chain.length}` : ''}${boundary ? ' · after compaction' : ''}</span>
          <span class="k">window span</span><span>${esc(fmtTime(t0))} → ${esc(fmtTime(t1))}</span>
          <span class="k">window tokens</span><span>${u ? fmtInt(u.ctx) : '—'}${u ? ` <span style="color:var(--faint)">(read ${fmtInt(u.u.cache_read_input_tokens)} · write ${fmtInt(u.u.cache_creation_input_tokens)} · out ${fmtInt(u.u.output_tokens)})</span>` : ''}</span>
          ${boundary ? `<span class="k">compaction</span><span>${fmtInt(dropped?.preTokens)} → ${fmtInt(dropped?.postTokens)} tok (${esc(dropped?.trigger || '?')}) — earlier records live only in the summary</span>` : ''}
        </div>
        <div class="chiplist">${chipsHtml(counts, s)}</div>
      </div>
    </div>
    <div class="ctx-group">
      <div class="group-head eyebrow">message window — what follows the prompt head (System prompt · Tools · Skills · MCP tabs)</div>
      ${(s.sortDesc ? [...shown].reverse() : shown).map((r) => renderMsg(r, focusUuid, deltasOf(s.model), { orchestrator: !!s.agentFocus, durs: durationsOf(s.model) })).join('')}
    </div>`;
  const snapSelEl = document.getElementById('snapSel');
  if (snapSelEl) snapSelEl.addEventListener('change', (e) => { s.snapIdx = +e.target.value; select(s, s.sel, { keepSnap: true }); });
  const focusEl = panel.querySelector('.msg.focus');
  if (focusEl) settleIntoView(focusEl, { block: 'center' });
}

function renderMsg(r, focusUuid, deltas, opts = {}) {
  const kind = recKind(r);
  const focus = focusUuid && r.uuid === focusUuid;
  const dd = deltas?.get(r.uuid);
  const dms = opts.durs?.get(r.uuid);
  const durBadge = dms >= 1000 ? `<span class="dur-d" title="elapsed since the previous event">${esc(fmtDur(dms))}</span>` : '';
  const badge = durBadge + (dd
    ? `<span class="tok-d${dd.d < 0 ? ' neg' : ''}" title="window ${dd.d >= 0 ? 'grew' : 'shrank'} ${fmtInt(Math.abs(dd.d))} tokens at this record · ${fmtInt(dd.out)} generated">${dd.d >= 0 ? '+' : '−'}${fmtInt(Math.abs(dd.d))}</span>`
    : '');
  const cls = r.type === 'system' ? 'm-compact' : `m-${kind === 'tool' || kind === 'srvtool' ? 'tool' : r.type}`;
  const role = roleOf(r, kind, opts);
  const pids = rowPairIds(r);
  return `<div class="msg mrow ${cls}${focus ? ' focus' : ''}"${r.uuid ? ` data-uuid="${esc(r.uuid)}" data-src="${esc(opts.src || 'main')}"` : ''}${pids.length ? ` data-pairs="${esc(pids.join(' '))}"` : ''} tabindex="0" role="button"><span class="role">${esc(role)}</span><span class="prev">${esc(recPreview(r))}</span>${badge}</div>`;
}

/* Full content of a record, block by block — used by the preview pane's
   formatted view. Images render as images; Write/Edit tool calls render the
   file content being written rather than escaped JSON. */
function renderMsgBody(r, s) {
  const img = (src) => src?.data ? `<img class="pv-img" alt="" src="data:${esc(src.media_type || 'image/png')};base64,${src.data}">` : '';
  const fhLink = (filePath) => {
    const fh = s ? fhVersionFor(s, filePath, r.timestamp) : null;
    return fh ? `<div><button type="button" class="mini-btn fh-link" data-path="${esc(fh.path)}" data-version="${fh.version}" data-name="${esc(fh.name)}"${fh.prevName ? ` data-prev="${esc(fh.prevName)}"` : ''} style="margin-top:6px">view stored file @v${fh.version} (nearest by time) →</button></div>` : '';
  };
  const c = r.message?.content;
  if (typeof c === 'string') return `<pre class="block">${esc(c)}</pre>`;
  if (Array.isArray(c)) {
    return c.map((b) => {
      if (b.type === 'text') return `<div class="blk"><div class="blk-tag">text</div><pre class="block">${esc(b.text)}</pre></div>`;
      if (b.type === 'thinking') return `<div class="blk"><div class="blk-tag">thinking</div><pre class="block">${esc(b.thinking)}</pre></div>`;
      if (b.type === 'image') return `<div class="blk"><div class="blk-tag">image · ${esc(b.source?.media_type || '')}</div>${img(b.source)}</div>`;
      if (b.type === 'tool_use' && b.name === 'Write' && b.input?.content != null) {
        const body = /\.json[l5]?$/i.test(b.input.file_path || '') || isJsonText(b.input.content)
          ? jsonBlock(b.input.content) : codeBlock(b.input.content);
        return `<div class="blk"><div class="blk-tag">Write · ${esc(b.input.file_path || '')}</div>${body}${fhLink(b.input.file_path)}</div>`;
      }
      if (b.type === 'tool_use' && b.name === 'Edit' && b.input) {
        return `<div class="blk"><div class="blk-tag">Edit · ${esc(b.input.file_path || '')}</div>
          <div class="blk-tag">− old</div>${codeBlock(b.input.old_string ?? '')}
          <div class="blk-tag">+ new</div>${codeBlock(b.input.new_string ?? '')}${fhLink(b.input.file_path)}</div>`;
      }
      if (b.type === 'tool_use' && b.name === 'Bash' && b.input?.command) {
        return `<div class="blk"><div class="blk-tag">Bash${b.input.description ? ` · ${esc(b.input.description)}` : ''}${b.input.run_in_background ? ' · background' : ''}</div>${codeBlock(b.input.command)}</div>`;
      }
      if (b.type === 'tool_use') return `<div class="blk"><div class="blk-tag">tool_use · ${esc(b.name)}</div>${jsonBlock(b.input)}</div>`;
      if (b.type === 'server_tool_use') return `<div class="blk"><div class="blk-tag">server tool call · ${esc(b.name || '?')} (runs on Anthropic's side)</div>${jsonBlock(b.input ?? {})}</div>`;
      if (b.type === 'advisor_tool_result') {
        let inner = b.content;
        try { inner = typeof inner === 'string' ? JSON.parse(inner) : inner; } catch {}
        if (inner && inner.encrypted_content) {
          return `<div class="blk"><div class="blk-tag">advisor result · encrypted by the server</div>
            <p class="note">The advisor runs server-side; its reply is stored here as ciphertext so the session can be resumed (the API decrypts it for the model, never for the client). There is no local key — it is not decryptable from this machine. The advice's substance usually appears restated in the assistant's next thinking/text blocks.</p>
            <details class="msg"><summary><span class="role" style="color:var(--faint)">⛭</span><span class="prev">raw ciphertext (${fmtInt(String(inner.encrypted_content).length)} chars)</span></summary><div class="body"><pre class="block">${esc(String(inner.encrypted_content))}</pre></div></details></div>`;
        }
        return `<div class="blk"><div class="blk-tag">advisor result</div><pre class="block">${esc(typeof b.content === 'string' ? b.content : JSON.stringify(b.content, null, 2))}</pre></div>`;
      }
      if (b.type === 'tool_result') {
        const arr = Array.isArray(b.content) ? b.content : null;
        const inner = typeof b.content === 'string' ? b.content : arr ? arr.filter((x) => x.type !== 'image').map((x) => x.text ?? JSON.stringify(x)).join('\n') : JSON.stringify(b.content);
        const imgs = arr ? arr.filter((x) => x.type === 'image').map((x) => img(x.source)).join('') : '';
        const body = isJsonText(inner) ? jsonBlock(inner) : `<pre class="block">${esc(inner)}</pre>`;
        return `<div class="blk"><div class="blk-tag">tool_result${b.is_error ? ' · ERROR' : ''}</div>${body}${imgs}</div>`;
      }
      return `<div class="blk"><div class="blk-tag">${esc(b.type)}</div>${jsonBlock(b)}</div>`;
    }).join('');
  }
  if (r.type === 'attachment') return jsonBlock(r.attachment);
  return jsonBlock(r.content ?? r);
}

/* The third column: full-height preview of the activated record, with a
   formatted / raw toggle. */
function renderPreview(s) {
  const pane = document.getElementById('preview');
  if (!pane) return;
  const empty = `<div class="pv-empty hint">Click a row in the main view — or a record in the rail, or the tape — to preview it here.</div>`;
  const pv = s.preview;
  if (!pv) { pane.innerHTML = empty; return; }
  if (pv.kind && pv.kind !== 'record') return renderItemPreview(s, pane, pv);
  const model = pv.src === 'main' ? s.model : s.agents?.find((a) => a.id === pv.src)?.model;
  const r = model?.byUuid.get(pv.uuid);
  if (!r) { pane.innerHTML = empty; return; }
  const kind = recKind(r);
  const idx = pv.src === 'main' ? s.model.idxOf.get(r.uuid) : model.content.indexOf(r);
  const dd = deltasOf(model).get(r.uuid);
  pane.innerHTML = `
    <div class="pv-head">
      <span class="eyebrow" style="color:${KIND_COLORS[kind] || 'var(--muted)'}">${esc(r.isCompactSummary ? 'compact summary' : (pv.src !== 'main' || s.agentFocus) && kind === 'user' ? 'orchestrator' : KIND_LABELS[kind] || r.type)}</span>
      <span class="readout">#${idx != null && idx >= 0 ? idx + 1 : '?'}${pv.src !== 'main' ? ' · agent' : ''} · ${esc(fmtTime(r.timestamp))}${(() => { const ms = durationsOf(model).get(r.uuid); return ms >= 1000 ? ` · took ${esc(fmtDur(ms))}` : ''; })()}${dd ? ` · <b>${dd.d >= 0 ? '+' : '−'}${fmtInt(Math.abs(dd.d))} tok</b>` : ''}</span>
      <span class="pv-toggle">
        ${(() => {
          const pairs = pairsOf(model);
          const links = [];
          let ci = 0, ri = 0;
          for (const id of rowPairIds(r)) {
            const pr = pairs.get(id);
            if (!pr) continue;
            if (pr.call === r.uuid && pr.result && model.idxOf.has(pr.result)) links.push(`<button class="mini-btn pair-jump" data-target="${esc(pr.result)}" type="button">↳ result${rowPairIds(r).length > 1 ? ' ' + (++ci) : ''}</button>`);
            else if (pr.result === r.uuid && pr.call && model.idxOf.has(pr.call)) links.push(`<button class="mini-btn pair-jump" data-target="${esc(pr.call)}" type="button">↰ call${rowPairIds(r).length > 1 ? ' ' + (++ri) : ''}</button>`);
          }
          const names = toolNamesOf(r, model);
          for (const nm of names) links.push(`<button class="mini-btn def-jump" data-name="${esc(nm)}" type="button" title="view definition of ${esc(nm)}">⚙ ${esc(names.length > 1 && nm.length > 18 ? nm.slice(0, 16) + '…' : nm)}</button>`);
          return links.join('');
        })()}
        <button class="mini-btn${pv.mode !== 'raw' ? ' on' : ''}" data-m="fmt" type="button">formatted</button>
        <button class="mini-btn${pv.mode === 'raw' ? ' on' : ''}" data-m="raw" type="button">raw</button>
      </span>
    </div>
    <div class="pv-body">${pv.mode === 'raw' ? jsonBlock(r) : (renderMsgBody(r, s) || '<p class="hint">No content blocks in this record.</p>')}</div>`;
  pane.querySelectorAll('.pv-toggle .mini-btn').forEach((b) =>
    b.addEventListener('click', () => { pv.mode = b.dataset.m; renderPreview(s); }));
  initJsonBlocks(pane);
}

/* Non-record previews: system-prompt sections, tool definitions, rules files,
   raw JSON dumps, and companion files. */
function renderItemPreview(s, pane, pv) {
  const toggles = (raw) => `<span class="pv-toggle">
      <button class="mini-btn${!raw ? ' on' : ''}" data-m="fmt" type="button">formatted</button>
      <button class="mini-btn${raw ? ' on' : ''}" data-m="raw" type="button">raw</button>
    </span>`;
  const head = (title, sub, tog = '') => `<div class="pv-head">
      <span class="eyebrow" style="color:${pv.color || 'var(--accent)'}">${esc(pv.badge || pv.kind)}</span>
      <span class="readout">${esc(title)}${sub ? ` · ${esc(sub)}` : ''}</span>${tog}</div>`;
  const wireToggle = () => pane.querySelectorAll('.pv-toggle .mini-btn').forEach((b) =>
    b.addEventListener('click', () => { pv.mode = b.dataset.m; renderPreview(s); }));

  if (pv.kind === 'text') {
    pane.innerHTML = head(pv.title, pv.sub) + `<div class="pv-body"><pre class="block">${esc(pv.content)}</pre></div>`;
  } else if (pv.kind === 'tool') {
    const t = pv.tool, raw = pv.mode === 'raw';
    pane.innerHTML = head(t.name, pv.sub, toggles(raw)) + `<div class="pv-body">${raw
      ? `<div class="cm-tall">${jsonBlock(t)}</div>`
      : `<pre class="block">${esc(t.description || '')}</pre><div class="blk-tag" style="margin-top:8px">parameter schema</div>${jsonBlock(t.schema ?? t.parameters ?? {})}`}</div>`;
    wireToggle();
  } else if (pv.kind === 'json') {
    pane.innerHTML = head(pv.title, pv.sub) + `<div class="pv-body">${jsonBlock(pv.value)}</div>`;
  } else if (pv.kind === 'histfile') {
    const vurl = (n) => API.fhVersion(s.id, n);
    const render = () => {
      const raw = pv.mode === 'raw';
      const body = raw || pv._prev == null
        ? codeBlock(pv._cur)
        : diffHtml(pv._prev, pv._cur);
      pane.innerHTML = head(`${pv.path} @v${pv.version}`, pv._prev != null ? 'diff vs previous version' : 'first stored version — full content', pv._prev != null ? toggles(raw) : '') +
        `<div class="pv-body">${body}</div>`;
      wireToggle();
      initJsonBlocks(pane);
    };
    if (pv._cur != null) { render(); return; }
    pane.innerHTML = head(`${pv.path} @v${pv.version}`, 'loading…');
    Promise.all([
      fetch(vurl(pv.name)).then((r) => (r.ok ? r.text() : Promise.reject())),
      pv.prevName ? fetch(vurl(pv.prevName)).then((r) => (r.ok ? r.text() : null)).catch(() => null) : Promise.resolve(null),
    ]).then(([cur, prev]) => {
      if (s.preview !== pv) return;
      pv._cur = cur; pv._prev = prev;
      render();
    }).catch(() => {
      if (s.preview !== pv) return;
      pane.innerHTML = head(`${pv.path} @v${pv.version}`, 'backup missing') +
        `<div class="pv-body"><p class="warn">The stored copy for this version isn't on disk. Per-session backups in ~/.claude/file-history can be cleaned up over time, and continuation segments record their edits under a different session id — the transcript's reference outlived the data.</p></div>`;
    });
    return;
  } else if (pv.kind === 'file') {
    const url = API.file(s.id, pv.path);
    const ext = (pv.path.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
      pane.innerHTML = head(pv.path, 'image') + `<div class="pv-body"><img class="pv-img" alt="" src="${url}"><a class="hint" href="${url}" target="_blank" rel="noopener">open raw ↗</a></div>`;
      return;
    }
    const render = (text) => {
      const raw = pv.mode === 'raw';
      const isJson = ext === 'json', isJsonl = ext === 'jsonl';
      let sub = `${fmtInt(text.length)} chars`, bodyHtml;
      if (isJsonl && !raw) {
        // formatted JSONL: each line is a record, rendered like everywhere else —
        // strings unescaped, real whitespace, images as images
        const lines = text.split('\n').filter((l) => l.trim());
        const CAP = 400;
        bodyHtml = lines.slice(0, CAP).map((l, i) => {
          try {
            const rec = JSON.parse(l);
            const label = rec.type ? `${rec.type}${rec.subtype ? ' · ' + rec.subtype : ''}` : 'json';
            const inner = rec.message || rec.attachment ? renderMsgBody(rec, s) : jsonBlock(rec);
            return `<div class="jsonl-rec"><div class="blk-tag">line ${i + 1} · ${esc(label)}${rec.timestamp ? ' · ' + esc(fmtTime(rec.timestamp)) : ''}</div>${inner}</div>`;
          } catch {
            return `<div class="jsonl-rec"><div class="blk-tag">line ${i + 1} · unparseable</div><pre class="block">${esc(l)}</pre></div>`;
          }
        }).join('') + (lines.length > CAP ? `<p class="warn">Showing the first ${CAP} of ${lines.length} lines — use raw mode or "open raw" for the rest.</p>` : '');
        sub = `${lines.length} records`;
      } else if (isJson && !raw) {
        bodyHtml = jsonBlock(text);
      } else {
        const big = text.length > 2_000_000;
        const shown = big ? text.slice(0, 2_000_000) : text;
        bodyHtml = `${big ? '<p class="warn">Truncated to 2 MB for display — use "open raw" for the full file.</p>' : ''}${codeBlock(shown)}`;
      }
      pane.innerHTML = head(pv.path, sub, isJson || isJsonl ? toggles(raw) : '') +
        `<div class="pv-body">${bodyHtml}<div style="padding:8px 0"><a class="hint" href="${url}" target="_blank" rel="noopener">open raw ↗</a></div></div>`;
      wireToggle();
      initJsonBlocks(pane);
    };
    if (pv._text != null) { render(pv._text); return; }
    pane.innerHTML = head(pv.path, 'loading…');
    fetch(url).then((r) => r.text()).then((text) => {
      if (s.preview !== pv) return; // user moved on while loading
      pv._text = text;
      render(text);
    }).catch(() => { if (s.preview === pv) pane.innerHTML = head(pv.path, 'failed to load'); });
    return;
  } else {
    pane.innerHTML = head(pv.title || '?', '');
  }
  initJsonBlocks(pane);
}

function renderSnapshotTab(s, panel) {
  if (!s.snapshots.length) {
    panel.innerHTML = layer('Snapshots', 'none', '<p class="hint">Run /snapshot inside the live session to capture the in-context material.</p>', true);
    return;
  }
  if (s.snapIdx < 0 || s.snapIdx >= s.snapshots.length) s.snapIdx = s.snapshots.length - 1;

  // Selector strip: one compact chip per snapshot; only the selected one renders below.
  const strip = `<div class="snap-strip">${s.snapshots.map((sn, i) => {
    const d = sn.data;
    return `<button class="snap-chip${i === s.snapIdx ? ' on' : ''}" data-i="${i}" type="button">
      <span class="snap-chip-name">Snapshot ${i + 1}</span>
      <span class="snap-chip-time">${esc(fmtTime(d.exportedAt))}</span>
      <span class="snap-chip-meta">${(d.systemPrompt || []).length} sections · ${(d.tools || []).length} tools · ${(d.rules || []).length} rules</span>
    </button>`;
  }).join('')}</div>`;

  const sn = s.snapshots[s.snapIdx];
  const d = sn.data;
  const sysSecs = d.systemPrompt || [];
  const tools = d.tools || [];
  const rules = d.rules || [];

  const body = [];
  body.push(layer(`Snapshot ${s.snapIdx + 1}`, esc(d.exportedAt || sn.name), `
    <div class="kv">
      <span class="k">model</span><span>${esc(d.model || '?')}</span>
      <span class="k">cli version</span><span>${esc(d.claudeCodeVersion || '?')}</span>
      <span class="k">anchored to</span><span>${esc(d.latestMessageUuid || '?')}</span>
      <span class="k">exported</span><span>${esc(fmtTime(d.exportedAt))}</span>
      ${d.notes ? `<span class="k">notes</span><span>${esc(d.notes)}</span>` : ''}
    </div>`, true));

  body.push(layer('System prompt — as transcribed', `${sysSecs.length} sections`,
    sysSecs.length
      ? sysSecs.map((sec) => pvRow(
          { kind: 'text', badge: 'system prompt section', color: 'var(--k-attach)', title: sec.title, sub: sec.provenance === 'library' ? 'from shared cache' : 'as transcribed', content: sec.content },
          { icon: '§', color: 'var(--k-attach)', label: sec.title, sub: sec.provenance === 'library' ? '⟲ cached' : '' })).join('')
      : '<p class="hint">No system-prompt sections in this snapshot.</p>'));

  if (tools.length) {
    body.push(layer('Tool definitions — as transcribed', `${tools.length} tools`,
      tools.map((t) => pvRow(
        { kind: 'tool', badge: 'tool definition', color: 'var(--k-tool)', tool: t, sub: t.provenance === 'library' ? 'from shared cache' : 'as transcribed' },
        { icon: '⚒', color: 'var(--k-tool)', label: `${t.name} — ${(t.description || '').slice(0, 80)}`, sub: t.provenance === 'library' ? '⟲ cached' : '' })).join('')));
  }
  if (rules.length) {
    body.push(layer('Rules & memory files', `${rules.length} files`,
      rules.map((f) => pvRow(
        { kind: 'text', badge: 'rules file', color: 'var(--k-user)', title: f.path, content: f.content },
        { icon: '✎', color: 'var(--k-user)', label: f.path })).join('')));
  }

  body.push(layer('Raw snapshot', '',
    pvRow({ kind: 'json', badge: 'snapshot', title: `Snapshot ${s.snapIdx + 1} — raw JSON`, sub: sn.name, value: d },
      { icon: '⛭', label: 'Raw snapshot JSON — click to preview' })));

  panel.innerHTML = strip + body.join('');
  panel.querySelectorAll('.snap-chip').forEach((chip) =>
    chip.addEventListener('click', () => { s.snapIdx = +chip.dataset.i; renderPanel(s); }));
}

/* Real file edits: file-history-snapshot records map each touched path to
   versioned backups whose actual contents live in ~/.claude/file-history. */
function fileHistory(s) {
  if (s._fh) return s._fh;
  const byPath = new Map();
  for (const r of s.model.records) {
    if (r.type !== 'file-history-snapshot' && r.type !== 'file-history-delta') continue;
    const tracked = r.snapshot?.trackedFileBackups || r.delta?.trackedFileBackups || {};
    for (const [pth, info] of Object.entries(tracked)) {
      if (!byPath.has(pth)) byPath.set(pth, new Map());
      byPath.get(pth).set(info.version, { version: info.version, backup: info.backupFileName, time: info.backupTime });
    }
  }
  const out = [...byPath.entries()].map(([pth, vers]) => ({
    path: pth,
    versions: [...vers.values()].sort((a, b) => a.version - b.version),
  })).sort((a, b) => a.path.localeCompare(b.path));
  s._fh = out;
  return out;
}

/* Correlate an Edit/Write tool call with the tracker's stored version of that
   file: match path by suffix (tool calls are absolute, tracker keys are
   cwd-relative), pick the stored backup nearest the call's timestamp. */
function fhVersionFor(s, absPath, ts) {
  if (!s?.fhFiles || !absPath) return null;
  const entry = fileHistory(s).find((f) => absPath === f.path || String(absPath).endsWith('/' + f.path));
  if (!entry) return null;
  const stored = entry.versions.filter((v) => v.backup && s.fhFiles.has(v.backup));
  if (!stored.length) return null;
  const t = ts ? Date.parse(ts) : null;
  let best = stored[0];
  if (t) for (const v of stored) {
    if (Math.abs(Date.parse(v.time) - t) < Math.abs(Date.parse(best.time) - t)) best = v;
  }
  const i = stored.indexOf(best);
  return { path: entry.path, version: best.version, name: best.backup, prevName: i > 0 ? stored[i - 1].backup : null };
}

/* Single-hunk diff: trim the common prefix and suffix lines, show what changed
   between them. An approximation (one contiguous region), honestly labeled. */
function diffHtml(prevText, curText) {
  const A = prevText.split('\n'), B = curText.split('\n');
  let i = 0;
  while (i < A.length && i < B.length && A[i] === B[i]) i++;
  let j = 0;
  while (j < A.length - i && j < B.length - i && A[A.length - 1 - j] === B[B.length - 1 - j]) j++;
  const del = A.slice(i, A.length - j), add = B.slice(i, B.length - j);
  if (!del.length && !add.length) return '<p class="hint">Versions are identical.</p>';
  const ctx = (ls) => ls.map((l) => `<span class="d-ctx">  ${esc(l)}</span>`).join('');
  return `<p class="note">single-hunk view: common prefix/suffix trimmed — interleaved changes show as one block</p><pre class="block d-wrap">${ctx(B.slice(Math.max(0, i - 3), i))}<span class="d-ctx">@@ line ${i + 1} · −${del.length} +${add.length} @@</span>${del.map((l) => `<span class="d-del">− ${esc(l)}</span>`).join('')}${add.map((l) => `<span class="d-add">+ ${esc(l)}</span>`).join('')}${ctx(B.slice(B.length - j, Math.min(B.length, B.length - j + 3)))}</pre>`;
}

function renderFilesTab(s, panel) {
  const files = s.manifest.files || [];
  const parts = [];
  const fhList = fileHistory(s);
  if (fhList.length) {
    const avail = s.fhFiles; // Set of backup names on disk, null = no dir for this session
    let missing = 0, rows = '';
    if (avail) {
      rows = fhList.map((f) => {
        const stored = f.versions.filter((v) => v.backup && avail.has(v.backup));
        missing += f.versions.filter((v) => v.backup && !avail.has(v.backup)).length;
        return stored.map((v, vi, arr) => pvRow(
          { kind: 'histfile', badge: 'file version', color: 'var(--k-assistant)', path: f.path, version: v.version, name: v.backup, prevName: vi > 0 ? arr[vi - 1].backup : null },
          { icon: 'Δ', color: 'var(--k-assistant)', label: `${f.path} @v${v.version}`, sub: fmtTime(v.time) })).join('');
      }).join('');
    }
    const note = avail === undefined
      ? '<p class="hint">Checking which backups exist on disk…</p>'
      : avail === null
      ? '<p class="warn">This session has no stored file-history directory — backups are per-session and may have been cleaned up, or the edits were recorded under a different session segment. The transcript still lists what was touched (below), but the actual contents are gone.</p>' +
        fhList.map((f) => `<div class="hint" style="font-family:var(--mono);font-size:12px;padding:1px 0">· ${esc(f.path)} (${f.versions.length} version${f.versions.length === 1 ? '' : 's'})</div>`).join('')
      : missing
      ? `<p class="hint">${missing} version reference${missing === 1 ? '' : 's'} have no stored copy on disk (never backed up, or cleaned up).</p>`
      : '';
    parts.push(layer('File edits — actual contents', `${fhList.length} files touched`,
      '<p class="note">Real file versions captured by the edit tracker (~/.claude/file-history), not the conversation\'s description of the edits.</p>' + note + rows, true));
  }
  if (files.length) {
    parts.push(layer('Companion files', `${files.length}`, files.map((f) =>
      pvRow({ kind: 'file', badge: 'companion file', color: 'var(--k-user)', path: f },
        { icon: '≡', color: 'var(--k-user)', label: f })).join(''), !fhList.length));
  }
  panel.innerHTML = parts.length ? parts.join('') :
    layer('Files', 'none', '<p class="hint">No file edits tracked and no companion files for this session.</p>', true);
}
