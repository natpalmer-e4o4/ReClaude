// Boots an isolated demo-seeded server on :7332, runs the DOM regression
// against it, and reliably tears down — child ownership in-process instead of
// shell job control, which go-task's interpreter doesn't honor.
import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'));
const srv = spawn(process.execPath, ['server/server.js'], {
  env: { ...process.env, DEMO_SEED: '1', DATA_DIR: tmp, PORT: '7332', HOST_PROJECTS: '', FILE_HISTORY: '' },
  stdio: 'ignore',
});
let code = 1;
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { up = (await fetch('http://127.0.0.1:7332/api/health')).ok; } catch {}
    if (!up) await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) throw new Error('isolated test server failed to start on :7332 (port in use?)');
  code = spawnSync(process.execPath, ['scripts/dom-test.mjs'], {
    env: { ...process.env, BASE: 'http://127.0.0.1:7332' },
    stdio: 'inherit',
  }).status ?? 1;
} catch (e) {
  console.error(String(e.message || e));
} finally {
  srv.kill();
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(code);
