const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');

const baseUrl = (process.env.PORTAL_BASE_URL || '').replace(/\/$/, '');
const email = process.env.PORTAL_TEST_EMAIL;
const password = process.env.PORTAL_TEST_PASSWORD;
const chromeBin = process.env.CHROME_BIN || '/usr/bin/google-chrome';
const resultPath = process.env.RESULT_PATH || '';
const validationModel = process.env.PORTAL_VALIDATION_MODEL || 'codex/gpt-5.5';
if (!baseUrl) throw new Error('PORTAL_BASE_URL is required');
if (!email || !password) throw new Error('PORTAL_TEST_EMAIL and PORTAL_TEST_PASSWORD are required');

const runId = `RAIL-${Date.now()}`;
const sessionKey = `agent:main:rail-${Date.now()}`;
const preMarker = `RAIL_PRE_${runId}`;
const postMarker = `RAIL_POST_${runId}`;
const finalMarker = `RAIL_FINAL_${runId}`;
const toolMarker = `RAIL_TOOL_${runId}`;
const port = 15600 + Math.floor(Math.random() * 500);
const profile = `/tmp/portal-agent-chat-rail-${Date.now()}`;
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
function countMarker(text, marker) {
  if (!text || !marker) return 0;
  return String(text).split(marker).length - 1;
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
    const consoleEvents = [];
    const frames = [];
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
        if (payload.includes(runId) || payload.includes('turnEvent') || payload.includes('tool_')) {
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
    await cdp('Log.enable');

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
    async function waitForComposer() {
      for (let i = 0; i < 180; i++) {
        const ready = await ev(`Boolean(document.querySelector('textarea') && document.body.innerText.includes('Agent'))`);
        if (ready) return true;
        await wait(500);
      }
      return false;
    }
    const composerReady = await waitForComposer();

    const prompt = [
      'Live UI regression test. Follow exactly.',
      `Before using any tool, write a normal reply message (not internal thinking/reasoning) that includes exactly ${preMarker}.`,
      `Then use a harmless command/tool that prints exactly ${toolMarker}.`,
      `After that tool returns, write a normal reply message (not internal thinking/reasoning) that includes exactly ${postMarker}.`,
      `Do not include ${preMarker}, ${postMarker}, or ${toolMarker} in the final answer.`,
      `Final answer must be exactly ${finalMarker}.`,
    ].join('\\n');

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
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { ok: true, hasPrompt: document.body.innerText.includes(${JSON.stringify(preMarker)}) };
    })()`, true);

    const markerDiagnosticsSource = String(function markerDiagnostics(markers) {
      function markerHits(marker) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const hits = [];
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!node.nodeValue || !node.nodeValue.includes(marker)) continue;
          let el = node.parentElement;
          let depth = 0;
          let rail = false;
          let userBubble = false;
          let collapsedToolPill = false;
          let thinkingBubble = false;
          const chain = [];
          while (el && depth < 8) {
            const cls = String(el.className || '');
            chain.push({ tag: el.tagName, cls, text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 220) });
            if (cls.includes('border-t') && cls.includes('justify-center') && cls.includes('gap-2.5')) rail = true;
            if (cls.includes('animate-user-in') || cls.includes('bg-blue-600')) userBubble = true;
            if (el.tagName === 'BUTTON' && cls.includes('rounded-full') && cls.includes('text-slate-400')) collapsedToolPill = true;
            if (cls.includes('border-violet-400/15') && cls.includes('bg-violet-500/[0.08]')) thinkingBubble = true;
            el = el.parentElement;
            depth++;
          }
          if (!userBubble) hits.push({ rail, collapsedToolPill, thinkingBubble, chain });
        }
        return hits;
      }
      const text = document.body.innerText;
      return {
        t: Date.now(),
        textTail: text.slice(-5000),
        markers: Object.fromEntries(markers.map((marker) => [marker, {
          count: markerHits(marker).length,
          railHits: markerHits(marker),
        }])),
        visibleToolResult: markerHits(markers[3]).some((hit) => !hit.collapsedToolPill && !hit.thinkingBubble),
        visibleStatusText: [...document.querySelectorAll('div')]
          .map((el) => ({ cls: String(el.className || ''), text: (el.textContent || '').replace(/\\s+/g, ' ').trim() }))
          .filter((entry) => entry.cls.includes('border-t') && entry.cls.includes('justify-center') && entry.cls.includes('gap-2.5'))
          .map((entry) => entry.text)
          .slice(-5),
      };
    });

    async function sample(label) {
      return ev(`(() => {
        const result = (${markerDiagnosticsSource})([${[preMarker, postMarker, finalMarker, toolMarker].map(JSON.stringify).join(',')}]);
        result.label = ${JSON.stringify(label)};
        return result;
      })()`);
    }

    const samples = [];
    // Thinking models legitimately quote the marker strings inside their
    // visible thought bubble, so timing and duplicate checks must count only
    // hits rendered outside thinking bubbles.
    const answerCount = (sampleObj, marker) => (
      ((sampleObj.markers[marker] || {}).railHits || []).filter((hit) => !hit.thinkingBubble).length
    );
    let firstPreAt = null;
    let firstPostAt = null;
    let firstFinalAt = null;
    let railLeak = false;
    let duplicateMarker = false;
    let prematureToolResult = false;
    // Models do not reliably obey the interim-message instructions, so the
    // gate verifies persistence of what actually appeared live rather than
    // failing on disobedience; peak counts record what appeared.
    const liveAnswerPeak = { pre: 0, post: 0, final: 0 };
    const trackPeaks = (sampleObj) => {
      liveAnswerPeak.pre = Math.max(liveAnswerPeak.pre, answerCount(sampleObj, preMarker));
      liveAnswerPeak.post = Math.max(liveAnswerPeak.post, answerCount(sampleObj, postMarker));
      liveAnswerPeak.final = Math.max(liveAnswerPeak.final, answerCount(sampleObj, finalMarker));
    };
    for (let i = 0; i < 600; i++) {
      await wait(400);
      const current = await sample('poll');
      samples.push(current);
      trackPeaks(current);
      if (!firstPreAt && answerCount(current, preMarker) > 0) firstPreAt = current.t;
      if (!firstPostAt && answerCount(current, postMarker) > 0) firstPostAt = current.t;
      if (!firstFinalAt && answerCount(current, finalMarker) > 0) firstFinalAt = current.t;
      railLeak = railLeak || [preMarker, postMarker, finalMarker, toolMarker].some((marker) => (
        current.markers[marker].railHits.some((hit) => hit.rail)
      ));
      duplicateMarker = duplicateMarker || [preMarker, postMarker, finalMarker].some((marker) => answerCount(current, marker) > 1);
      if (!firstFinalAt && current.visibleToolResult) prematureToolResult = true;
      if (firstFinalAt) break;
    }
    await wait(2500);
    const finalSample = await sample('final');
    trackPeaks(finalSample);
    railLeak = railLeak || [preMarker, postMarker, finalMarker, toolMarker].some((marker) => (
      finalSample.markers[marker].railHits.some((hit) => hit.rail)
    ));
    duplicateMarker = duplicateMarker || [preMarker, postMarker, finalMarker].some((marker) => answerCount(finalSample, marker) > 1);

    const response = await ev(`(async () => {
      const r = await fetch('/api/gateway/stream-status?provider=OPENCLAW&session=${encodeURIComponent(sessionKey)}', { credentials: 'include' });
      return { ok: r.ok, status: r.status, json: await r.json().catch((e) => ({ error: String(e) })) };
    })()`, true);
    const history = await ev(`(async () => {
      const r = await fetch('/api/gateway/history?provider=OPENCLAW&enhanced=1&limit=100&session=${encodeURIComponent(sessionKey)}', { credentials: 'include' });
      return { ok: r.ok, status: r.status, json: await r.json().catch((e) => ({ error: String(e) })) };
    })()`, true);
    const assistantHistory = JSON.stringify((Array.isArray(history?.json?.messages) ? history.json.messages : [])
      .filter((message) => String(message?.role || '').toLowerCase() === 'assistant'));
    const historyChecks = {
      ok: Boolean(history?.ok),
      status: history?.status || 0,
      messageCount: Array.isArray(history?.json?.messages) ? history.json.messages.length : null,
      assistantMarkerCounts: {
        pre: countMarker(assistantHistory, preMarker),
        post: countMarker(assistantHistory, postMarker),
        final: countMarker(assistantHistory, finalMarker),
        tool: countMarker(assistantHistory, toolMarker),
      },
    };

    await cdp('Page.reload', { ignoreCache: true });
    let reloadSample = null;
    for (let i = 0; i < 120; i++) {
      await wait(500);
      reloadSample = await sample('reload');
      const reloadedPre = answerCount(reloadSample, preMarker);
      const reloadedPost = answerCount(reloadSample, postMarker);
      const reloadedFinal = answerCount(reloadSample, finalMarker);
      if (reloadedPre === 1 && reloadedPost === 1 && reloadedFinal === 1) break;
    }
    reloadSample = reloadSample || await sample('reload');
    await wait(2000);
    const stableReloadSample = await sample('reload-stable');
    for (const reloaded of [reloadSample, stableReloadSample]) {
      railLeak = railLeak || [preMarker, postMarker, finalMarker, toolMarker].some((marker) => (
        reloaded.markers[marker].railHits.some((hit) => hit.rail)
      ));
      duplicateMarker = duplicateMarker || [preMarker, postMarker, finalMarker].some((marker) => answerCount(reloaded, marker) > 1);
    }

    const compliance = {
      preVisible: liveAnswerPeak.pre > 0,
      postVisible: liveAnswerPeak.post > 0,
      finalVisible: liveAnswerPeak.final > 0,
    };
    // A marker that appeared live must still render exactly once at turn end
    // and after both reloads; a marker the model never wrote is untestable.
    const persisted = (marker, peak, historyCount) => (
      peak === 0
      || (
        answerCount(finalSample, marker) === 1
        && answerCount(reloadSample, marker) === 1
        && answerCount(stableReloadSample, marker) === 1
        && historyCount >= 1
      )
    );
    const ok = Boolean(
      setup.login.ok
      && composerReady
      && sent.ok
      && firstFinalAt
      && (!firstPreAt || firstPreAt < firstFinalAt)
      // POST and FINAL legitimately land inside the same 400ms poll window.
      && (!firstPostAt || firstPostAt <= firstFinalAt)
      && historyChecks.ok
      && historyChecks.assistantMarkerCounts.final >= 1
      && persisted(preMarker, liveAnswerPeak.pre, historyChecks.assistantMarkerCounts.pre)
      && persisted(postMarker, liveAnswerPeak.post, historyChecks.assistantMarkerCounts.post)
      && answerCount(finalSample, finalMarker) === 1
      && answerCount(reloadSample, finalMarker) === 1
      && answerCount(stableReloadSample, finalMarker) === 1
      && !reloadSample.visibleToolResult
      && !stableReloadSample.visibleToolResult
      && !railLeak
      && !duplicateMarker
      && !prematureToolResult
    );
    const result = {
      ok,
      baseUrl,
      sessionKey,
      runId,
      setup,
      composerReady,
      sent,
      timing: { firstPreAt, firstPostAt, firstFinalAt },
      compliance,
      liveAnswerPeak,
      checks: { railLeak, duplicateMarker, prematureToolResult },
      finalStatus: response,
      historyChecks,
      finalSample,
      reloadSample,
      stableReloadSample,
      samples: samples.slice(-20),
      frames: frames.slice(-40),
      consoleEvents: consoleEvents.slice(-50),
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
