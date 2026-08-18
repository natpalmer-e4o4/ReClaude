// probe 2: hover engagement, sticky-head timing, 404 identity, idle rAF budget
const PORT = process.env.CDP_PORT || 9333;
const BASE = process.env.BASE || 'http://127.0.0.1:7341';
import fs from 'node:fs';
const OUT = process.env.OUT || '/tmp/states';

let ws, id = 0; const pending = new Map(); const events = [];
const send = (method, params = {}) => new Promise((res, rej) => {
  const m = ++id; pending.set(m, { res, rej });
  ws.send(JSON.stringify({ id: m, method, params }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, x) => { ws.onopen = r; ws.onerror = x; });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  else if (m.method) events.push(m);
};
const evalJs = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};
const shot = async (n) => fs.writeFileSync(`${OUT}/${n}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
const sess = await (await fetch(`${BASE}/api/sessions`)).json();
const s0 = (sess.sessions || sess)[0];
await send('Page.navigate', { url: `${BASE}/#/s/${s0.sessionId || s0.id}` });
for (let i = 0; i < 80; i++) { if ((await evalJs(`document.querySelectorAll('.rec').length`).catch(() => 0)) > 3) break; await sleep(250); }
await sleep(1500);

const out = {};
out.failedRequests = events.filter((e) => e.method === 'Network.loadingFailed' || (e.method === 'Network.responseReceived' && e.params.response.status >= 400))
  .map((e) => e.params.response ? `${e.params.response.status} ${e.params.response.url}` : `FAIL ${e.params.errorText}`);

// --- hover engagement
const b = await evalJs(`(() => { const el = document.querySelectorAll('.rec')[4]; const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()`);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none', buttons: 0, pointerType: 'mouse' });
await sleep(400);
out.hoverChain = await evalJs(`[...document.querySelectorAll(':hover')].map(e => e.className || e.tagName).slice(-4)`);
out.dotTransform = await evalJs(`getComputedStyle(document.querySelectorAll('.rec')[4].querySelector('.dot')).transform`);
out.recBg = await evalJs(`getComputedStyle(document.querySelectorAll('.rec')[4]).backgroundColor`);
await shot('10-hover-retry');

// --- sticky head, measured after a frame
await evalJs(`document.querySelector('.ctx-panel').scrollTop = 0`);
await sleep(300);
out.stuckAtTop = await evalJs(`document.querySelector('.ctx-panel').classList.contains('stuck')`);
out.headShadowAtTop = await evalJs(`getComputedStyle(document.querySelector('.ctx-panel .panel-head')).boxShadow`);
await shot('11-head-at-top');
await evalJs(`document.querySelector('.ctx-panel').scrollTop = 500`);
await sleep(300);
out.stuckScrolled = await evalJs(`document.querySelector('.ctx-panel').classList.contains('stuck')`);
out.headShadowScrolled = await evalJs(`getComputedStyle(document.querySelector('.ctx-panel .panel-head')).boxShadow`);
await shot('12-head-scrolled');

// rail sticky
await evalJs(`document.getElementById('rail').scrollTop = 300`);
await sleep(300);
out.railScrolled = await evalJs(`document.getElementById('railBox').classList.contains('scrolled')`);

// --- idle rAF budget: after all interaction settles, is anything still looping?
await evalJs(`window.__rafCount = 0; (() => { const o = requestAnimationFrame;
  window.requestAnimationFrame = function (cb) { window.__rafCount++; return o.call(window, cb); }; })()`);
// provoke a selection glide, then wait well past its 150ms life
const rb = await evalJs(`(() => { const el = document.querySelectorAll('.rec')[9]; const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()`);
for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: rb.x, y: rb.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
await sleep(1200);
out.rafDuringAndAfterClick = await evalJs(`window.__rafCount`);
await evalJs(`window.__rafCount = 0`);
await sleep(1500);
out.rafWhileIdle = await evalJs(`window.__rafCount`); // must be 0: nothing left looping

console.log(JSON.stringify(out, null, 2));
ws.close(); process.exit(0);
