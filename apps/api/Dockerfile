# Build stage
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Install openssl for Prisma
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY tsconfig*.json ./
COPY nest-cli.json ./
COPY prisma ./prisma/

RUN npm install

COPY . .

RUN npx prisma generate
RUN npm run build

# Production stage
FROM node:20-bookworm-slim

WORKDIR /app

# Install system dependencies for Playwright Chromium, OpenSSL for Prisma, and ca-certificates.
# xvfb + the Mesa GLX/EGL software drivers exist for one case only: no host
# Chrome configured (BROWSER_CDP_URL unset) AND AUTO_APPLY_HEADLESS=false --
# a headed Chromium launched in here has no real display and no real GPU
# either way, so this gets it a virtual display and a working (if software)
# GL renderer instead of failing to start at all.
RUN apt-get update && apt-get install -y \
    openssl \
    ca-certificates \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    xvfb \
    libgl1-mesa-dri \
    libglx-mesa0 \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma/

RUN npm install --omit=dev
RUN npx prisma generate
RUN npx playwright install chromium

COPY --from=builder /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 4000

ENV PORT=4000
ENV NODE_ENV=production

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["sh", "-c", "npx prisma migrate deploy && node --max-old-space-size=384 dist/main.js"]
