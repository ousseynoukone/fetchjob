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

# Install system dependencies for Playwright Chromium, OpenSSL for Prisma, and ca-certificates
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
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma/

RUN npm install --omit=dev
RUN npx prisma generate
RUN npx playwright install chromium

COPY --from=builder /app/dist ./dist

EXPOSE 4000

ENV PORT=4000
ENV NODE_ENV=production

CMD sh -c "npx prisma migrate deploy && node dist/main.js"
