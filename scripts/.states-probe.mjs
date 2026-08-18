// throwaway taste/a11y probe: drives a real Chrome over CDP so :hover / :active /
// :focus-visible actually engage, then screenshots each state.
const PORT = process.env.CDP_PORT || 9333;
const BASE = process.env.BASE || 'http://127.0.0.1:7341';
const OUT = process.env.OUT || '/tmp/states';
import fs from 'node:fs';

const j = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();

let ws, id = 0;
const pending = new Map();
const events = [];
function send(method, params = {}, sessionId) {
  const m = ++id;
  return new Promise((res, rej) => {
    pending.set(m, { res, rej });
    ws.send(JSON.stringify({ id: m, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await j('/json/list');
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r, x) => { ws.onopen = r; ws.onerror = x; });
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.id && pending.has(msg.id)) {
            const p = pending.get(msg.id); pending.delete(msg.id);
            msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
          } else if (msg.method) events.push(msg);
        };
        return;
      }
    } catch {}
    await sleep(250);
  }
  throw new Error('no CDP page target');
}

const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception?.description || ''));
  return r.result.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
};
const mouse = (type, x, y, extra = {}) =>
  send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : (type === 'mousePressed' || type === 'mouseMoved' && extra.held ? 1 : 0), clickCount: type === 'mouseMoved' ? 0 : 1, ...extra });

const results = {};

await connect();
await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
fs.mkdirSync(OUT, { recursive: true });

// find a session
const sess = await (await fetch(`${BASE}/api/sessions`)).json();
const sid = (sess.sessions || sess)[0].id;
await send('Page.navigate', { url: `${BASE}/#/s/${sid}` });

for (let i = 0; i < 80; i++) {
  const n = await evalJs(`document.querySelectorAll('.rec').length`).catch(() => 0);
  if (n > 3) break;
  await sleep(250);
}
await sleep(1200);

results.consoleErrors = events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error').map((e) => e.params.entry.text);

// --- 1. resting
await shot('01-rest');

// --- 2. hover a rail row (dot scale + row wash) and a compact row if present
const box = async (sel, nth = 0) => evalJs(`(() => {
  const el = document.querySelectorAll(${JSON.stringify(sel)})[${nth}];
  if (!el) return null; const r = el.getBoundingClientRect();
  return { x: r.left + Math.min(60, r.width/2), y: r.top + r.height/2, w: r.width, h: r.height };
})()`);

const rec = await box('.rec', 4);
if (rec) { await mouse('mouseMoved', rec.x, rec.y); await sleep(300); await shot('02-rec-hover'); }
results.dotTransform = await evalJs(`(() => { const d = document.querySelectorAll('.rec')[4]?.querySelector('.dot');
  return d ? getComputedStyle(d).transform : null; })()`);

// --- 3. :active on a main row
const mrow = await box('.msg.mrow', 2);
if (mrow) {
  await mouse('mouseMoved', mrow.x, mrow.y);
  await mouse('mousePressed', mrow.x, mrow.y);
  await sleep(250);
  await shot('03-mrow-active');
  await mouse('mouseReleased', mrow.x, mrow.y);
  await sleep(400);
}

// --- 4. keyboard focus-visible on chrome + on a row
await evalJs(`document.getElementById('zoomOut')?.focus()`);
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
await sleep(300);
await shot('04-focus-visible');
results.focusEl = await evalJs(`(() => { const a = document.activeElement; return a ? a.className + '|' + a.tagName + '|' + (a.matches(':focus-visible')) : null; })()`);

// --- 5. plain click on the tape: must not strand body.dragging
const tape = await evalJs(`(() => { const c = document.getElementById('tape'); const r = c.getBoundingClientRect();
  return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.4 }; })()`);
await mouse('mouseMoved', tape.x, tape.y);
await mouse('mousePressed', tape.x, tape.y);
results.draggingDuringPlainPress = await evalJs(`document.body.classList.contains('dragging')`);
await mouse('mouseReleased', tape.x, tape.y);
await sleep(400);
results.draggingAfterPlainClick = await evalJs(`document.body.classList.contains('dragging')`);
await shot('05-after-tape-click');

// --- 6. real zoom drag: caliper jaws + latched cursor
await mouse('mousePressed', tape.x - 260, tape.y);
for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', tape.x - 260 + i * 30, tape.y, { held: true, buttons: 1 }); await sleep(30); }
results.draggingDuringRealDrag = await evalJs(`document.body.classList.contains('dragging')`);
await sleep(200);
await shot('06-caliper-drag');
await mouse('mouseReleased', tape.x - 20, tape.y);
await sleep(500);
results.draggingAfterRealDrag = await evalJs(`document.body.classList.contains('dragging')`);
await shot('07-after-zoom');

// --- 7. sticky head: shadow only once scrolled
results.stuckAtTop = await evalJs(`(() => { const p = document.querySelector('.ctx-panel'); p.scrollTop = 0; return p.classList.contains('stuck'); })()`);
await sleep(200);
await evalJs(`document.querySelector('.ctx-panel').scrollTop = 400`);
await sleep(300);
results.stuckScrolled = await evalJs(`document.querySelector('.ctx-panel').classList.contains('stuck')`);
await shot('08-sticky-scrolled');

// --- 8. readout selectability (the .tape-wrap user-select fix)
results.readoutUserSelect = await evalJs(`getComputedStyle(document.getElementById('readout')).userSelect`);

// --- 9. leftover rAF / timers after everything settles
results.glideRaf = await evalJs(`(() => { const s = window.state?.session; return s ? { raf: s._glideRaf || 0, glideFrame: !!s._glideFrame, selDraw: s.selDraw } : 'no state'; })()`);

// --- 10. reduced motion pass
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await sleep(200);
const rec2 = await box('.rec', 8);
if (rec2) {
  await mouse('mouseMoved', rec2.x, rec2.y);
  await sleep(200);
  // click it to force a select() -> glideSel path under reduced motion
  await mouse('mousePressed', rec2.x, rec2.y);
  await mouse('mouseReleased', rec2.x, rec2.y);
  await sleep(120);
  results.rmGlideRafImmediately = await evalJs(`(() => { const s = window.state?.session; return { raf: s?._glideRaf || 0, selDraw: s?.selDraw ?? null }; })()`);
}
results.rmArrivedRows = await evalJs(`document.querySelectorAll('.arrived').length`);
await shot('09-reduced-motion');
results.consoleErrorsFinal = events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error').map((e) => e.params.entry.text);
results.exceptions = events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails.text);

console.log(JSON.stringify(results, null, 2));
ws.close();
process.exit(0);
