'use strict';
const http       = require('http');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');
const { spawn, execSync } = require('child_process');

const PORT       = 3000;
const HOST       = '0.0.0.0'; // listen on all interfaces so an iPad on the same WiFi can connect
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// football-data.org API key — SERVER-SIDE ONLY. Never sent to the frontend;
// the dashboard reads the digested result from GET /worldcup instead.
// Key is loaded from an env var or a git-ignored ./secrets.js (never committed).
let FOOTBALL_KEY = process.env.FOOTBALL_KEY || '';
if (!FOOTBALL_KEY) {
  try { FOOTBALL_KEY = require('./secrets.js').FOOTBALL_KEY || ''; }
  catch (e) { console.warn('  ⚠  No football API key found (set FOOTBALL_KEY or create secrets.js)'); }
}

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

// ─── STUDYHUB BRIDGE ──────────────────────────────────────────────────────────
const BRIDGE_FILE = path.join(__dirname, 'studyhub-bridge.json');

function readBridge() {
  try { return JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8')); }
  catch { return { pending: [] }; }
}

function writeBridge(data) {
  fs.writeFileSync(BRIDGE_FILE, JSON.stringify(data, null, 2));
}

// ─── STUDYHUB DATA STORE + AUTO-BACKUP ────────────────────────────────────────
// The server is the source of truth for StudyHub data. The dashboard/app reads
// from GET /data and saves with POST /data.
const DATA_FILE   = path.join(__dirname, 'studyhub-data.json');
const BACKUP_DIR  = path.join(__dirname, 'backups');
const MAX_BACKUPS = 14;

// Ensure the data file and backups folder exist at startup.
if (!fs.existsSync(DATA_FILE))  fs.writeFileSync(DATA_FILE, '{}');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);

function readData() {
  try { return fs.readFileSync(DATA_FILE, 'utf8'); }
  catch { return '{}'; }
}

// On the first POST /data of each day, copy the current data file to
// backups/studyhub-YYYY-MM-DD.json before it gets overwritten.
function backupIfNeeded() {
  const today      = new Date().toISOString().slice(0, 10);
  const backupPath = path.join(BACKUP_DIR, `studyhub-${today}.json`);
  if (fs.existsSync(backupPath)) return; // already backed up today

  try { fs.copyFileSync(DATA_FILE, backupPath); }
  catch (e) { console.log(`  ⚠  backup failed: ${e.message}`); return; }
  console.log(`  💾  backup → studyhub-${today}.json`);

  // Prune to the 14 most recent backups.
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => /^studyhub-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort(); // ISO date names sort chronologically
  while (files.length > MAX_BACKUPS) {
    const old = files.shift();
    try { fs.unlinkSync(path.join(BACKUP_DIR, old)); console.log(`  🗑  pruned old backup ${old}`); }
    catch { /* ignore */ }
  }
}

// First non-internal IPv4 address — what an iPad on the same WiFi would use.
function localIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name]) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}

// ─── WORLD CUP (football-data.org, FIFA WC 2026) ──────────────────────────────
const WC_URL = 'https://api.football-data.org/v4/competitions/WC/matches';
const WC_TTL = 5 * 60 * 1000;          // cache 5 minutes (rate-limit safety)
let wcCache  = { ts: 0, data: null };

