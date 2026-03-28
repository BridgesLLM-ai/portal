#!/usr/bin/env bash
set -euo pipefail

# Shared Browser Control — CDP interface to the shared desktop Chrome on port 18801
# Used by the shared-browser skill for OpenClaw agents.

CDP_PORT="${SHARED_BROWSER_CDP_PORT:-18801}"
CDP_BASE="http://127.0.0.1:${CDP_PORT}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_SCRIPT="${SCRIPT_DIR}/cdp-client.mjs"

ACTION="${1:-help}"
shift || true

cdp_check() {
  curl -sf "${CDP_BASE}/json/version" >/dev/null 2>&1 || {
    echo "ERROR: Cannot reach shared browser on port ${CDP_PORT}. Is Chrome running in the Remote Desktop?" >&2
    echo "Hint: Run 'shared-browser.sh launch' to start it." >&2
    return 1
  }
}

case "$ACTION" in
  tabs)
    cdp_check || exit 1
    curl -sf "${CDP_BASE}/json/list" | node -e "
      const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      const pages=d.filter(t=>t.type==='page');
      if(!pages.length){console.log('No tabs open.');process.exit(0);}
      pages.forEach((t,i)=>console.log((i+1)+'. '+t.title+' — '+t.url));
    "
    ;;

  current)
    cdp_check || exit 1
    curl -sf "${CDP_BASE}/json/list" | node -e "
      const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      const page=d.find(t=>t.type==='page');
      if(!page){console.log('No tabs open.');process.exit(0);}
      console.log(JSON.stringify({title:page.title,url:page.url,id:page.id},null,2));
    "
    ;;

  navigate)
    URL="${1:-}"
    if [ -z "$URL" ]; then echo "Usage: shared-browser.sh navigate <url>"; exit 1; fi
    node "$NODE_SCRIPT" navigate "$URL"
    ;;

  screenshot)
    OUTPUT="${1:-}"
    node "$NODE_SCRIPT" screenshot "$OUTPUT"
    ;;

  console)
    DURATION="${1:-3000}"
    node "$NODE_SCRIPT" console "$DURATION"
    ;;

  evaluate)
    EXPR="${1:-}"
    if [ -z "$EXPR" ]; then echo "Usage: shared-browser.sh evaluate '<js expression>'"; exit 1; fi
    node "$NODE_SCRIPT" evaluate "$EXPR"
    ;;

  launch)
    URL="${1:-}"
    # Check if already running
    if curl -sf "${CDP_BASE}/json/version" >/dev/null 2>&1; then
      echo "Shared browser already running on port ${CDP_PORT}."
      if [ -n "$URL" ]; then
        node "$NODE_SCRIPT" navigate "$URL"
      fi
      exit 0
    fi
    # Launch via the launcher script
    LAUNCHER="/usr/local/bin/bridges-rd-shared-chrome.sh"
    if [ ! -x "$LAUNCHER" ]; then
      echo "ERROR: Shared browser launcher not found at ${LAUNCHER}. Run Remote Desktop setup first."
      exit 1
    fi
    # Shell-escape the URL to prevent injection via special characters
    SAFE_URL="$(printf '%q' "$URL")"
    su - bridgesrd -c "bash -lc '${LAUNCHER} ${SAFE_URL} >/tmp/bridges-agent-browser.log 2>&1 &'" 2>/dev/null
    # Wait for CDP to come up
    for i in $(seq 1 15); do
      if curl -sf "${CDP_BASE}/json/version" >/dev/null 2>&1; then
        echo "Shared browser launched successfully on port ${CDP_PORT}."
        exit 0
      fi
      sleep 1
    done
    echo "ERROR: Shared browser launched but CDP not responding after 15s. Check /tmp/bridges-agent-browser.log"
    exit 1
    ;;

  help|--help|-h)
    echo "Usage: shared-browser.sh <command> [args]"
    echo ""
    echo "Commands:"
    echo "  tabs                  List open tabs"
    echo "  current               Get current page info (title + URL)"
    echo "  navigate <url>        Navigate the active tab to a URL"
    echo "  screenshot [path]     Capture screenshot (default: workspace dir)"
    echo "  console [duration_ms] Capture console output (default: 3000ms)"
    echo "  evaluate <expr>       Run JavaScript on the active page"
    echo "  launch [url]          Start Chrome if not running, optionally open URL"
    echo "  help                  Show this help"
    ;;

  *)
    echo "Unknown command: $ACTION"
    echo "Run 'shared-browser.sh help' for usage."
    exit 1
    ;;
esac
