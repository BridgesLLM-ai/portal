FROM node:26.8.1-bookworm-slim AS backend-builder

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/bridgesllm/portal/backend

COPY backend/package*.json ./
RUN npm ci

COPY backend/ ./
# `@prisma/client` installs before the application schema is copied into this
# hermetic builder, so its postinstall hook cannot generate the typed client.
# Generate from the exact shipped schema before TypeScript compilation.
RUN npx prisma generate && npm run build && npm prune --omit=dev

FROM node:26.8.1-alpine AS frontend-builder

ARG VITE_API_URL=/api
ENV VITE_API_URL=${VITE_API_URL}

WORKDIR /opt/bridgesllm/portal/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

FROM scratch AS runtime-source-builder

# This is the exact four-root source-entry projection of the signed-release
# staging allowlist. JSON-form COPY keeps every source/destination pairing
# unambiguous; the release inventory gate enforces one-to-one parity.
COPY ["installer/Setup-OllamaTailnet.ps1", "/runtime/installer/Setup-OllamaTailnet.ps1"]
COPY ["installer/Start-Here.cmd", "/runtime/installer/Start-Here.cmd"]
COPY ["installer/agent-zero-project-model-bridge.sh", "/runtime/installer/agent-zero-project-model-bridge.sh"]
COPY ["installer/agent-zero-project-sandbox.Dockerfile", "/runtime/installer/agent-zero-project-sandbox.Dockerfile"]
COPY ["installer/agent-zero-runtime.sh", "/runtime/installer/agent-zero-runtime.sh"]
COPY ["installer/antigravity-runtime.sh", "/runtime/installer/antigravity-runtime.sh"]
COPY ["installer/backup-container-fence.py", "/runtime/installer/backup-container-fence.py"]
COPY ["installer/backup-helper-deployment-exceptions.tsv", "/runtime/installer/backup-helper-deployment-exceptions.tsv"]
COPY ["installer/bridgesllm-codex-project-runtime-v1.apparmor", "/runtime/installer/bridgesllm-codex-project-runtime-v1.apparmor"]
COPY ["installer/bridgesllm-codex-project-runtime-v1.seccomp.json", "/runtime/installer/bridgesllm-codex-project-runtime-v1.seccomp.json"]
COPY ["installer/bridgesllm-project-runtime-v1.apparmor", "/runtime/installer/bridgesllm-project-runtime-v1.apparmor"]
COPY ["installer/bridgesllm-project-runtime-v1.seccomp.json", "/runtime/installer/bridgesllm-project-runtime-v1.seccomp.json"]
COPY ["installer/caddy-managed-config.py", "/runtime/installer/caddy-managed-config.py"]
COPY ["installer/dashboard-update-progress.py", "/runtime/installer/dashboard-update-progress.py"]
COPY ["installer/grok-build-runtime.sh", "/runtime/installer/grok-build-runtime.sh"]
COPY ["installer/hermes-runtime.sh", "/runtime/installer/hermes-runtime.sh"]
COPY ["installer/index.html", "/runtime/installer/index.html"]
COPY ["installer/install-windows.ps1", "/runtime/installer/install-windows.ps1"]
COPY ["installer/install.sh", "/runtime/installer/install.sh"]
COPY ["installer/migrate-openclaw-2026.9.1.mjs", "/runtime/installer/migrate-openclaw-2026.9.1.mjs"]
COPY ["installer/native-cli-bundle-transaction.py", "/runtime/installer/native-cli-bundle-transaction.py"]
COPY ["installer/ollama-tailnet-README.txt", "/runtime/installer/ollama-tailnet-README.txt"]
COPY ["installer/openclaw-ask-user-plugin", "/runtime/installer/openclaw-ask-user-plugin"]
COPY ["installer/openclaw-migration-transaction.py", "/runtime/installer/openclaw-migration-transaction.py"]
COPY ["installer/openclaw-stable-plugins.sh", "/runtime/installer/openclaw-stable-plugins.sh"]
COPY ["installer/opencode-runtime.sh", "/runtime/installer/opencode-runtime.sh"]
COPY ["installer/patch-openclaw-2026.9.1-portal-contract.mjs", "/runtime/installer/patch-openclaw-2026.9.1-portal-contract.mjs"]
COPY ["installer/portal-recovery-archive.py", "/runtime/installer/portal-recovery-archive.py"]
COPY ["installer/project-runtime-image-repair-launcher.py", "/runtime/installer/project-runtime-image-repair-launcher.py"]
COPY ["installer/release-required-members.txt", "/runtime/installer/release-required-members.txt"]
COPY ["installer/release-signing-ed25519.pub.pem", "/runtime/installer/release-signing-ed25519.pub.pem"]
COPY ["installer/scripts", "/runtime/installer/scripts"]
COPY ["installer/update-transaction-state.py", "/runtime/installer/update-transaction-state.py"]
COPY ["installer/update-validation-protocol-v1", "/runtime/installer/update-validation-protocol-v1"]
COPY ["installer/verify-openclaw-2026.9.1-stock-contract.mjs", "/runtime/installer/verify-openclaw-2026.9.1-stock-contract.mjs"]
COPY ["installer/xfce4-config", "/runtime/installer/xfce4-config"]
COPY ["scripts/patch-openclaw-codex-pending-input-hotfix.sh", "/runtime/scripts/patch-openclaw-codex-pending-input-hotfix.sh"]
COPY ["scripts/patch-openclaw-long-run-relay-hotfix.sh", "/runtime/scripts/patch-openclaw-long-run-relay-hotfix.sh"]
COPY ["skills/bridgesllm-portal", "/runtime/skills/bridgesllm-portal"]
COPY ["static", "/runtime/static"]

FROM node:26.8.1-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    ffmpeg \
    fonts-liberation \
    git \
    python3 \
    tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /opt/bridgesllm/portal/backend

COPY --from=backend-builder /opt/bridgesllm/portal/backend/package*.json ./
COPY --from=backend-builder /opt/bridgesllm/portal/backend/node_modules ./node_modules
COPY --from=backend-builder /opt/bridgesllm/portal/backend/dist ./dist
COPY --from=backend-builder /opt/bridgesllm/portal/backend/prisma ./prisma
COPY --from=frontend-builder /opt/bridgesllm/portal/frontend/dist ../frontend/dist

COPY --from=runtime-source-builder /runtime/scripts ../scripts
COPY --from=runtime-source-builder /runtime/static ../static
COPY --from=runtime-source-builder /runtime/skills ../skills
COPY --from=runtime-source-builder /runtime/installer ../installer

RUN git config --global user.email "agent@bridgesllm.local" && \
    git config --global user.name "BridgesLLM Agent"

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3001') + '/health').then((response) => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
