FROM node:20-slim AS base

# Playwright 의존성 설치
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libdbus-1-3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libatspi2.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libwayland-client0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 의존성 설치
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci

# Playwright Chromium 설치
RUN npx playwright install chromium

# 빌드
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Tesseract traineddata 복사
COPY eng.traineddata ./eng.traineddata

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# NEXT_PUBLIC_ 변수는 빌드 시점에 필요
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY

RUN npm run build

# 프로덕션
FROM base AS runner
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# standalone 빌드 결과물 복사
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Playwright 브라우저 + node_modules (playwright 런타임 필요)
COPY --from=deps /app/node_modules/playwright ./node_modules/playwright
COPY --from=deps /app/node_modules/playwright-core ./node_modules/playwright-core
COPY --from=deps /root/.cache/ms-playwright /home/nextjs/.cache/ms-playwright

# Tesseract 관련
COPY --from=builder /app/eng.traineddata ./eng.traineddata
COPY --from=deps /app/node_modules/tesseract.js ./node_modules/tesseract.js
COPY --from=deps /app/node_modules/tesseract.js-core ./node_modules/tesseract.js-core

# Sharp
COPY --from=deps /app/node_modules/sharp ./node_modules/sharp

RUN chown -R nextjs:nodejs /home/nextjs/.cache

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
