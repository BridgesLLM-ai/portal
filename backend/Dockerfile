FROM node:26.5.0-bookworm-slim AS backend-builder

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

FROM node:26.5.0-alpine AS frontend-builder

ARG VITE_API_URL=/api
ENV VITE_API_URL=${VITE_API_URL}

WORKDIR /opt/bridgesllm/portal/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

FROM node:26.5.0-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    ffmpeg \
    fonts-liberation \
    git \
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

COPY scripts ../scripts
COPY static ../static
COPY skills ../skills
COPY installer ../installer

RUN git config --global user.email "agent@bridgesllm.local" && \
    git config --global user.name "BridgesLLM Agent"

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3001') + '/health').then((response) => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
