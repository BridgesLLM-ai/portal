#!/usr/bin/env bash
set -euo pipefail

# build-release.sh
# Creates the portal release tarball for the installer to download.
# Ensures prebuilt binaries, frontend dist, and backend dist are included,
# while stripping dev dependencies and source files.

PORTAL_DIR="/root/bridgesllm-product"
OUT_FILE="/tmp/portal.tar.gz"

echo "→ Building BridgesLLM Portal release..."

cd "$PORTAL_DIR"

# 1. Ensure frontend is built (with clean production env — no dev-only VITE_WS_URL)
echo "→ Compiling frontend..."
(cd frontend && VITE_WS_URL= npm run build)

# Sanity: reject build if a Tailnet URL leaked into the bundle
# (dev-only hostnames should never appear in production JS)
if grep -rl "\.ts\.net" frontend/dist/assets/*.js 2>/dev/null; then
  echo "✗ FATAL: Tailnet URL leaked into frontend build. Fix .env.local and retry."
  exit 1
fi

# 2. Ensure backend is built
echo "→ Compiling backend..."
(cd backend && npm run build)

# 3. Create the tarball
echo "→ Packaging tarball..."
tar czf "$OUT_FILE" \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='.env' \
  --exclude='.env.production' \
  --exclude='.env.local' \
  --exclude='backend/.env.production' \
  --exclude='backend/server.log' \
  --exclude='backend/backend.log' \
  --exclude='*.tar.gz' \
  --exclude='*.map' \
  --exclude='.data' \
  --exclude='backend/.data' \
  --exclude='installer/install-v2-legacy.sh' \
  --exclude='installer/SPEC.md' \
  --exclude='PRODUCT-NOTES.md' \
  --exclude='AI-SETUP-WIZARD-PROGRESS.md' \
  --exclude='PROVIDER-AUTH-AUDIT.md' \
  --exclude='SECURITY_AUDIT_STEP10.md' \
  --exclude='LAUNCH-CHECKLIST.md' \
  --exclude='DEPLOYMENT.md' \
  --exclude='OPENCLAW-CHAT-BUGS.md' \
  --exclude='ARCHITECTURE-*.md' \
  --exclude='ROADMAP-*.md' \
  --exclude='ROADMAP_*.md' \
  --exclude='TASK-*.md' \
  --exclude='*audit*.md' \
  --exclude='docs/GITHUB-SOP.md' \
  --exclude='docs/SECURITY.md' \
  --exclude='docs/SECURITY_INCIDENT_*.md' \
  --exclude='docs/AGENT-CHAT-STATUS-*.md' \
  --exclude='docs/OPENCLAW-UI-AUDIT-*.md' \
  --exclude='docs/OPENCLAW-PORTAL-COMPAT-VERIFY-*.md' \
  --exclude='backend/test-*.js' \
  --exclude='backend/cleanup-job.js' \
  --exclude='backend/tmp-*.js' \
  --exclude='backend/CLEANUP-README.md' \
  --exclude='backend/.ssh' \
  --exclude='assets/avatars' \
  --exclude='assets/assets' \
  --exclude='assets/branding' \
  --exclude='setup-legacy.ts' \
  --exclude='_archived_migrations' \
  --transform='s|^bridgesllm-product|portal|' \
  -C /root bridgesllm-product

# 4. Copy to marketing site
echo "→ Deploying to bridgesllm.ai..."
cp "$OUT_FILE" /root/bridgesllm-marketing/dist/portal.tar.gz
cp "$PORTAL_DIR/installer/install.sh" /root/bridgesllm-marketing/dist/install.sh

echo "✓ Release deployed to marketing site"
ls -lh /root/bridgesllm-marketing/dist/portal.tar.gz
ls -lh /root/bridgesllm-marketing/dist/install.sh