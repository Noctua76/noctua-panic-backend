FROM node:20.20.2-bookworm-slim
ENV NODE_ENV=production PUPPETEER_SKIP_DOWNLOAD=true PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
WORKDIR /app
# There is deliberately NO ARG/ENV for DATABASE_URL, questionnaire roots or provider secrets.
RUN test -z "${QUESTIONNAIRE_KEYRING_BASE64:-}" && test -z "${DATABASE_URL:-}"
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-dejavu-core ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
CMD ["node", "server.js"]