const zurichDate = utc => new Date(utc).toLocaleDateString('en-CA', { timeZone: 'Europe/Zurich' });          // YYYY-MM-DD
const zurichTime = utc => new Date(utc).toLocaleTimeString('en-GB', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit' });
const isSpain    = t => !!t && (t.tla === 'ESP' || /spain|españa/i.test(t.name || ''));
const teamTag    = t => (t && (t.tla || t.shortName || t.name)) || '?';
const teamName   = t => (t && (t.shortName || t.name || t.tla)) || 'TBD';

function buildWorldCup(matches) {
  const todayZ = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Zurich' });
  const nowMs  = Date.now();

  // Spain's next scheduled match (soonest in the future)
  let spainNext = null;
  const upcoming = matches
    .filter(m => isSpain(m.homeTeam) || isSpain(m.awayTeam))
    .filter(m => ['SCHEDULED', 'TIMED'].includes(m.status) && new Date(m.utcDate).getTime() >= nowMs)
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));
  if (upcoming.length) {
    const m = upcoming[0];
    const spainHome = isSpain(m.homeTeam);
    const opp = spainHome ? m.awayTeam : m.homeTeam;
    spainNext = {
      opponent:    teamName(opp),
      opponentTla: opp?.tla || '',
      spainHome,
      date:        zurichDate(m.utcDate),
      kickoff:     zurichTime(m.utcDate),
      utcDate:     m.utcDate,
    };
  }

  // Today's matches (by Europe/Zurich date)
  const today = matches
    .filter(m => zurichDate(m.utcDate) === todayZ)
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))
    .map(m => {
      const spain = isSpain(m.homeTeam) || isSpain(m.awayTeam);
      const opp   = spain ? (isSpain(m.homeTeam) ? m.awayTeam : m.homeTeam) : null;
      return {
        home:      teamTag(m.homeTeam),
        away:      teamTag(m.awayTeam),
        status:    m.status,
        scoreHome: m.score?.fullTime?.home ?? m.score?.halfTime?.home ?? null,
        scoreAway: m.score?.fullTime?.away ?? m.score?.halfTime?.away ?? null,
        kickoff:   zurichTime(m.utcDate),
        isSpain:   spain,
        opponent:  opp ? teamName(opp) : null,
        minute:    m.minute ?? null,
      };
    });

  return { spainNext, today, updated: nowMs };
}

