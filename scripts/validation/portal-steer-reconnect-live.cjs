/**
 * portal-steer-reconnect-live.cjs — reproduces the "lost stream reports a false
 * steering interruption" bug: reload the Agent Chat page in the middle of a
 * long tool call and assert the portal re-attaches to the live turn instead of
 * declaring it interrupted (and that the final answer then arrives without a
 * manual refresh).
 *
 * Env: PORTAL_BASE_URL, PORTAL_TEST_EMAIL, PORTAL_TEST_PASSWORD,
 *      PORTAL_VALIDATION_MODEL (default anthropic/claude-sonnet-4-6),
 *      RESULT_PATH, CHROME_BIN.
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');

const baseUrl = (process.env.PORTAL_BASE_URL || '').replace(/\/$/, '');
const email = process.env.PORTAL_TEST_EMAIL;
const password = process.env.PORTAL_TEST_PASSWORD;
const chromeBin = process.env.CHROME_BIN || '/usr/bin/google-chrome';
const resultPath = process.env.RESULT_PATH || '';
const validationModel = process.env.PORTAL_VALIDATION_MODEL || 'anthropic/claude-sonnet-4-6';
if (!baseUrl) throw new Error('PORTAL_BASE_URL is required');
if (!email || !password) throw new Error('PORTAL_TEST_EMAIL and PORTAL_TEST_PASSWORD are required');

const runId = `STEERRC-${Date.now()}`;
const sessionKey = `agent:main:steerrc-${Date.now()}`;
const toolMarker = `TOOLDONE_${runId}`;
const finalMarker = `STEER_OK_${runId}`;
const port = 16200 + Math.floor(Math.random() * 500);
const profile = `/tmp/portal-steer-reconnect-${Date.now()}`;
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
      return { login };
    })()`, true);

    await cdp('Page.navigate', { url: `${baseUrl}/agent-chats` });
    async function waitForComposer() {
      for (let i = 0; i < 180; i++) {
        const ready = await ev(`Boolean(document.querySelector('textarea') && document.body.innerText.includes('Agent'))`);
        if (ready) return true;
        await wait(500);
      }
      return false;
    }
    const composerReady = await waitForComposer();

    // Foreground `sleep N && …` is blocked by the Claude Code harness guard;
    // the until-loop form is the wait pattern that guard itself endorses.
    // PORTAL_QUIET_TOOL_SECONDS > 180 also regression-tests the OpenClaw
    // claude-cli no-output watchdog fix (default 180s kill on resumed runs).
    const quietToolSeconds = Math.max(30, Number.parseInt(process.env.PORTAL_QUIET_TOOL_SECONDS || '76', 10) || 76);
    const loopIterations = Math.ceil(quietToolSeconds / 2);
    const prompt = [
      'Live reconnect regression test. Follow exactly.',
      `Use your command/exec tool to run exactly this single command: i=0; until [ "$i" -ge ${loopIterations} ]; do sleep 2; i=$((i+1)); done; echo ${toolMarker}`,
      'Do not shorten the loop and do not run anything else first.',
      `After that tool returns, the final answer must be exactly ${finalMarker}.`,
    ].join('\\n');

    const sent = await ev(`(async () => {
      const textarea = document.querySelector('textarea');
      if (!textarea) return { ok: false, reason: 'no textarea' };
      const message = ${JSON.stringify(prompt)};
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, message);
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
      textarea.focus();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const form = textarea.closest('form');
      if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); return { ok: true, via: 'form' }; }
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return { ok: true, via: 'enter' };
    })()`, true);

    const streamStatus = () => ev(`(async () => {
      const r = await fetch('/api/gateway/stream-status?provider=OPENCLAW&session=${encodeURIComponent(sessionKey)}', { credentials: 'include' });
      return { ok: r.ok, json: await r.json().catch(() => null) };
    })()`, true);

    // Wait for the tool to actually start (the send round-trips first).
    let toolStartedAt = null;
    for (let i = 0; i < 90; i++) {
      await wait(1000);
      const status = await streamStatus();
      if (status?.json?.active && (status.json.phase === 'tool' || (status.json.toolCalls || []).length > 0)) {
        toolStartedAt = Date.now();
        break;
      }
    }

    // Mid-tool status must be active.
    await wait(10_000);
    const midTurnStatus = await streamStatus();

    // Mid-turn reconnect: reload the page while the tool is still sleeping.
    await cdp('Page.reload', { ignoreCache: true });
    await wait(9_000);
    const afterReload = await ev(`(() => {
      const text = document.body.innerText;
      return {
        hasSteeringMarker: text.includes('interrupted by steering message'),
        hasDetachedMarker: text.includes('live view detached'),
        bodyTail: text.slice(-1200),
      };
    })()`);
    const reloadStatus = await streamStatus();

    // The final answer must arrive WITHOUT another reload (live re-attach or
    // post-turn history sync must deliver it).
    let finalSeenAt = null;
    for (let i = 0; i < 200; i++) {
      await wait(1500);
      const seen = await ev(`document.body.innerText.includes(${JSON.stringify(finalMarker)})`);
      if (seen) { finalSeenAt = Date.now(); break; }
    }
    const finalDom = await ev(`(() => {
      const text = document.body.innerText;
      return {
        hasSteeringMarker: text.includes('interrupted by steering message'),
        hasDetachedMarker: text.includes('live view detached'),
        hasFinal: text.includes(${JSON.stringify(finalMarker)}),
      };
    })()`);

    // Stream must settle to inactive after the turn.
    let settledInactive = false;
    for (let i = 0; i < 30; i++) {
      const status = await streamStatus();
      if (status?.json && status.json.active === false) { settledInactive = true; break; }
      await wait(2000);
    }

    const ok = Boolean(
      setup.login.ok
      && composerReady
      && sent.ok
      && toolStartedAt
      && midTurnStatus?.json?.active === true
      && reloadStatus?.json?.active === true
      && !afterReload.hasSteeringMarker
      && !afterReload.hasDetachedMarker
      && finalSeenAt
      && finalDom.hasFinal
      && !finalDom.hasSteeringMarker
      && !finalDom.hasDetachedMarker
      && settledInactive
    );

    const result = {
      ok,
      baseUrl,
      sessionKey,
      runId,
      model: validationModel,
      setup,
      composerReady,
      sent,
      toolStartedAt,
      midTurnStatus: midTurnStatus?.json || null,
      reloadStatus: reloadStatus?.json || null,
      afterReload,
      finalSeenAt,
      finalDom,
      settledInactive,
    };
    const output = JSON.stringify(result, null, 2);
    if (resultPath) fs.writeFileSync(resultPath, `${output}\n`);
    console.log(output);
    process.exit(ok ? 0 : 2);
  } finally {
    try { ws?.close(); } catch {}
    cleanup();
  }
})();
