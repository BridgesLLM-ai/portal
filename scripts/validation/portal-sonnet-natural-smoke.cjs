const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');

const baseUrl = (process.env.PORTAL_BASE_URL || '').replace(/\/$/, '');
const email = process.env.PORTAL_TEST_EMAIL;
const password = process.env.PORTAL_TEST_PASSWORD;
const chromeBin = process.env.CHROME_BIN || '/usr/bin/google-chrome';
const validationModel = process.env.PORTAL_VALIDATION_MODEL || 'anthropic/claude-sonnet-4-6';
const resultPath = process.env.RESULT_PATH || '';

if (!baseUrl) throw new Error('PORTAL_BASE_URL is required');
if (!email || !password) throw new Error('PORTAL_TEST_EMAIL and PORTAL_TEST_PASSWORD are required');

const runId = `SONNET-${Date.now()}`;
const marker = `SONNET_SMOKE_${runId}`;
const sessionKey = `agent:main:sonnet-smoke-${Date.now()}`;
const port = 16100 + Math.floor(Math.random() * 500);
const profile = `/tmp/portal-sonnet-smoke-${Date.now()}`;

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
    for (let i = 0; i < 120; i += 1) {
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
    const frames = [];
    const consoleEvents = [];

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method === 'Runtime.consoleAPICalled') {
        consoleEvents.push(message.params.args?.map((arg) => arg.value || arg.description).join(' '));
      }
      if (message.method === 'Runtime.exceptionThrown') {
        consoleEvents.push(message.params.exceptionDetails?.text || 'exception');
      }
      if (message.method === 'Network.webSocketFrameReceived') {
        const payload = message.params.response?.payloadData || '';
        if (payload.includes(marker) || payload.includes('turnEvent')) {
          frames.push({ t: Date.now(), payload: payload.slice(0, 4000) });
        }
      }
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
    await cdp('Network.enable');

    await cdp('Page.navigate', { url: `${baseUrl}/` });
    await wait(1200);

    const setup = await ev(`(async () => {
      const login = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: ${JSON.stringify(email)}, password: ${JSON.stringify(password)} })
      }).then((r) => ({ ok: r.ok, status: r.status }));
      localStorage.setItem('agent-chat-provider', 'OPENCLAW');
      localStorage.setItem('agent-chat-session:OPENCLAW', ${JSON.stringify(sessionKey)});
      localStorage.setItem('agent-chat-session', ${JSON.stringify(sessionKey)});
      localStorage.setItem('agentChats.lastModel.OPENCLAW', ${JSON.stringify(validationModel)});
      localStorage.removeItem('agent-chat-agentId');
      return { login, model: ${JSON.stringify(validationModel)} };
    })()`, true);

    await cdp('Page.navigate', { url: `${baseUrl}/agent-chats` });
    for (let i = 0; i < 180; i += 1) {
      if (await ev(`Boolean(document.querySelector('textarea'))`)) break;
      await wait(500);
    }

    const prompt = `Please answer naturally in one short sentence and include this exact marker once: ${marker}`;
    const sent = await ev(`(async () => {
      const textarea = document.querySelector('textarea');
      if (!textarea) return { ok: false, reason: 'no textarea', body: document.body.innerText.slice(-1000) };
      const message = ${JSON.stringify(prompt)};
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, message);
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
      textarea.focus();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const form = textarea.closest('form');
      const button = form?.querySelector('button[type="submit"]');
      if (button && !button.disabled) button.click();
      else textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      return { ok: true };
    })()`, true);

    async function loadHistory() {
      return ev(`(async () => {
        const response = await fetch('/api/gateway/history?provider=OPENCLAW&enhanced=1&limit=100&session=${encodeURIComponent(sessionKey)}', { credentials: 'include' });
        return { ok: response.ok, status: response.status, json: await response.json().catch((error) => ({ error: String(error) })) };
      })()`, true);
    }

    let assistantHasMarker = false;
    let markerCount = 0;
    let history = null;
    for (let i = 0; i < 240; i += 1) {
      await wait(500);
      history = await loadHistory();
      const assistantHistory = JSON.stringify((history?.json?.messages || [])
        .filter((message) => String(message?.role || '').toLowerCase() === 'assistant'));
      assistantHasMarker = assistantHistory.includes(marker);
      markerCount = await ev(`((document.body.innerText.match(new RegExp(${JSON.stringify(marker)}, 'g')) || []).length)`);
      if (assistantHasMarker && markerCount >= 2) break;
    }

    await wait(1500);
    const status = await ev(`(async () => {
      const response = await fetch('/api/gateway/stream-status?provider=OPENCLAW&session=${encodeURIComponent(sessionKey)}', { credentials: 'include' });
      return { ok: response.ok, status: response.status, json: await response.json().catch((error) => ({ error: String(error) })) };
    })()`, true);

    await cdp('Page.reload', { ignoreCache: true });
    let reloadCount = 0;
    for (let i = 0; i < 90; i += 1) {
      await wait(500);
      reloadCount = await ev(`((document.body.innerText.match(new RegExp(${JSON.stringify(marker)}, 'g')) || []).length)`);
      if (reloadCount >= 2) break;
    }

    const frameTypes = [];
    for (const frame of frames) {
      try {
        const parsed = JSON.parse(frame.payload);
        if (parsed.turnEvent?.type) frameTypes.push(parsed.turnEvent.type);
      } catch {}
    }
    const finalTextTail = await ev('document.body.innerText.slice(-3000)');
    const ok = Boolean(
      setup.login.ok
      && sent.ok
      && assistantHasMarker
      && markerCount >= 2
      && reloadCount >= 2
      && frameTypes.includes('assistant_delta')
      && frameTypes.includes('assistant_final')
      && status.ok
      && status.json?.active === false
      && consoleEvents.length === 0
    );

    const result = {
      ok,
      baseUrl,
      sessionKey,
      model: validationModel,
      marker,
      setup,
      sent,
      assistantHasMarker,
      markerCount,
      reloadCount,
      status,
      frameTypes: [...new Set(frameTypes)],
      historyStatus: {
        ok: history?.ok,
        status: history?.status,
        messageCount: Array.isArray(history?.json?.messages) ? history.json.messages.length : null,
      },
      finalTextTail,
      consoleEvents,
    };
    const output = JSON.stringify(result, null, 2);
    if (resultPath) fs.writeFileSync(resultPath, `${output}\n`);
    console.log(output);
    process.exit(ok ? 0 : 2);
  } finally {
    try { ws?.close(); } catch {}
    cleanup();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  cleanup();
  process.exit(1);
});
