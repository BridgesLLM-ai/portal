#!/usr/bin/env bash
# Shared browser for VNC Remote Desktop
# Always starts clean, pins device scale at 1, and matches the active VNC resolution.
set -euo pipefail

USER_URL="${1:-about:blank}"

# Never let root own or mutate the shared browser profile.
if [ "$(id -u)" = "0" ]; then
  if id bridgesrd >/dev/null 2>&1; then
    # Source canonical desktop env if available, fall back to inline exports
    ENV_FILE="/home/bridgesrd/.bridges-rd-env"
    if [ -f "$ENV_FILE" ]; then
      ENV_CMD=". $ENV_FILE;"
    else
      ENV_CMD="export DISPLAY=:1; export XDG_RUNTIME_DIR=/tmp/bridges-rd-runtime; export PULSE_SERVER=unix:/tmp/bridges-rd-runtime/pulse/native; export SDL_AUDIODRIVER=pulseaudio;"
    fi
    exec su - bridgesrd -c "${ENV_CMD} /usr/local/bin/bridges-rd-shared-chrome.sh $(printf '%q' "$USER_URL")"
  fi
  echo "ERROR: Must not run shared browser as root without bridgesrd user" >&2
  exit 1
fi

# Source canonical desktop env (written by VNC launcher / RD setup)
ENV_FILE="/home/bridgesrd/.bridges-rd-env"
if [ -f "$ENV_FILE" ]; then
  . "$ENV_FILE"
else
  # Fallback for older installs
  export DISPLAY="${DISPLAY:-:1}"
  export XDG_RUNTIME_DIR=/tmp/bridges-rd-runtime
  export PULSE_SERVER=unix:/tmp/bridges-rd-runtime/pulse/native
  export SDL_AUDIODRIVER=pulseaudio
fi

PROFILE_ROOT="/tmp/bridges-agent-browser"
PROFILE_DIR="${PROFILE_ROOT}/profile"
WARMUP_FILE="${PROFILE_ROOT}/warmup.html"
CDP_PORT=18801

CHROME_BIN="$(command -v google-chrome-stable || command -v google-chrome || command -v chromium-browser || command -v chromium || true)"
if [ -z "$CHROME_BIN" ] || [ ! -x "$CHROME_BIN" ]; then
  echo "No Chrome/Chromium binary found" >&2
  exit 1
fi

pkill -f "remote-debugging-port=${CDP_PORT}" 2>/dev/null || true
sleep 1

