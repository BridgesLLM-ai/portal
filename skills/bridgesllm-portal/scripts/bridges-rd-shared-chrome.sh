#!/usr/bin/env bash
# Shared browser for VNC Remote Desktop
# Always starts clean, pins device scale at 1, and matches the active VNC resolution.
set -euo pipefail

DISABLE_FILE="${BRIDGES_SHARED_CHROME_DISABLE_FILE:-/run/bridges-shared-chrome.disabled}"
if [ -e "$DISABLE_FILE" ]; then
  echo "Shared Chrome launch disabled: $(cat "$DISABLE_FILE" 2>/dev/null || true)" >&2
  exit 75
fi

USER_URL="${1:-https://www.google.com/}"

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


write_nav_extension() {
  local extension_dir="$1"
  mkdir -p "$extension_dir"
  cat > "$extension_dir/manifest.json" <<'JSON'
{"manifest_version":3,"name":"BridgesLLM Remote Browser Navigation","version":"1.0.0","description":"Compact navigation bar for app-mode Remote Desktop browsers.","content_scripts":[{"matches":["http://*/*","https://*/*"],"js":["content.js"],"run_at":"document_idle","all_frames":false}]}
JSON
  cat > "$extension_dir/content.js" <<'JS'
(() => {
  if (window.top !== window) return;
  if (document.getElementById('__bridgesllm_nav_host')) return;
  const host = document.createElement('div');
  host.id = '__bridgesllm_nav_host';
  const shadow = host.attachShadow({ mode: 'open' });
  const collapsed = localStorage.getItem('__bridgesllm_nav_collapsed') === '1';
  shadow.innerHTML = `
    <style>
      :host{all:initial;color-scheme:dark}.bar,.bubble{position:fixed;z-index:2147483647;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}.bar{left:8px;right:8px;top:calc(env(safe-area-inset-top,0px) + 6px);min-height:40px;display:flex;align-items:center;gap:5px;padding:5px;border:1px solid rgba(148,163,184,.28);border-radius:13px;background:rgba(9,14,27,.88);box-shadow:0 10px 34px rgba(0,0,0,.38);backdrop-filter:blur(14px)}.bar.hidden{display:none}button{all:unset;box-sizing:border-box;min-width:32px;height:30px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;background:rgba(30,41,59,.95);color:#dbeafe;border:1px solid rgba(148,163,184,.18);font:700 13px/1 Inter,system-ui,sans-serif;cursor:pointer;user-select:none}button:active{transform:translateY(1px);background:rgba(59,130,246,.35)}input{all:unset;box-sizing:border-box;flex:1 1 auto;min-width:0;height:30px;border-radius:9px;background:rgba(2,6,23,.9);color:#f8fafc;border:1px solid rgba(96,165,250,.25);padding:0 10px;font:500 13px/30px ui-sans-serif,system-ui,sans-serif}input::selection{background:rgba(59,130,246,.55)}.go{min-width:38px;background:rgba(37,99,235,.95);color:white}.bubble{right:10px;top:calc(env(safe-area-inset-top,0px) + 8px);width:42px;height:42px;border-radius:999px;display:none;place-items:center;background:rgba(9,14,27,.9);color:#dbeafe;border:1px solid rgba(148,163,184,.3);box-shadow:0 10px 30px rgba(0,0,0,.35);font-size:18px;cursor:pointer;backdrop-filter:blur(14px)}.bubble.visible{display:grid}@media(max-width:520px){.bar{left:5px;right:5px;gap:4px;padding:4px}button{min-width:29px;height:29px;font-size:12px}input{height:29px;font-size:12px;padding:0 8px}.go{min-width:34px}}
    </style>
    <div class="bar${collapsed ? ' hidden' : ''}" role="navigation" aria-label="Remote browser navigation"><button id="back" title="Back">←</button><button id="forward" title="Forward">→</button><button id="reload" title="Reload">↻</button><input id="url" inputmode="url" spellcheck="false" autocomplete="off" aria-label="Address"/><button id="go" class="go" title="Go">Go</button><button id="hide" title="Hide bar">×</button></div><button class="bubble${collapsed ? ' visible' : ''}" id="show" title="Show navigation">🌐</button>`;
  const $ = (id) => shadow.getElementById(id);
  const bar = shadow.querySelector('.bar');
  const bubble = $('show');
  const input = $('url');
  let urlEditDirty = false;
  function inputHasFocus(){ return shadow.activeElement === input; }
  function syncUrl(force=false){ if(!force && (urlEditDirty || inputHasFocus())) return; input.value = location.href; urlEditDirty = false; }
  function normalizeTarget(raw){ const value=String(raw||'').trim(); if(!value) return ''; if(/^[a-z][a-z0-9+.-]*:/i.test(value)) return value; if(/^(localhost|\d{1,3}(?:\.\d{1,3}){3})(:\d+)?([/?#].*)?$/i.test(value)) return 'http://'+value; if(/^[^\s]+\.[^\s]{2,}([/?#].*)?$/i.test(value)) return 'https://'+value; return 'https://www.google.com/search?q='+encodeURIComponent(value); }
  function go(){ const target=normalizeTarget(input.value); if(target){ urlEditDirty=false; input.blur(); location.href=target; } }
  function collapse(next){ bar.classList.toggle('hidden', next); bubble.classList.toggle('visible', next); localStorage.setItem('__bridgesllm_nav_collapsed', next ? '1' : '0'); }
  $('back').onclick=()=>history.back(); $('forward').onclick=()=>history.forward(); $('reload').onclick=()=>location.reload(); $('go').onclick=go; $('hide').onclick=()=>collapse(true); bubble.onclick=()=>collapse(false);
  input.addEventListener('input',()=>{urlEditDirty=true;});
  input.addEventListener('keydown',(event)=>{event.stopPropagation(); if(event.key==='Enter'){event.preventDefault(); go();} if(event.key==='Escape'){urlEditDirty=false; syncUrl(true); input.blur();}});
  shadow.addEventListener('keydown',(e)=>e.stopPropagation()); shadow.addEventListener('keyup',(e)=>e.stopPropagation()); shadow.addEventListener('keypress',(e)=>e.stopPropagation());
  function mountNav(){ if(!document.documentElement){ setTimeout(mountNav,50); return; } if(!host.isConnected) document.documentElement.appendChild(host); syncUrl(true); window.addEventListener('popstate', ()=>syncUrl(true)); window.addEventListener('hashchange', ()=>syncUrl(true)); setInterval(()=>syncUrl(false),1500); } mountNav();
})();
JS
}

PROFILE_ROOT="/tmp/bridges-agent-browser"
PROFILE_DIR="${PROFILE_ROOT}/profile"
NAV_EXTENSION_DIR="${PROFILE_ROOT}/nav-extension"
WARMUP_FILE="${PROFILE_ROOT}/warmup.html"
CDP_PORT=18801

CHROME_BIN="$(command -v google-chrome-stable || command -v google-chrome || command -v chromium-browser || command -v chromium || true)"
if [ -z "$CHROME_BIN" ] || [ ! -x "$CHROME_BIN" ]; then
  echo "No Chrome/Chromium binary found" >&2
  exit 1
fi

pkill -f "remote-debugging-port=${CDP_PORT}" 2>/dev/null || true
sleep 1

read_vnc_geometry() {
  local res
  res=$(DISPLAY=:1 xrandr 2>/dev/null | awk '/\*/ { print $1; exit }' || true)
  if [[ ! "$res" =~ ^[0-9]+x[0-9]+$ ]]; then
    res="1280x1024"
  fi
  printf '%s %s\n' "${res%x*}" "${res#*x}"
}

read -r VNC_W VNC_H < <(read_vnc_geometry)

rm -rf "$PROFILE_ROOT" 2>/dev/null || true
mkdir -p "$PROFILE_DIR/Default"
write_nav_extension "$NAV_EXTENSION_DIR"

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

# Match the OpenClaw Web UI launcher's mobile-friendly behavior on narrow VNC
# desktops: Chrome's full browser chrome has a large minimum width, so iPhone-
# sized Remote Desktop sessions can end up with a window wider than the screen.
# App mode removes that minimum-width toolbar while CDP still lets the agent
# navigate/control the shared page. Keep the normal browser chrome on larger
# desktops unless explicitly overridden.
SHARED_BROWSER_MODE="${BRIDGES_SHARED_BROWSER_MODE:-auto}"
CHROME_TARGET_ARGS=("$WARMUP_URL")
if [ "$SHARED_BROWSER_MODE" = "app" ] || { [ "$SHARED_BROWSER_MODE" = "auto" ] && [ "${VNC_W:-1280}" -lt 700 ]; }; then
  CHROME_TARGET_ARGS=("--app=$WARMUP_URL")
fi

fit_active_window_to_vnc() {
  command -v wmctrl >/dev/null 2>&1 || return 0
  local w h
  read -r w h < <(read_vnc_geometry)
  [ "${w:-0}" -gt 0 ] && [ "${h:-0}" -gt 0 ] || return 0
  wmctrl -r :ACTIVE: -b remove,maximized_vert,maximized_horz 2>/dev/null || true
  wmctrl -r :ACTIVE: -e "0,0,0,${w},${h}" 2>/dev/null || true
  wmctrl -r :ACTIVE: -b add,maximized_vert,maximized_horz 2>/dev/null || true
}

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
  --disable-gpu \
  --disable-gpu-sandbox \
  --disable-gpu-compositing \
  --disable-accelerated-2d-canvas \
  --disable-accelerated-video-decode \
  --disable-setuid-sandbox \
  --disable-dev-shm-usage \
  --renderer-process-limit=2 \
  --disable-background-networking \
  --disable-sync \
  --disable-translate \
  --disable-features=TranslateUI \
  --disable-component-update \
  --disable-default-apps \
  --disable-domain-reliability \
  --metrics-recording-only \
  --disable-extensions \
  --user-data-dir="$PROFILE_DIR" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=${CDP_PORT} \
  "${CHROME_TARGET_ARGS[@]}" &

CHROME_PID=$!

(
  # noVNC smart-resize can settle after Chrome starts. Keep the shared browser
  # pinned to the current VNC work area during that settling window.
  for _ in $(seq 1 30); do
    fit_active_window_to_vnc
    sleep 0.5
  done
) >/dev/null 2>&1 &

for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if command -v wmctrl >/dev/null 2>&1; then
  sleep 1
  fit_active_window_to_vnc
fi

if curl -sf "http://127.0.0.1:${CDP_PORT}/json/list" >/dev/null 2>&1; then
  node - <<'NODE' "$CDP_PORT" "$USER_URL" "$NAV_EXTENSION_DIR/content.js"
const fs = require('fs');
const http = require('http');
const port = Number(process.argv[2]);
const finalUrl = process.argv[3] || 'https://www.google.com/';
const navSourcePath = process.argv[4] || '';
const navSource = navSourcePath ? fs.readFileSync(navSourcePath, 'utf8') : '';

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
    function send(id, method, params = {}) {
      ws.send(JSON.stringify({ id, method, params }));
    }
    function injectNav(id) {
      if (!navSource) return false;
      send(id, 'Runtime.evaluate', { expression: navSource, awaitPromise: false, returnByValue: false });
      return true;
    }
    ws.addEventListener('open', () => {
      if (navSource) send(10, 'Page.addScriptToEvaluateOnNewDocument', { source: navSource });
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
          if (!injectNav(3)) {
            clearTimeout(timer);
            setTimeout(done, 500);
          }
        }
      } else if (message.id === 2) {
        setTimeout(() => {
          if (!injectNav(3)) {
            clearTimeout(timer);
            done();
          }
        }, 1200);
      } else if (message.id === 3) {
        clearTimeout(timer);
        setTimeout(done, 300);
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
