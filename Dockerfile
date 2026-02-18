FROM oven/bun:1 as base

WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY known_rss_models.json ./known_rss_models.json 2>/dev/null || true
COPY known_sitemap_pages.json ./known_sitemap_pages.json 2>/dev/null || true

EXPOSE 3000

CMD ["bun", "run", "src/monitor.ts"]
