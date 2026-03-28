#!/usr/bin/env bash
set -euo pipefail

# export-public-github.sh
# Create a clean, public-safe export of BridgesLLM Portal source for GitHub.
# Does NOT push unless --push is provided.
#
# Usage:
#   scripts/export-public-github.sh
#   scripts/export-public-github.sh --push
#   scripts/export-public-github.sh --repo https://github.com/BridgesLLM-ai/portal.git --push
#
# Safety:
# - Exports to a clean temp dir (never pushes the live working tree)
# - Excludes secrets, env files, internal docs, build artifacts, temp/test files
# - Scans for sensitive file patterns before staging
# - Preserves existing remote history (incremental commits, not force-push)

SRC_ROOT="/root/bridgesllm-product"
TMP_ROOT="/tmp/bridgesllm-public-export"
DEFAULT_REPO_URL="https://github.com/BridgesLLM-ai/portal.git"
REPO_URL="$DEFAULT_REPO_URL"
PUSH=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)  REPO_URL="$2"; shift 2 ;;
    --push)  PUSH=true; shift ;;
    *)       echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

echo "→ Preparing public export from $SRC_ROOT"

rm -rf "$TMP_ROOT"
mkdir -p "$TMP_ROOT"

# ── Step 1: Copy source with comprehensive exclusions ──────────────
rsync -a \
  --delete \
  --exclude='.git' \
  \
  `# Dependencies & build output` \
  --exclude='node_modules' \
  --exclude='frontend/node_modules' \
  --exclude='backend/node_modules' \
  --exclude='frontend/dist' \
  --exclude='backend/dist' \
  --exclude='*.tar.gz' \
  --exclude='*.map' \
  --exclude='coverage' \
  \
  `# Secrets & environment` \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='frontend/.env*' \
  --exclude='backend/.env*' \
  --exclude='backend/.ssh' \
  --exclude='*.pem' \
  --exclude='*.key' \
  --exclude='*id_rsa*' \
  --exclude='*terminal_key*' \
  \
  `# Runtime data` \
  --exclude='.data' \
  --exclude='backend/.data' \
  --exclude='projects' \
  --exclude='uploads' \
  --exclude='assets/avatars' \
  --exclude='assets/branding' \
  --exclude='*.log' \
  --exclude='.DS_Store' \
  --exclude='tmp' \
  --exclude='backend/server.log' \
  --exclude='backend/backend.log' \
  \
  `# Stale frontend build artifacts (assets/ at root = old deploy copies)` \
  --exclude='/assets/assets' \
  --exclude='/assets/index.html' \
  \
  `# Internal docs — not for public consumption` \
  --exclude='PRODUCT-NOTES.md' \
  --exclude='AI-SETUP-WIZARD-PROGRESS.md' \
  --exclude='PROVIDER-AUTH-AUDIT.md' \
  --exclude='SECURITY_AUDIT_STEP10.md' \
  --exclude='TASK-*.md' \
  --exclude='*-audit-*.md' \
  --exclude='*audit*.md' \
  --exclude='OPENCLAW-CHAT-BUGS.md' \
  --exclude='ARCHITECTURE-*.md' \
  --exclude='ROADMAP-*.md' \
  --exclude='ROADMAP_*.md' \
  --exclude='LAUNCH-CHECKLIST.md' \
  --exclude='DEPLOYMENT.md' \
  --exclude='THIRD-PARTY-NOTICES.md' \
  --exclude='docs/SECURITY_INCIDENT_*.md' \
  --exclude='docs/AGENT-CHAT-STATUS-*.md' \
  --exclude='docs/OPENCLAW-UI-AUDIT-*.md' \
  --exclude='docs/CHAT_OVERHAUL_AUDIT.md' \
  --exclude='docs/GITHUB-SOP.md' \
  --exclude='docs/OPENCLAW-PORTAL-COMPAT-VERIFY-*.md' \
  --exclude='docs/SECURITY.md' \
  \
  `# Test & temp files` \
  --exclude='backend/test-*.js' \
  --exclude='backend/tmp-*.js' \
  --exclude='backend/cleanup-job.js' \
  --exclude='backend/CLEANUP-README.md' \
  --exclude='installer/install-v2-legacy.sh' \
  --exclude='installer/SPEC.md' \
  \
  `# Prisma archived migrations` \
  --exclude='backend/prisma/_archived_migrations' \
  \
  "$SRC_ROOT/" "$TMP_ROOT/"

# ── Step 2: Generate .gitignore ────────────────────────────────────
cat > "$TMP_ROOT/.gitignore" <<'EOF'
# Dependencies
node_modules/

