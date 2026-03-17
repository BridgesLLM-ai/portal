FROM node:20

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    chromium \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm ci

# Git config for auto-commit functionality
RUN git config --global user.email "marcus@bridgesllm.com" && \
    git config --global user.name "Marcus AI"

COPY . .

RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]