VNC_RES=$(DISPLAY=:1 xrandr 2>/dev/null | awk '/\*/ { print $1; exit }' || echo "1280x1024")
VNC_W=${VNC_RES%x*}
VNC_H=${VNC_RES#*x}

rm -rf "$PROFILE_ROOT" 2>/dev/null || true
mkdir -p "$PROFILE_DIR/Default"

cat > "$PROFILE_DIR/Default/Preferences" <<PREFS
{
  "browser": {
    "window_placement": {
      "bottom": ${VNC_H},
      "left": 0,
      "maximized": true,
      "right": ${VNC_W},
      "top": 0,
      "work_area_bottom": ${VNC_H},
      "work_area_left": 0,
      "work_area_right": ${VNC_W},
      "work_area_top": 0
    }
  }
}
PREFS

cat > "$WARMUP_FILE" <<HTML
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Shared Browser Warmup</title>
  <style>
    :root {
      --bg-0: #060816;
      --bg-1: #0b1020;
      --bg-2: #121a33;
      --line: rgba(120, 166, 255, 0.14);
      --panel-edge: rgba(120, 166, 255, 0.18);
      --text-0: #f5f7ff;
      --text-1: #a8b3cf;
      --text-2: #6d7896;
      --accent: #6ea8ff;
      --accent-2: #7ef0ff;
      --ok: #77e39b;
      --warn: #ffd166;
      --bad: #ff6b7a;
      --shadow: 0 20px 80px rgba(0,0,0,0.45);
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background:
        radial-gradient(circle at top, rgba(110,168,255,0.16), transparent 32%),
        radial-gradient(circle at 80% 20%, rgba(126,240,255,0.10), transparent 24%),
        linear-gradient(180deg, var(--bg-1), var(--bg-0));
      color: var(--text-0);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      background:
        linear-gradient(var(--line) 1px, transparent 1px),
        linear-gradient(90deg, var(--line) 1px, transparent 1px);
      background-size: 32px 32px;
      mask-image: linear-gradient(to bottom, rgba(255,255,255,0.35), rgba(255,255,255,0.05));
      pointer-events: none;
    }
    .shell {
      width: 100%;
      height: 100%;
      display: grid;
      place-items: center;
      padding: 40px;
    }
    .panel {
      width: min(860px, 100%);
      border: 1px solid var(--panel-edge);
      background: linear-gradient(180deg, rgba(18,26,51,0.84), rgba(8,12,24,0.9));
      border-radius: 24px;
      box-shadow: var(--shadow);
      overflow: hidden;
      position: relative;
      backdrop-filter: blur(14px);
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      border-bottom: 1px solid rgba(120, 166, 255, 0.12);
      background: rgba(7, 11, 24, 0.45);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      font-size: 12px;
      color: var(--text-1);
    }
    .brand-mark {
      width: 12px;
      height: 12px;
      border-radius: 999px;
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      box-shadow: 0 0 18px rgba(110,168,255,0.55);
    }
    .status-pill {
      border: 1px solid rgba(255, 209, 102, 0.25);
      color: var(--warn);
      background: rgba(255, 209, 102, 0.08);
      padding: 8px 12px;
      border-radius: 999px;
      font-size: 12px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .body {
      display: grid;
      grid-template-columns: 1.15fr 0.85fr;
      gap: 28px;
      padding: 32px;
    }
    .headline {
      margin: 0 0 10px;
      font-size: clamp(32px, 5vw, 52px);
      line-height: 0.95;
      letter-spacing: -0.04em;
    }
    .headline .accent {
      color: var(--accent-2);
      text-shadow: 0 0 28px rgba(126, 240, 255, 0.18);
    }
    .sub {
      margin: 0;
      color: var(--text-1);
      font-size: 15px;
      line-height: 1.65;
      max-width: 56ch;
    }
    .meta {
      display: flex;
      gap: 16px;
      margin-top: 26px;
      flex-wrap: wrap;
    }
    .meta-card {
      min-width: 170px;
      padding: 16px 18px;
      border-radius: 18px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.05);
    }
    .meta-label {
      font-size: 11px;
      color: var(--text-2);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 10px;
    }
    .meta-value {
      font-size: 18px;
      font-weight: 600;
      color: var(--text-1);
      letter-spacing: -0.02em;
    }
    .right {
      display: grid;
      gap: 16px;
      align-content: start;
    }
    .network-card, .steps {
      border-radius: 20px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.05);
      padding: 20px;
    }
    .net-head {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 14px;
    }
    .net-dot {
      width: 16px;
      height: 16px;
      border-radius: 999px;
      background: var(--warn);
      box-shadow: 0 0 18px rgba(255, 209, 102, 0.55);
      animation: pulse 1.8s ease-in-out infinite;
      flex: 0 0 auto;
    }
    .net-dot.ok {
      background: var(--ok);
      box-shadow: 0 0 18px rgba(119, 227, 155, 0.55);
    }
    .net-dot.bad {
      background: var(--bad);
      box-shadow: 0 0 18px rgba(255, 107, 122, 0.55);
    }
    .net-title {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.03em;
    }
    .net-copy {
      color: var(--text-1);
      font-size: 14px;
      line-height: 1.6;
    }
    .steps {
      display: grid;
      gap: 10px;
    }
    .step {
      display: grid;
      grid-template-columns: 14px 1fr;
      gap: 12px;
      align-items: center;
      color: var(--text-1);
      font-size: 14px;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      box-shadow: 0 0 16px rgba(110,168,255,0.45);
      animation: pulse 1.8s ease-in-out infinite;
    }
    .footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 20px;
      padding: 0 32px 28px;
      color: var(--text-2);
      font-size: 12px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .bar {
      flex: 1;
      max-width: 340px;
      height: 8px;
      border-radius: 999px;
      background: rgba(255,255,255,0.06);
      overflow: hidden;
      position: relative;
    }
    .bar::after {
      content: "";
      position: absolute;
      inset: 0;
      width: 42%;
      background: linear-gradient(90deg, rgba(110,168,255,0.05), rgba(110,168,255,0.95), rgba(126,240,255,0.95));
      box-shadow: 0 0 22px rgba(110,168,255,0.45);
      animation: sweep 1.8s ease-in-out infinite;
    }
    @keyframes sweep {
      0% { transform: translateX(-120%); }
      100% { transform: translateX(280%); }
    }
    @keyframes pulse {
      0%, 100% { opacity: 0.55; transform: scale(1); }
      50% { opacity: 1; transform: scale(1.04); }
    }
    @media (max-width: 860px) {
      .body { grid-template-columns: 1fr; }
      .footer { flex-direction: column; align-items: flex-start; }
      .bar { max-width: none; width: 100%; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="panel">
      <div class="topbar">
        <div class="brand">
          <span class="brand-mark"></span>
          <span>BridgesLLM Remote Desktop</span>
        </div>
        <div class="status-pill" id="status-pill">Checking network path</div>
      </div>
      <div class="body">
        <div class="left">
          <h1 class="headline">Shared Browser<br><span class="accent">warming up</span></h1>
          <p class="sub">Holding the visible browser until outbound network access is confirmed, then handing off to the requested page.</p>
          <div class="meta">
            <div class="meta-card">
              <div class="meta-label">Viewport</div>
              <div class="meta-value">${VNC_W} x ${VNC_H}</div>
            </div>
            <div class="meta-card">
              <div class="meta-label">Mode</div>
              <div class="meta-value">Shared desktop browser</div>
            </div>
          </div>
        </div>
        <div class="right">
          <div class="network-card">
            <div class="net-head">
              <span class="net-dot" id="net-dot"></span>
              <div class="net-title" id="net-title">Checking internet reachability…</div>
            </div>
            <div class="net-copy" id="net-copy">This light turns green once the warmup page itself can reach the internet. Until then, the launcher keeps the shared browser on standby.</div>
          </div>
          <div class="steps">
            <div class="step"><span class="dot"></span><span>Locking viewport and device scale</span></div>
            <div class="step"><span class="dot"></span><span>Starting browser runtime and debug bridge</span></div>
            <div class="step"><span class="dot"></span><span>Waiting for outbound HTTPS reachability</span></div>
          </div>
        </div>
      </div>
      <div class="footer">
        <span>Visible to both user and agent</span>
        <div class="bar"></div>
      </div>
    </section>
  </div>
  <script>
    const dot = document.getElementById('net-dot');
    const title = document.getElementById('net-title');
    const copy = document.getElementById('net-copy');
    const pill = document.getElementById('status-pill');

    function setState(state) {
      dot.classList.remove('ok', 'bad');
      if (state === 'ok') {
        dot.classList.add('ok');
        title.textContent = 'Internet path confirmed';
        copy.textContent = 'Outbound network access was detected. The launcher can safely move on to the requested page.';
        pill.textContent = 'Network ready';
        pill.style.borderColor = 'rgba(119, 227, 155, 0.25)';
        pill.style.color = 'var(--ok)';
        pill.style.background = 'rgba(119, 227, 155, 0.08)';
      } else if (state === 'bad') {
        dot.classList.add('bad');
        title.textContent = 'Still waiting on internet reachability';
        copy.textContent = 'The warmup page has not confirmed outbound access yet. Retrying automatically.';
        pill.textContent = 'Waiting on network';
        pill.style.borderColor = 'rgba(255, 107, 122, 0.25)';
        pill.style.color = 'var(--bad)';
        pill.style.background = 'rgba(255, 107, 122, 0.08)';
      } else {
        title.textContent = 'Checking internet reachability…';
        copy.textContent = 'This light turns green once the warmup page itself can reach the internet. Until then, the launcher keeps the shared browser on standby.';
        pill.textContent = 'Checking network path';
      }
    }

    async function checkInternet() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1800);
      try {
        await fetch('https://example.com/?warmup=' + Date.now(), {
          mode: 'no-cors',
          cache: 'no-store',
          signal: controller.signal,
        });
        clearTimeout(timer);
        setState('ok');
        return true;
      } catch {
        clearTimeout(timer);
        setState('bad');
        return false;
      }
    }

    setState('checking');
    checkInternet();
    setInterval(checkInternet, 2500);
    window.addEventListener('online', checkInternet);
  </script>