async function fetchWorldCup() {
  if (wcCache.data && Date.now() - wcCache.ts < WC_TTL) return wcCache.data;
  try {
    const r = await fetch(WC_URL, {
      headers: { 'X-Auth-Token': FOOTBALL_KEY },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const data = buildWorldCup(Array.isArray(j.matches) ? j.matches : []);
    wcCache = { ts: Date.now(), data };
    return data;
  } catch (e) {
    if (wcCache.data) return wcCache.data;   // serve stale rather than nothing
    return { spainNext: null, today: [], updated: Date.now(), error: String(e.message || e) };
  }
}

// ─── BROWSER CONTROL & READING (Google Chrome via AppleScript) ────────────────
// No mouse/navigation — just open URLs/windows and read what's on the page.
function runOsa(lines) {
  const args = lines.map(l => '-e ' + JSON.stringify(l)).join(' ');
  return execSync(`osascript ${args}`, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

// Read the active tab: returns "title\nurl\n===PAGECONTENT===\n<visible text>".
// Needs Chrome → View → Developer → "Allow JavaScript from Apple Events".
function chromeReadActiveTab() {
  return runOsa([
    'tell application "Google Chrome"',
    '  if (count of windows) is 0 then return "NO_WINDOW"',
    '  set t to active tab of front window',
    '  set theTitle to title of t',
    '  set theURL to URL of t',
    '  set theText to execute t javascript "document.body.innerText"',
    '  return theTitle & linefeed & theURL & linefeed & "===PAGECONTENT===" & linefeed & theText',
    'end tell',
  ]);
}

// List every open tab across all windows as "title — url" lines.
function chromeListTabs() {
  return runOsa([
    'set output to ""',
    'tell application "Google Chrome"',
    '  if (count of windows) is 0 then return "NO_WINDOW"',
    '  repeat with w in windows',
    '    repeat with t in tabs of w',
    '      set output to output & (title of t) & " — " & (URL of t) & linefeed',
    '    end repeat',
    '  end repeat',
    'end tell',
    'return output',
  ]);
}

// Open a URL in a brand-new Chrome window.
function chromeOpenNewWindow(url) {
  return runOsa([
    'tell application "Google Chrome"',
    '  activate',
    '  make new window',
    `  set URL of active tab of front window to "${url.replace(/"/g, '\\"')}"`,
    'end tell',
  ]);
}

// ─── SERVER ───────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  cors(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET /jarvis — serve the dashboard (allows Chrome to remember mic permission)
  if (req.method === 'GET' && (req.url === '/jarvis' || req.url.startsWith('/jarvis?'))) {
    const filePath = path.join(__dirname, 'jarvis.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('jarvis.html not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // GET /worldcup-schedule — serve the full World Cup 2026 fixtures page
  if (req.method === 'GET' && (req.url === '/worldcup-schedule' || req.url.startsWith('/worldcup-schedule?'))) {
    const filePath = path.join(__dirname, 'worldcup.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('worldcup.html not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // GET /worldcup.json — serve the World Cup fixtures data
  if (req.method === 'GET' && req.url === '/worldcup.json') {
    const filePath = path.join(__dirname, 'worldcup.json');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('worldcup.json not found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
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

  // GET /data — return the full StudyHub data store
  if (req.method === 'GET' && req.url === '/data') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(readData());
    return;
  }

  // POST /data — overwrite the StudyHub data store (with daily auto-backup first)
  if (req.method === 'POST' && req.url === '/data') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); }
      catch { json(res, 400, { error: 'Invalid JSON' }); return; }

      backupIfNeeded(); // copies current file before overwrite, once per day
      try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(parsed, null, 2));
        json(res, 200, { success: true });
      } catch (e) {
        json(res, 500, { error: `Could not save data: ${e.message}` });
      }
    });
    return;
  }

  // GET /backups — list available backup files
  if (req.method === 'GET' && req.url === '/backups') {
    try {
      const backups = fs.readdirSync(BACKUP_DIR)
        .filter(f => /^studyhub-\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .sort()
        .reverse() // newest first
        .map(f => {
          const st = fs.statSync(path.join(BACKUP_DIR, f));
          return { file: f, date: f.slice(9, 19), size: st.size, modified: st.mtime };
        });
      json(res, 200, { count: backups.length, backups });
    } catch (e) {
      json(res, 500, { error: `Could not list backups: ${e.message}` });
    }
    return;
  }

  // GET /worldcup — digested FIFA WC 2026 data (key stays server-side, 5-min cache)
  if (req.method === 'GET' && req.url === '/worldcup') {
    fetchWorldCup()
      .then(data => json(res, 200, data))
      .catch(() => json(res, 200, { spainNext: null, today: [], error: 'failed' }));
    return;
  }

  // POST /upload — save an attached file (base64) into jarvis-uploads/, return its path
  if (req.method === 'POST' && req.url === '/upload') {
    console.log('  📎  upload request received from', req.socket.remoteAddress);
    const MAX_UPLOAD = 25 * 1024 * 1024; // base64 body limit (~18MB file)
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > MAX_UPLOAD) { json(res, 413, { error: 'File too large (max ~18MB)' }); req.destroy(); }
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const rawName = parsed.filename || parsed.name;
        const data    = parsed.data;
        if (!rawName || !data) { json(res, 400, { error: 'Need filename and data' }); return; }
        const uploadsDir = path.join(__dirname, 'jarvis-uploads');
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
        const safe = String(rawName).replace(/^.*[\\/]/, '').replace(/[^\w.\- ]/g, '_').slice(0, 120) || 'file';
        const filePath = path.join(uploadsDir, `${Date.now()}-${safe}`);
        fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
        console.log(`  📎  upload → ${path.basename(filePath)} (${fs.statSync(filePath).size} bytes)`);
        json(res, 200, { success: true, path: filePath });
      } catch {
        json(res, 400, { error: 'Invalid upload' });
      }
    });
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
        'studyhub':    ['url:http://localhost:3000'],
        'jarvis':      ['url:http://localhost:3000/jarvis'],
        'claude':      ['Claude'],
      };

      // ── LOCAL: open a URL in a NEW Chrome window ──────────────────────────
      // Must run before the generic "open <app>" handler below.
      const newWinMatch = command.match(
        /^(?:open\s+)?(?:in\s+a\s+)?new\s+(?:chrome\s+)?(?:window|tab)\s+(?:for\s+|with\s+|to\s+|at\s+)?(.+)$/i
      );
      if (newWinMatch) {
        let url = newWinMatch[1].trim().replace(/^(?:go\s+to|open)\s+/i, '');
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        console.log(`  → new Chrome window: ${url}`);
        try {
          chromeOpenNewWindow(url);
          json(res, 200, { result: `Opened a new Chrome window at ${url}.` });
        } catch (e) {
          json(res, 200, { result: `Couldn't open a new window: ${e.message}` });
        }
        return;
      }

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

      // ── LOCAL: list open browser tabs ─────────────────────────────────────
      if (/\btabs?\b/i.test(command) && /\b(open|list|show|what|which|my)\b/i.test(command)) {
        console.log('  → listing Chrome tabs');
        try {
          const tabs = chromeListTabs();
          if (tabs === 'NO_WINDOW') {
            json(res, 200, { result: 'No Chrome windows are open right now.' });
          } else {
            json(res, 200, { result: `Here are your open tabs:\n${tabs}` });
          }
        } catch (e) {
          json(res, 200, { result: `Couldn't read your tabs: ${e.message}` });
        }
        return;
      }

      // ── LOCAL: read / summarise the current website ───────────────────────
      const readPattern =
        /\b(read|summari[sz]e|what.?s on|what does (?:this|the)|tell me about)\b.*\b(page|website|site|browser|tab|article|screen|this)\b/i;
      if (readPattern.test(command)) {
        console.log('  → reading active Chrome tab');
        let extracted;
        try {
          extracted = chromeReadActiveTab();
        } catch (e) {
          const blocked = /JavaScript through AppleScript is turned off|not allowed|Apple Events|-1743/i.test(e.message);
          json(res, 200, {
            result: blocked
              ? 'I need permission to read the page. In Chrome, go to View → Developer → "Allow JavaScript from Apple Events", then ask me again.'
              : `Couldn't read the page: ${e.message}`,
          });
          return;
        }
        if (extracted === 'NO_WINDOW') {
          json(res, 200, { result: 'No Chrome window is open for me to read.' });
          return;
        }

        const titleLine = extracted.split('\n')[0] || '';
        const urlLine   = extracted.split('\n')[1] || '';
        const pageText  = (extracted.split('===PAGECONTENT===\n')[1] || '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();

        const summarise = /summari[sz]e|what.?s on|what does|tell me about/i.test(command);
        if (!summarise) {
          json(res, 200, {
            result: `${titleLine}\n${urlLine}\n\n${pageText.slice(0, 4000)}` +
              (pageText.length > 4000 ? '\n\n…(say "summarise this page" for the short version)' : ''),
          });
          return;
        }

        // Summarise via Claude, then speak it.
        const prompt =
          `Summarise this web page for a student in 3-4 short, spoken sentences. ` +
          `Be concise and plain.\n\nTitle: ${titleLine}\nURL: ${urlLine}\n\nContent:\n${pageText.slice(0, 12000)}`;
        const ps = spawn(CLAUDE, ['-p', prompt], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let outS = '', doneS = false;
        const tS = setTimeout(() => { ps.kill(); if (!doneS) { doneS = true; json(res, 200, { result: 'Timed out summarising the page.' }); } }, 60000);
        ps.stdout.on('data', d => { outS += d; });
        ps.on('close', () => {
          if (doneS) return; doneS = true; clearTimeout(tS);
          json(res, 200, { result: stripAnsi(outS) || 'I read the page but got no summary back.' });
        });
        ps.on('error', () => { if (!doneS) { doneS = true; json(res, 200, { result: 'Could not reach Claude to summarise the page.' }); } });
        return;
      }

      // ── LOCAL: StudyHub bridge — extract and store structured item ────────
      const bridgeKeywords = /\badd\b|\bexam\b|\btest\b|\bhomework\b|\btask\b|\bdue\b|\bremind\b/i;
      if (bridgeKeywords.test(command)) {
        const today = new Date().toISOString().slice(0, 10);
        const extractPrompt =
          `Today is ${today}. Extract structured data from this voice command: "${command}"\n\n` +
          `Respond with ONLY a JSON object, no markdown, no explanation:\n` +
          `{"type":"homework or exam","subject":"subject name or empty string","title":"task or topic title","due":"YYYY-MM-DD or empty string","priority":"high or medium or low","room":"room or empty string","time":"HH:MM or empty string"}\n\n` +
          `Use type "exam" for tests/exams/quizzes. Use type "homework" for everything else. ` +
          `Priority defaults to "medium". If no date is mentioned, leave "due" as empty string.`;

        const proc2 = spawn(CLAUDE, ['-p', extractPrompt], {
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out2 = '', settled2 = false;
        const t2 = setTimeout(() => {
          proc2.kill();
          if (!settled2) { settled2 = true; json(res, 200, { result: 'Sorry, timed out parsing that command.' }); }
        }, 30000);
        proc2.stdout.on('data', d => { out2 += d; });
        proc2.on('close', () => {
          if (settled2) return;
          settled2 = true;
          clearTimeout(t2);
          try {
            const clean = stripAnsi(out2).replace(/```json\n?|\n?```/g, '').trim();
            const item = JSON.parse(clean);
            const data = readBridge();
            data.pending.push(item);
            writeBridge(data);
            console.log(`  → bridge: added ${item.type} "${item.title}"`);
            json(res, 200, { result: `Done, added "${item.title}" to StudyHub.` });
          } catch {
            json(res, 200, { result: `Sorry, I couldn't parse that. Try: "add homework Maths chapter 5 due Friday"` });
          }
        });
        proc2.on('error', () => {
          if (!settled2) { settled2 = true; json(res, 200, { result: 'Could not reach Claude to parse that command.' }); }
        });
        return;
      }

      // If the command has an [Attached: name → path, ...] header, read the
      // files and inject their content so Claude can reason about them.
      let claudePrompt = command;
      const attachMatch = command.match(/^\[Attached: (.+?)\]\n([\s\S]*)$/);
      if (attachMatch) {
        const refs    = attachMatch[1].split(/, (?=\S+ → )/);
        const userCmd = attachMatch[2].trim() || 'Describe the attached file(s).';
        const blocks  = [];
        for (const ref of refs) {
          const arrow = ref.lastIndexOf(' → ');
          if (arrow === -1) continue;
          const label    = ref.slice(0, arrow).trim();
          const filePath = ref.slice(arrow + 3).trim();
          try {
            const content = fs.readFileSync(filePath, 'utf8');
            blocks.push(`--- FILE: ${label} ---\n${content}\n--- END FILE ---`);
          } catch {
            blocks.push(`--- FILE: ${label} --- (could not be read) ---`);
          }
        }
        claudePrompt = `${userCmd}\n\n${blocks.join('\n\n')}`;
        console.log(`  📎  injecting ${blocks.length} file(s) into prompt`);
      }

      // stdin:'ignore' is critical — without it, claude waits 3 s for stdin
      // before starting, and the req 'close' handler (removed) was killing it.
      const proc = spawn(CLAUDE, ['-p', claudePrompt], {
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

  // GET /studyhub-bridge — return pending items then clear
  if (req.method === 'GET' && req.url === '/studyhub-bridge') {
    const data = readBridge();
    writeBridge({ pending: [] });
    json(res, 200, data);
    return;
  }

  // POST /add-to-studyhub — append item to bridge
  if (req.method === 'POST' && req.url === '/add-to-studyhub') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const item = JSON.parse(body);
        const data = readBridge();
        data.pending.push(item);
        writeBridge(data);
        json(res, 200, { success: true, message: 'Added to StudyHub' });
      } catch {
        json(res, 400, { error: 'Invalid JSON' });
      }
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
  const ip = localIp();
  if (ip) console.log(`  iPad access: http://${ip}:${PORT}`);
  else    console.log('  iPad access: (no local network IP detected)');
  console.log('');
  console.log('  Waiting for commands...');
});
