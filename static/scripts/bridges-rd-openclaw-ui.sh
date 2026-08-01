#!/usr/bin/env bash
# Dedicated OpenClaw Control UI browser for the Remote Desktop.
# Uses its own persistent Chrome profile so it does not reset/kill Shared Browser.
set -euo pipefail

if [ "$(id -u)" = "0" ]; then
  if id bridgesrd >/dev/null 2>&1; then
    exec runuser -u bridgesrd -- /usr/local/bin/bridges-rd-openclaw-ui.sh "$@"
  fi
  echo "ERROR: Must not run OpenClaw UI browser as root without bridgesrd user" >&2
  exit 1
fi

if [ "$(id -un)" != "bridgesrd" ]; then
  echo "ERROR: OpenClaw UI browser must run as the bridgesrd account" >&2
  exit 1
fi

umask 077

ENV_FILE="/home/bridgesrd/.bridges-rd-env"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
else
  export DISPLAY="${DISPLAY:-:1}"
  export XAUTHORITY="${XAUTHORITY:-/home/bridgesrd/.Xauthority}"
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

PROFILE_DIR="/home/bridgesrd/.config/openclaw-control-ui-browser"
NAV_EXTENSION_DIR="$PROFILE_DIR/nav-extension"
URL_FILE="${OPENCLAW_DASHBOARD_URL_FILE:-$PROFILE_DIR/dashboard-url}"
LAUNCH_HTML="${OPENCLAW_DASHBOARD_LAUNCH_HTML:-$PROFILE_DIR/launch.html}"
mkdir -p "$PROFILE_DIR"
chmod 700 "$PROFILE_DIR"
write_nav_extension "$NAV_EXTENSION_DIR"
chmod 700 "$NAV_EXTENSION_DIR"

read_vnc_geometry() {
  local res
  res=$(DISPLAY=:1 xrandr 2>/dev/null | awk '/\*/ { print $1; exit }' || true)
  if [[ ! "$res" =~ ^[0-9]+x[0-9]+$ ]]; then
    res="1280x1024"
  fi
  printf '%s %s\n' "${res%x*}" "${res#*x}"
}
read -r VNC_W VNC_H < <(read_vnc_geometry)