</body>
</html>
HTML

WARMUP_URL="file://${WARMUP_FILE}"

"$CHROME_BIN" \
  --window-size="${VNC_W},${VNC_H}" \
  --window-position=0,0 \
  --start-maximized \
  --force-device-scale-factor=1 \
  --high-dpi-support=1 \
  --new-window \
  --no-first-run \
  --no-default-browser-check \
  --no-sandbox \
  --disable-gpu-sandbox \
  --disable-setuid-sandbox \
  --disable-dev-shm-usage \
  --disable-background-networking \
  --disable-sync \
  --disable-translate \
  --disable-extensions \
  --disable-features=TranslateUI \
  --disable-component-update \
  --disable-default-apps \
  --disable-domain-reliability \
  --metrics-recording-only \
  --user-data-dir="$PROFILE_DIR" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=${CDP_PORT} \
  "$WARMUP_URL" &

CHROME_PID=$!

for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if command -v wmctrl >/dev/null 2>&1; then
  sleep 1
  wmctrl -r :ACTIVE: -e "0,0,0,${VNC_W},${VNC_H}" 2>/dev/null || true
  wmctrl -r :ACTIVE: -b add,maximized_vert,maximized_horz 2>/dev/null || true
fi

if curl -sf "http://127.0.0.1:${CDP_PORT}/json/list" >/dev/null 2>&1; then
  node - <<'NODE' "$CDP_PORT" "$USER_URL"