# Build output
frontend/dist/
backend/dist/
*.tar.gz
*.map
coverage/

# Environment & secrets
.env
.env.*
frontend/.env*
backend/.env*
backend/.ssh/
*.pem
*.key

# Runtime data
.data/
projects/
uploads/
assets/avatars/
assets/branding/
*.log
.DS_Store
EOF

# ── Step 3: Safety scan — abort if sensitive files leaked through ──
echo "→ Scanning for sensitive file patterns..."
scan_hit=false
while IFS= read -r hit; do
  [[ -z "$hit" ]] && continue
  echo "[BLOCKED] sensitive file: $hit" >&2
  scan_hit=true
done < <(find "$TMP_ROOT" -type f \( \
  -name '.env' -o -name '.env.*' -o -name '*id_rsa*' -o -name '*terminal_key*' \
  -o -name '*.pem' -o -name '*.key' -o -name '.openclaw-portal-device.json' \
\) -not -path '*/.git/*' | sed "s#^$TMP_ROOT/##")

# Scan for hardcoded API keys (actual key values, not env var references)
# Anthropic keys: sk-ant-api03-..., OpenAI keys: sk-proj-XXXX...
# Use variable concatenation so this script doesn't self-match
_SK_ANT="sk-ant-""api"
_SK_PROJ="sk-proj-""[A-Za-z0-9]"
while IFS= read -r secret_hit; do
  [[ -z "$secret_hit" ]] && continue
  # Skip matches inside this script itself
  [[ "$secret_hit" == *"export-public-github.sh"* ]] && continue
  echo "[BLOCKED] Possible hardcoded API key: $secret_hit" >&2
  scan_hit=true
done < <(grep -rn "${_SK_ANT}\|${_SK_PROJ}" "$TMP_ROOT" --include='*.ts' --include='*.sh' --include='*.json' --include='*.js' 2>/dev/null || true)

if [[ "$scan_hit" == true ]]; then
  echo "✗ Export blocked. Remove sensitive files/patterns before pushing." >&2
  exit 1
fi

# ── Step 4: File count sanity check ───────────────────────────────
file_count=$(find "$TMP_ROOT" -type f -not -path '*/.git/*' | wc -l)
echo "→ Export contains $file_count files"
if (( file_count > 800 )); then
  echo "[warn] Unusually high file count ($file_count). Review before pushing." >&2
fi

# ── Step 5: Git setup ─────────────────────────────────────────────
cd "$TMP_ROOT"
git init -b main >/dev/null 2>&1

if [[ -n "$REPO_URL" ]]; then
  git remote add origin "$REPO_URL" 2>/dev/null || git remote set-url origin "$REPO_URL"
fi

echo "✓ Public export prepared at: $TMP_ROOT"
echo "  Repo: $REPO_URL"
echo "  Files: $file_count"
echo "  Review: cd $TMP_ROOT && find . -maxdepth 2 -not -path './.git/*' | sort | less"

# ── Step 6: Push (if requested) ───────────────────────────────────
if [[ "$PUSH" == true ]]; then
  echo "→ Fetching remote history..."

  # Clone the existing remote into a separate work dir to preserve history
  WORK_DIR="/tmp/bridgesllm-github-push"
  rm -rf "$WORK_DIR"
  git clone --depth=1 "$REPO_URL" "$WORK_DIR" 2>/dev/null || {
    echo "→ No existing remote history, creating fresh repo"
    mkdir -p "$WORK_DIR"
    cd "$WORK_DIR"
    git init -b main >/dev/null 2>&1
    git remote add origin "$REPO_URL"
  }

  cd "$WORK_DIR"

  # Remove all tracked files except .git, then overlay the export
  find . -maxdepth 1 -not -name '.git' -not -name '.' -exec rm -rf {} +
  rsync -a --exclude='.git' "$TMP_ROOT/" "$WORK_DIR/"

  git add -A

  if git diff --cached --quiet; then
    echo "✓ No changes to push"
    rm -rf "$WORK_DIR"
    exit 0
  fi

  # Show what changed
  echo "→ Changes:"
  git diff --cached --stat | tail -5

  # Use EXPORT_MSG env var if set, otherwise generic
  COMMIT_MSG="${EXPORT_MSG:-chore: source export $(date -u +%Y-%m-%dT%H:%M:%SZ)}"
  git commit -m "$COMMIT_MSG"
  git push origin main

  echo "✓ Pushed to $REPO_URL"
  rm -rf "$WORK_DIR"
fi
