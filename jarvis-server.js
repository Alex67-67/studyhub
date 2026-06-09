'use strict';
const http       = require('http');
const fs         = require('fs');
const path       = require('path');
const { spawn, execSync } = require('child_process');

const PORT       = 3000;
const HOST       = '127.0.0.1';
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ─── FIND CLAUDE AT STARTUP ───────────────────────────────────────────────────
let CLAUDE;
try {
  CLAUDE = execSync('which claude', { encoding: 'utf8' }).trim();
  console.log(`  claude → ${CLAUDE}`);
} catch {
  CLAUDE = '/usr/local/bin/claude';
  console.log(`  which claude failed, using fallback: ${CLAUDE}`);
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function stripAnsi(s) {
  return s
    .replace(/\x1B\[[0-9;]*[mGKHJABCDFSTfnsurh]/g, '')
    .replace(/\x1B\[\?[0-9;]*[hl]/g, '')
    .replace(/\x1B[()][A-Z0-9]/g, '')
    .replace(/\r/g, '')
    .trim();
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ─── SERVER ───────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  cors(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET /jarvis — serve the dashboard (allows Chrome to remember mic permission)
  if (req.method === 'GET' && req.url === '/jarvis') {
    const filePath = path.join(__dirname, 'jarvis.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('jarvis.html not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // GET / — serve StudyHub
  if (req.method === 'GET' && req.url === '/') {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, 'utf8', (err, content) => {
      if (err) { res.writeHead(500); res.end('Error loading index.html'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    });
    return;
  }

  // GET /health
  if (req.method === 'GET' && req.url === '/health') {
    json(res, 200, { status: 'online', pid: process.pid, claude: CLAUDE });
    return;
  }

  // POST /command
  if (req.method === 'POST' && req.url === '/command') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {

      let command;
      try   { command = (JSON.parse(body).command || '').trim(); }
      catch { json(res, 400, { error: 'Invalid JSON' }); return; }

      if (!command) { json(res, 400, { error: 'Empty command' }); return; }

      console.log(`\n  ▶  ${command.slice(0, 100)}`);

      // ── LOCAL: app-open commands ──────────────────────────────────────────
      // APP_MAP: arrays tried in order; first successful open wins.
      // Special string values starting with 'url:' open a URL in Chrome instead.
      const APP_MAP = {
        // Microsoft Office
        'teams':       ['Teams', 'Microsoft Teams (work or school)', 'Microsoft Teams'],
        'outlook':     ['Microsoft Outlook'],
        'word':        ['Microsoft Word'],
        'powerpoint':  ['Microsoft PowerPoint'],
        'excel':       ['Microsoft Excel'],
        'onenote':     ['Microsoft OneNote'],
        // Browsers & system
        'chrome':      ['Google Chrome'],
        'safari':      ['Safari'],
        'finder':      ['Finder'],
        'terminal':    ['Terminal'],
        'vscode':      ['Visual Studio Code'],
        // Communication
        'spotify':     ['Spotify'],
        'discord':     ['Discord'],
        'whatsapp':    ['WhatsApp'],
        'telegram':    ['Telegram'],
        'facetime':    ['FaceTime'],
        // Apple apps
        'notes':       ['Notes'],
        'photos':      ['Photos'],
        'music':       ['Music'],
        'maps':        ['Maps'],
        // Games
        'steam':       ['Steam'],
        // Local URLs opened in Chrome
        'studyhub':    ['url:file:///Users/alexander/Desktop/Studenthub/index.html'],
        'jarvis':      ['url:http://localhost:3000/jarvis'],
      };

      // ── Website detection: "open [x.com]" or "go to [x]" ─────────────────
      const urlPattern = /(?:^open\s+|^go\s+to\s+)((?:https?:\/\/)?[\w.-]+\.[a-z]{2,}(?:\/\S*)?)/i;
      const urlMatch   = command.match(urlPattern);
      if (urlMatch) {
        let url = urlMatch[1];
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        console.log(`  → opening URL: ${url}`);
        execSync(`open -a "Google Chrome" "${url.replace(/"/g, '\\"')}"`, { stdio: 'ignore' });
        json(res, 200, { result: `Opening ${url} in Chrome.` });
        return;
      }

      const openMatch = command.match(/^open\s+(.+)$/i);
      if (openMatch) {
        const raw      = openMatch[1].trim().toLowerCase();
        const fallback = openMatch[1].trim().charAt(0).toUpperCase() + openMatch[1].trim().slice(1);
        const names    = APP_MAP[raw] || [fallback];
        let opened = null;
        for (const name of names) {
          try {
            if (name.startsWith('url:')) {
              // Open a local or remote URL in Chrome
              const url = name.slice(4);
              execSync(`open -a "Google Chrome" "${url}"`, { stdio: 'ignore' });
              opened = name.slice(4);
            } else {
              execSync(`open -a "${name.replace(/"/g, '\\"')}"`, { stdio: 'ignore' });
              opened = name;
            }
            break;
          } catch (e) { /* not found under this name — try next */ }
        }
        if (opened) {
          console.log(`  → opened: ${opened}`);
          json(res, 200, { result: `Opening ${opened}.` });
        } else {
          console.log(`  → not found: ${names.join(', ')}`);
          json(res, 200, { result: `Could not find "${names[0]}" on this Mac.` });
        }
        return;
      }

      // stdin:'ignore' is critical — without it, claude waits 3 s for stdin
      // before starting, and the req 'close' handler (removed) was killing it.
      const proc = spawn(CLAUDE, ['-p', command], {
        env:   { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let out = '';
      let err = '';
      let settled = false;

      function settle(result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        json(res, 200, { result: stripAnsi(result) });
      }

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        console.log('  ✗  timed out');
        settle('Request timed out after 5 minutes.');
      }, TIMEOUT_MS);

      proc.stdout.on('data', d => { out += d; process.stdout.write('.'); });
      proc.stderr.on('data', d => { err += d; });

      proc.on('close', (code, signal) => {
        console.log(`  done  exit=${code}  signal=${signal}`);
        if (err.trim()) console.log(`  stderr: ${err.slice(0, 300).trim()}`);

        if (out.trim()) {
          settle(out);
        } else if (err.trim()) {
          // stderr sometimes contains a real error message worth showing
          settle(`Error: ${err.trim()}`);
        } else {
          settle(
            `No output (exit=${code} signal=${signal}).\n` +
            `Run this in your terminal to check:\n  claude -p "hello"`
          );
        }
      });

      proc.on('error', e => {
        console.error(`  spawn error: ${e.message}`);
        const msg = e.code === 'ENOENT'
          ? `claude not found at: ${CLAUDE}\nInstall with: npm i -g @anthropic-ai/claude-code`
          : `Spawn error: ${e.message}`;
        settle(msg);
      });

      // NOTE: do NOT attach req.on('close') to kill the proc.
      // req 'close' fires when the HTTP request is fully received (not when
      // the browser disconnects), which would kill claude immediately.
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE')
    console.error(`\n  ✗  Port ${PORT} in use — already running?\n`);
  else
    console.error(`\n  ✗  ${e.message}\n`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║      J A R V I S   O N L I N E       ║');
  console.log(`  ║      http://localhost:${PORT}              ║`);
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
  console.log('  Waiting for commands...');
});
