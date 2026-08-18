import fs from 'fs';
import { JSDOM } from 'jsdom';

const BASE = process.env.BASE || 'http://127.0.0.1:7331';

const ROOT = new URL('..', import.meta.url).pathname;
const html = fs.readFileSync(ROOT + 'server/public/index.html', 'utf8');
const appjs = fs.readFileSync(ROOT + 'server/public/app.js', 'utf8');

const sessions = await (await fetch(`${BASE}/api/sessions`)).json();
const target = process.env.SESSION || (sessions.find((s) => s.snapshotCount > 0) || sessions[0])?.sessionId;
if (!target) { console.error('no sessions available to test against'); process.exit(1); }
console.log('testing against session:', target);
const dom = new JSDOM(html, { url: `${BASE}/#/s/${target}`, runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
window.fetch = (u, o) => fetch(new URL(u, BASE), o); // resolve relative URLs against the container
// canvas 2d mock: every method a no-op, every prop settable
const ctx = new Proxy({}, { get: (t, p) => (typeof p === 'string' ? () => {} : undefined), set: () => true });
window.HTMLCanvasElement.prototype.getContext = () => ctx;
window.requestAnimationFrame = (f) => setTimeout(f, 0);

const errors = [];
window.addEventListener('error', (e) => errors.push(e.message));
try { window.eval(appjs); } catch (e) { errors.push('eval: ' + e.message); }
await new Promise((r) => setTimeout(r, 3000));

const doc = window.document;
const sessionMode = doc.body.classList.contains('session-mode');
const report = {
  title: doc.title,
  tabs: [...doc.querySelectorAll('#tabs button')].map((b) => b.textContent),
  railRows: doc.querySelectorAll('.rec').length,
  layers: [...doc.querySelectorAll('.layer summary .eyebrow')].map((e) => e.textContent), userRows: doc.querySelectorAll('#panel .mrow').length,
  readout: doc.getElementById('readout')?.textContent,
  sysSections: doc.querySelectorAll('.layer details.msg').length,
  sessionMode,
  errors,
};
console.log(JSON.stringify(report, null, 2));
if (!report.railRows) console.log('VIEW HTML:', doc.getElementById('view').innerHTML.slice(0, 400));
if (errors.length || !report.railRows || !report.userRows) { console.error('DOM TEST FAILED'); process.exit(1); }
console.log('DOM RENDER OK');
// also render home view
window.location.hash = '#/';
window.dispatchEvent(new window.Event('hashchange'));
await new Promise((r) => setTimeout(r, 1500));
console.log('home cards:', doc.querySelectorAll('.session-card').length, 'errors:', errors.length);
console.log('session-mode after home:', doc.body.classList.contains('session-mode'));