const http = require('http');
const port = Number(process.argv[2]);
const finalUrl = process.argv[3] || 'about:blank';

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body || '[]')); } catch (err) { reject(err); }
      });
    }).on('error', reject);
  });
}

(async () => {
  try {
    const pages = (await getJson('/json/list')).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!pages.length) process.exit(0);
    const ws = new globalThis.WebSocket(pages[0].webSocketDebuggerUrl);
    const done = () => { try { ws.close(); } catch {} process.exit(0); };
    const timer = setTimeout(done, 12000);
    let sentNavigate = false;
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: 'fetch("https://example.com", { mode: "no-cors" }).then(() => "ok").catch(e => String(e))',
          awaitPromise: true,
          returnByValue: true,
        },
      }));
    });
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === 1 && !sentNavigate) {
        sentNavigate = true;
        if (finalUrl && finalUrl !== 'about:blank') {
          ws.send(JSON.stringify({ id: 2, method: 'Page.navigate', params: { url: finalUrl } }));
        } else {
          clearTimeout(timer);
          done();
        }
      } else if (message.id === 2) {
        clearTimeout(timer);
        done();
      }
    });
    ws.addEventListener('error', done);
    ws.addEventListener('close', done);
  } catch {
    process.exit(0);
  }
})();
NODE
fi

wait "$CHROME_PID" 2>/dev/null || true
