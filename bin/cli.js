#!/usr/bin/env node
/* ReClaude CLI. Thin wrapper: every flag maps onto an environment variable the
   server already reads, so `npx reclaude` and `node server/server.js` behave
   identically. Cross-platform by construction — no shell, no POSIX-only calls. */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const HELP = `reclaude ${pkg.version} — a flight recorder for the Claude Code context window

Usage
  reclaude [options]              start the viewer (default)
  reclaude install-skill          install the /snapshot skill into ~/.claude/skills
  reclaude where                  print the paths in use
  reclaude --help | --version

Options
  -p, --port <n>        port to listen on (default 7331)
      --host <addr>     bind address (default 127.0.0.1)
      --data-dir <dir>  where imported sessions are stored
      --demo            serve the bundled redacted demo session (in memory only)
      --no-projects     do not auto-discover sessions from ~/.claude/projects
      --no-open         do not open a browser on start
`;

const argv = process.argv.slice(2);
const flag = (...names) => names.some((n) => argv.includes(n));
const value = (...names) => {
  for (const n of names) {
    const i = argv.indexOf(n);
    if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('-')) return argv[i + 1];
  }
  return null;
};

const cmd = argv.find((a) => !a.startsWith('-')) || 'serve';

if (flag('-h', '--help')) { process.stdout.write(HELP); process.exit(0); }
if (flag('-v', '--version')) { process.stdout.write(pkg.version + '\n'); process.exit(0); }

const claudeDir = path.join(os.homedir(), '.claude');

if (cmd === 'install-skill') {
  const src = path.join(ROOT, 'skills', 'snapshot');
  const dest = path.join(claudeDir, 'skills', 'snapshot');
  if (!fs.existsSync(src)) { console.error(`no skills/snapshot directory in ${ROOT}`); process.exit(1); }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log(`installed the /snapshot skill to ${dest}`);
  console.log('run /snapshot inside a Claude Code session to capture its context');
  process.exit(0);
}

if (cmd === 'where') {
  console.log(`package      ${ROOT}`);
  console.log(`claude data  ${claudeDir}${fs.existsSync(claudeDir) ? '' : '  (not found)'}`);
  console.log(`skill        ${path.join(claudeDir, 'skills', 'snapshot')}`);
  process.exit(0);
}

if (cmd !== 'serve') { console.error(`unknown command: ${cmd}\n`); process.stdout.write(HELP); process.exit(1); }

const env = { ...process.env };
const port = value('-p', '--port');
if (port) env.PORT = port;
const host = value('--host');
if (host) env.HOST = host;
const dataDir = value('--data-dir');
if (dataDir) env.DATA_DIR = path.resolve(dataDir);
if (flag('--demo')) env.DEMO_SEED = '1';
if (flag('--no-projects')) { env.HOST_PROJECTS = ''; env.FILE_HISTORY = ''; }

process.env = env;
if (!flag('--no-open')) {
  const url = `http://${env.HOST || '127.0.0.1'}:${env.PORT || 7331}/`;
  setTimeout(() => {
    const { spawn } = require('child_process');
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
    try { spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref(); } catch {}
  }, 600);
}
require(path.join(ROOT, 'server', 'server.js'));
