const baseUrl = (process.env.PORTAL_BASE_URL || '').replace(/\/$/, '');
const email = process.env.PORTAL_TEST_EMAIL;
const password = process.env.PORTAL_TEST_PASSWORD;
const path = process.env.PORTAL_WS_PATH || '/api/gateway/ws';
if (!baseUrl) throw new Error('PORTAL_BASE_URL is required');
if (!email || !password) throw new Error('PORTAL_TEST_EMAIL and PORTAL_TEST_PASSWORD are required');

function requireWs() {
  try { return require('ws'); } catch {}
  try { return require('/opt/bridgesllm/portal/backend/node_modules/ws'); } catch {}
  return require(require('path').resolve(__dirname, '../../backend/node_modules/ws'));
}

function cookiePartsFromHeaders(headers) {
  const raw = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : String(headers.get('set-cookie') || '').split(/,(?=\s*[^;,]+=)/);
  return raw
    .map((cookie) => String(cookie || '').split(';')[0].trim())
    .filter(Boolean);
}

function summarizeCookie(cookie) {
  const [name, value = ''] = String(cookie).split('=');
  return { name, valueLen: value.length };
}

(async () => {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const cookies = cookiePartsFromHeaders(login.headers);
  const cookieHeader = cookies.join('; ');
  if (!login.ok) {
    console.log(JSON.stringify({ ok: false, phase: 'login', status: login.status }, null, 2));
    process.exit(2);
  }
  const WebSocket = requireWs();
  const wsUrl = `${baseUrl.replace(/^http/, 'ws')}${path}`;
  const startedAt = Date.now();
  const result = {
    ok: false,
    phase: 'connect',
    wsUrl,
    loginStatus: login.status,
    cookies: cookies.map(summarizeCookie),
    opened: false,
    firstMessageType: null,
    close: null,
    error: null,
    elapsedMs: null,
  };
  const ws = new WebSocket(wsUrl, {
    headers: {
      Cookie: cookieHeader,
      Origin: baseUrl,
    },
  });
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => {
      result.phase = 'timeout';
      try { ws.close(); } catch {}
      resolve();
    }, 8000);
    ws.on('open', () => {
      result.opened = true;
    });
    ws.on('message', (data) => {
      try {
        result.firstMessageType = JSON.parse(String(data)).type || null;
      } catch {
        result.firstMessageType = 'non-json';
      }
      result.ok = result.opened && result.firstMessageType === 'connected';
      result.phase = 'message';
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve();
    });
    ws.on('close', (code, reason) => {
      result.close = { code, reason: String(reason || '') };
      if (result.opened && result.firstMessageType === 'connected') result.ok = true;
      if (!result.ok && result.phase === 'connect') result.phase = 'close';
      clearTimeout(timer);
      resolve();
    });
    ws.on('error', (err) => {
      result.error = err?.message || String(err);
    });
  });
  await done;
  result.elapsedMs = Date.now() - startedAt;
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 2);
})();