launch_file_for_url() {
  local target_url="${1:-}"
  if [ "$target_url" = "" ]; then
    return 1
  fi
  if [[ "$target_url" == file://* ]]; then
    printf '%s\n' "$target_url"
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    # Last-resort safety: never put a tokenized URL directly in Chrome args.
    if [[ "$target_url" == *"#token="* ]]; then
      return 1
    fi
    printf '%s\n' "$target_url"
    return 0
  fi
  OPENCLAW_TARGET_URL="$target_url" OPENCLAW_LAUNCH_HTML="$LAUNCH_HTML" python3 - <<'PY'
import html
import json
import os
from pathlib import Path
url = os.environ['OPENCLAW_TARGET_URL']
launch = Path(os.environ['OPENCLAW_LAUNCH_HTML'])
launch.parent.mkdir(parents=True, exist_ok=True)
launch.write_text(f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Opening OpenClaw Web UI…</title>
<meta http-equiv="refresh" content="0; url={html.escape(url, quote=True)}" />
<style>:root{{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#070b14;color:#d9f6ff}}body{{min-height:100vh;margin:0;display:grid;place-items:center}}main{{text-align:center;padding:24px}}.mark{{font-size:52px;line-height:1;margin-bottom:14px}}p{{margin:0;opacity:.78}}</style>
</head><body><main><div class="mark">🦞</div><p>Opening OpenClaw Web UI…</p></main>
<script>window.location.replace({json.dumps(url)});</script></body></html>
''')
PY
  chmod 600 "$LAUNCH_HTML" || true
  printf 'file://%s\n' "$LAUNCH_HTML"
}

resolve_target() {
  if [ "${1:-}" != "" ]; then
    launch_file_for_url "$1" || printf '%s\n' 'http://127.0.0.1:18789/'
    return
  fi
  if [ "${OPENCLAW_DASHBOARD_URL:-}" != "" ]; then
    launch_file_for_url "$OPENCLAW_DASHBOARD_URL" || printf '%s\n' 'http://127.0.0.1:18789/'
    return
  fi
  # Normal managed path: portal writes this private redirect page with a tokenized
  # dashboard URL. Opening file:// keeps the token out of the Chrome process list.
  if [ -r "$LAUNCH_HTML" ]; then
    printf 'file://%s\n' "$LAUNCH_HTML"
    return
  fi
  # Fallback for partially-upgraded installs: reconstruct the private launch page
  # from the URL file rather than passing the tokenized URL directly to Chrome.
  if [ -r "$URL_FILE" ]; then
    local saved_url
    saved_url="$(head -n 1 "$URL_FILE" | tr -d '\r\n')"
    if [ "$saved_url" != "" ]; then
      launch_file_for_url "$saved_url" || printf '%s\n' 'http://127.0.0.1:18789/'
      return
    fi
  fi
  printf '%s\n' 'http://127.0.0.1:18789/'
}

TARGET_URL="$(resolve_target "${1:-}")"

CHROME_BIN="$(command -v google-chrome-stable || command -v google-chrome || command -v chromium-browser || command -v chromium || true)"
if [ -z "$CHROME_BIN" ] || [ ! -x "$CHROME_BIN" ]; then
  echo "No Chrome/Chromium binary found" >&2
  exit 1
fi

# Keep this browser independent from the shared/agent-controlled Chrome profile.
# On iPhone-sized VNC desktops, normal Chrome has a minimum toolbar width wider
# than the screen. Use app mode there, plus the BridgesLLM injected navigation
# bar. On larger desktops, keep native Chrome navigation chrome.
CDP_PORT=18802
# Replace any stale OpenClaw UI debug browser before opening a fresh shortcut.
pkill -f "remote-debugging-port=${CDP_PORT}" 2>/dev/null || true

CHROME_TARGET_ARGS=("$TARGET_URL")
if [ "${BRIDGES_OPENCLAW_UI_BROWSER_MODE:-auto}" = "app" ] || { [ "${BRIDGES_OPENCLAW_UI_BROWSER_MODE:-auto}" = "auto" ] && [ "${VNC_W:-1280}" -lt 700 ]; }; then
  CHROME_TARGET_ARGS=("--app=$TARGET_URL")
fi

"$CHROME_BIN" \
  --new-window \
  --window-size="${VNC_W},${VNC_H}" \
  --window-position=0,0 \
  --start-maximized \
  --force-device-scale-factor=1 \
  --high-dpi-support=1 \
  --class=OpenClawControlUI \
  --name=OpenClawControlUI \
  --no-first-run \
  --no-default-browser-check \
  --user-data-dir="$PROFILE_DIR" \
  --enable-unsafe-extension-debugging \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=${CDP_PORT} \
  "${CHROME_TARGET_ARGS[@]}" &

CHROME_PID=$!

for i in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
    break
  fi
  sleep 0.3
done

# OpenClaw Controls: load the gateway's Chrome extension into this browser on
# every launch. Branded Chrome ignores --load-extension, and a CDP-loaded
# unpacked extension is session-scoped, so this reload is the persistence
# mechanism; the pairing saved in this profile's extension storage survives
# restarts and reconnects on its own. No pairing secret is read or printed
# here — pairing stays a one-time action in the extension popup. Extension
# load failures never block the Control UI itself.
OPENCLAW_EXTENSION_DIR=""
if command -v openclaw >/dev/null 2>&1; then
  OPENCLAW_EXTENSION_DIR="$(openclaw browser extension path 2>/dev/null | tail -1 || true)"
fi
if [ -n "$OPENCLAW_EXTENSION_DIR" ] && [ -f "$OPENCLAW_EXTENSION_DIR/manifest.json" ] \
  && curl -sf "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
  node - <<'OPENCLAW_EXT' "$CDP_PORT" "$OPENCLAW_EXTENSION_DIR" || true
const http = require('http');
const port = Number(process.argv[2]);
const extensionPath = process.argv[3];
function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body || '{}')); } catch (err) { reject(err); }
      });
    }).on('error', reject);
  });
}
(async () => {
  try {
    const version = await getJson('/json/version');
    if (!version.webSocketDebuggerUrl) process.exit(0);
    const ws = new globalThis.WebSocket(version.webSocketDebuggerUrl);
    const done = () => { try { ws.close(); } catch {} process.exit(0); };
    setTimeout(done, 10000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Extensions.loadUnpacked', params: { path: extensionPath } }));
    });
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === 1) done();
    });
    ws.addEventListener('error', done);
  } catch {
    process.exit(0);
  }
})();
OPENCLAW_EXT
fi

if curl -sf "http://127.0.0.1:${CDP_PORT}/json/list" >/dev/null 2>&1; then
  node - <<'NODE' "$CDP_PORT" "$NAV_EXTENSION_DIR/content.js"
const fs = require('fs');
const http = require('http');
const port = Number(process.argv[2]);
const navSource = fs.readFileSync(process.argv[3], 'utf8');
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
    const page = pages[0];
    const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
    const done = () => { try { ws.close(); } catch {} process.exit(0); };
    const timer = setTimeout(done, 10000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Page.addScriptToEvaluateOnNewDocument', params: { source: navSource } }));
      setTimeout(() => ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: navSource } })), 1500);
    });
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === 2) { clearTimeout(timer); setTimeout(done, 300); }
    });
    ws.addEventListener('error', done);
    ws.addEventListener('close', done);
  } catch { process.exit(0); }
})();
NODE
fi

wait "$CHROME_PID" 2>/dev/null || true
