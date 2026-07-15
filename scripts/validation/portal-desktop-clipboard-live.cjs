/**
 * portal-desktop-clipboard-live.cjs — browser-level test of the Remote Desktop
 * clipboard buttons: seeds the browser clipboard, clicks "Send clipboard",
 * verifies the text landed on the desktop's X clipboard; then seeds the
 * desktop clipboard via the API, clicks "Get clipboard", and verifies the
 * browser clipboard received it. Toast feedback asserted both ways.
 *
 * Env: PORTAL_BASE_URL, PORTAL_TEST_EMAIL, PORTAL_TEST_PASSWORD, RESULT_PATH, CHROME_BIN.
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');

const baseUrl = (process.env.PORTAL_BASE_URL || '').replace(/\/$/, '');
const email = process.env.PORTAL_TEST_EMAIL;
const password = process.env.PORTAL_TEST_PASSWORD;
const chromeBin = process.env.CHROME_BIN || '/usr/bin/google-chrome';
const resultPath = process.env.RESULT_PATH || '';
if (!baseUrl) throw new Error('PORTAL_BASE_URL is required');
if (!email || !password) throw new Error('PORTAL_TEST_EMAIL and PORTAL_TEST_PASSWORD are required');

const runId = `CLIPUI-${Date.now()}`;
const sendMarker = `SEND_${runId}`;
const fetchMarker = `FETCH_${runId}`;
const port = 16800 + Math.floor(Math.random() * 500);
const profile = `/tmp/portal-desktop-clipboard-${Date.now()}`;
fs.rmSync(profile, { recursive: true, force: true });
fs.mkdirSync(profile, { recursive: true });

const chrome = spawn(chromeBin, [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--window-size=1500,1100',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'], detached: true });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function cleanup() {
  try { process.kill(-chrome.pid, 'SIGTERM'); } catch {}
  try { execFileSync('bash', ['-lc', `pkill -TERM -f -- '--user-data-dir=${profile.replace(/'/g, "'\\''")}' || true`]); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });
function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

(async () => {
  let ws;
  try {
    let page;
    for (let i = 0; i < 120; i++) {
      try {
        page = JSON.parse(await get('/json/list')).find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
        if (page) break;
      } catch {}
      await wait(100);
    }
    if (!page) throw new Error('no chrome page');

    ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && pending.has(message.id)) {
        const callbacks = pending.get(message.id);
        pending.delete(message.id);
        message.error ? callbacks.reject(new Error(JSON.stringify(message.error))) : callbacks.resolve(message.result);
      }
    });
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const cdp = (method, params = {}) => {
      const callId = ++id;
      ws.send(JSON.stringify({ id: callId, method, params }));
      return new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
    };
    const ev = async (expression, awaitPromise = false) => (
      await cdp('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
    ).result?.value;

    await cdp('Page.enable');
    await cdp('Runtime.enable');
    await cdp('Browser.grantPermissions', {
      origin: baseUrl,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    });

    await cdp('Page.navigate', { url: `${baseUrl}/` });
    await wait(1500);
    const login = await ev(`(async () => {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: ${JSON.stringify(email)}, password: ${JSON.stringify(password)} })
      });
      return { ok: r.ok, status: r.status };
    })()`, true);

    await cdp('Page.navigate', { url: `${baseUrl}/desktop` });
    let buttonsReady = false;
    for (let i = 0; i < 60; i++) {
      await wait(500);
      buttonsReady = await ev(`Boolean(document.querySelector('button[title^="Send your computer"]') && document.querySelector('button[title^="Copy whatever"]'))`);
      if (buttonsReady) break;
    }

    // Async clipboard APIs require a focused document even with permissions
    // granted (headless included).
    await cdp('Page.bringToFront');
    await ev('window.focus(); document.body && document.body.focus && document.body.focus(); true');

    // Browser → desktop
    const seeded = await ev(`(async () => {
      try { await navigator.clipboard.writeText(${JSON.stringify(sendMarker)}); return true; } catch (e) { return String(e); }
    })()`, true);
    await ev(`document.querySelector('button[title^="Send your computer"]').click()`);
    let sendToast = null;
    for (let i = 0; i < 20; i++) {
      await wait(400);
      sendToast = await ev(`(() => { const el = [...document.querySelectorAll('div')].find((d) => /Sent [0-9,]+ characters|Failed|blocked|empty/.test(d.textContent) && d.className.includes('rounded-xl') && d.className.includes('border')); return el ? el.textContent.trim().slice(0, 120) : null; })()`);
      if (sendToast) break;
    }
    const desktopClipboard = await ev(`(async () => {
      const r = await fetch('/api/remote-desktop/clipboard?selection=clipboard', { credentials: 'include' });
      const j = await r.json().catch(() => null);
      return j && j.text;
    })()`, true);

    // Desktop → browser
    await ev(`(async () => {
      await fetch('/api/remote-desktop/clipboard', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: ${JSON.stringify(fetchMarker)}, selection: 'both' })
      });
    })()`, true);
    await ev(`document.querySelector('button[title^="Copy whatever"]').click()`);
    let fetchToast = null;
    for (let i = 0; i < 20; i++) {
      await wait(400);
      fetchToast = await ev(`(() => { const el = [...document.querySelectorAll('div')].find((d) => /Copied [0-9,]+ characters|Failed|empty/.test(d.textContent) && d.className.includes('rounded-xl') && d.className.includes('border')); return el ? el.textContent.trim().slice(0, 120) : null; })()`);
      if (fetchToast) break;
    }
    const browserClipboard = await ev(`(async () => { try { return await navigator.clipboard.readText(); } catch (e) { return String(e); } })()`, true);

    const ok = Boolean(
      login.ok
      && buttonsReady
      && seeded === true
      && desktopClipboard === sendMarker
      && sendToast && /Sent/.test(sendToast)
      && browserClipboard === fetchMarker
      && fetchToast && /Copied/.test(fetchToast)
    );

    const result = { ok, login, buttonsReady, seeded, sendToast, desktopClipboard, expectedSend: sendMarker, fetchToast, browserClipboard, expectedFetch: fetchMarker };
    const output = JSON.stringify(result, null, 2);
    if (resultPath) fs.writeFileSync(resultPath, `${output}\n`);
    console.log(output);
    process.exit(ok ? 0 : 2);
  } finally {
    try { ws?.close(); } catch {}
    cleanup();
  }
})();
