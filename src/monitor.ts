import axios from "axios";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

const NTFY_TOPIC = process.env.NTFY_TOPIC ?? "stalker-ai-model-alert";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL ?? "";
const SITEMAP_INTERVAL = 3000;
const RSS_INTERVAL = 180000;
const SNAPSHOT_DIR = path.resolve(__dirname, "../");

const PORT = parseInt(process.env.PORT ?? "3000");

const SITEMAP_EXCLUDE = [
  "privacy",
  "terms",
  "rankings",
  "state-of-ai",
  "enterprise",
  "announcements",
  "stories/",
  "docs/",
  "providers",
  "chat",
  "models",
  "sdk",
  "works-with-openrouter",
  "collections",
  "provider",
  "compare",
] as const;

const RSS_URL = "https://openrouter.ai/api/v1/models?use_rss=true";
const SITEMAP_URL = "https://openrouter.ai/sitemap.xml";

const SitemapItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  link: z.string(),
  description: z.string(),
  pubDate: z.string(),
});

type SitemapItem = z.infer<typeof SitemapItemSchema>;

const SnapshotSchema = z.record(z.string(), SitemapItemSchema);
type Snapshot = z.infer<typeof SnapshotSchema>;

const log = (source: "Sitemap" | "RSS", message: string) =>
  console.log(`[${source}] ${message}`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const loadSnapshot = (file: string): Snapshot => {
  const filePath = path.join(SNAPSHOT_DIR, file);
  if (!fs.existsSync(filePath)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return SnapshotSchema.parse(raw);
  } catch {
    return {};
  }
};

const saveSnapshot = (file: string, models: Snapshot) => {
  const validated = SnapshotSchema.parse(models);
  fs.writeFileSync(path.join(SNAPSHOT_DIR, file), JSON.stringify(validated, null, 2));
};

const parseSitemap = (xml: string): string[] => {
  const urls: string[] = [];
  const urlRegex = /<loc>([^<]+)<\/loc>/g;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(xml)) !== null) {
    urls.push(match[1]);
  }
  return urls;
};

const fetchSitemapModels = async (): Promise<Snapshot> => {
  const { data } = await axios.get(SITEMAP_URL, {
    timeout: 15_000,
    responseType: "text",
  });
  const urls = parseSitemap(data);
  const snapshot: Snapshot = {};
  for (const url of urls) {
    if (!url.startsWith("https://openrouter.ai/")) continue;
    const pagePath = url.replace("https://openrouter.ai/", "");
    if (!pagePath.includes("/")) continue;
    if (pagePath.startsWith("works-with-openrouter/")) continue;
    if (SITEMAP_EXCLUDE.some((prefix) => pagePath.startsWith(prefix))) continue;
    snapshot[pagePath] = {
      id: pagePath,
      title: pagePath,
      link: url,
      description: "",
      pubDate: "",
    };
  }
  return SnapshotSchema.parse(snapshot);
};

const sendNtfy = async (_type: string, title: string, message: string) => {
  if (!NTFY_TOPIC) return;
  await axios.post(`https://ntfy.sh/${NTFY_TOPIC}`, message, {
    headers: { title, Priority: "high" },
    timeout: 10_000,
  });
};

const notify = async (type: string, title: string, message: string) => {
  await sendNtfy(type, title, message);
};

const checkRSSModels = async () => {
  log("RSS", "Fetching...");
  const { data } = await axios.get(RSS_URL, {
    headers: { Accept: "application/rss+xml" },
    timeout: 15_000,
    responseType: "text",
  });
  const items: SitemapItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(data)) !== null) {
    const block = match[1];
    const get = (tag: string): string => {
      const r = new RegExp(
        `<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,
      );
      const m = block.match(r);
      return (m?.[1] ?? m?.[2] ?? "").trim();
    };
    const id = get("guid") || get("link");
    if (id) {
      items.push(SitemapItemSchema.parse({
        id,
        title: get("title"),
        link: get("link"),
        description: get("description"),
        pubDate: get("pubDate"),
      }));
    }
  }
  const currentModels = SnapshotSchema.parse(
    items.reduce((acc, item) => ({ ...acc, [item.id]: item }), {}),
  );
  const knownModels = loadSnapshot("known_rss_models.json");

  if (Object.keys(knownModels).length === 0) {
    saveSnapshot("known_rss_models.json", currentModels);
    return;
  }

  const newIds = Object.keys(currentModels).filter((id) => !(id in knownModels));
  if (newIds.length === 0) {
    log("RSS", "No new models");
    return;
  }

  for (const id of newIds) {
    const item = currentModels[id];
    log("RSS", `Found new model: ${item.title}`);
    await notify("RSS", "New Model (RSS)", item.link);
    await sleep(500);
  }
  saveSnapshot("known_rss_models.json", currentModels);
};

const checkSitemapPages = async () => {
  log("Sitemap", "Fetching...");
  const currentModels = await fetchSitemapModels();
  const knownModels = loadSnapshot("known_sitemap_pages.json");

  if (Object.keys(knownModels).length === 0) {
    saveSnapshot("known_sitemap_pages.json", currentModels);
    return;
  }

  const newIds = Object.keys(currentModels).filter((id) => !(id in knownModels));
  if (newIds.length === 0) {
    log("Sitemap", "No new pages");
    return;
  }

  for (const id of newIds) {
    const item = currentModels[id];
    log("Sitemap", `Found new page: ${item.title}`);
    await notify("Sitemap", "New Page (Sitemap)", item.link);
    await sleep(500);
  }
  saveSnapshot("known_sitemap_pages.json", currentModels);
};

const getHtml = () => {
  const rssModels = loadSnapshot("known_rss_models.json");
  const sitemapPages = loadSnapshot("known_sitemap_pages.json");

  const rssItems = Object.values(rssModels).sort((a, b) => a.title.localeCompare(b.title));
  const sitemapItems = Object.values(sitemapPages).sort((a, b) => a.title.localeCompare(b.title));

  const rssJson = JSON.stringify(rssItems);
  const sitemapJson = JSON.stringify(sitemapItems);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>_stalker</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root { --bg: #000; --fg: #fff; --m: #111; --d: #444; --primary: #FF6600; --primary-dim: #993d00; }
    body { font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Mono', monospace; background: var(--bg); color: var(--fg); font-size: 12px; line-height: 1.5; }
    a { color: inherit; text-decoration: none; }
    
    .nav { display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 2rem; border-bottom: 1px solid var(--m); }
    .logo { display: flex; align-items: center; gap: 0.5rem; font-size: 11px; letter-spacing: 0.1em; }
    .logo-icon { width: 14px; height: 14px; background: var(--primary); clip-path: polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%); }
    .logo-text { font-weight: bold; color: var(--primary); }

    .container { max-width: 900px; margin: 0 auto; padding: 2rem; }
    
    .hero { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 2.5rem; }
    .hero-left {}
    .logo-main { 
      font-size: 42px; 
      font-weight: 900; 
      line-height: 1;
      letter-spacing: -1px;
      color: var(--fg);
      font-family: 'Arial Black', 'Helvetica Neue', sans-serif;
    }
    .logo-main::before {
      content: '_';
      color: var(--primary);
      margin-right: 2px;
    }
    .hero-sub { font-size: 10px; color: var(--d); letter-spacing: 0.15em; text-transform: uppercase; margin-top: 0.75rem; }
    .hero-stats { text-align: right; font-size: 10px; color: var(--d); }
    .hero-stats span { display: block; }
    .hero-stats .num { font-size: 24px; color: var(--primary); margin-bottom: 0.25rem; }

    .search-wrap { position: relative; margin-bottom: 2rem; }
    .search { width: 100%; padding: 0.75rem 1rem; padding-left: 2rem; font-family: inherit; font-size: 12px; background: var(--m); border: 1px solid var(--m); color: var(--fg); outline: none; }
    .search:focus { border-color: var(--primary); }
    .search::placeholder { color: var(--d); }
    .search-icon { position: absolute; left: 0.75rem; top: 50%; transform: translateY(-50%); color: var(--primary); }
    .search-hint { position: absolute; right: 0.75rem; top: 50%; transform: translateY(-50%); color: var(--d); font-size: 10px; border: 1px solid var(--m); padding: 0.1rem 0.3rem; }

    .section { margin-bottom: 2rem; }
    .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--m); }
    .section-title { font-size: 10px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--d); }
    .section-count { font-size: 10px; color: var(--primary); }

    .list { list-style: none; }
    .item { display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0; border-bottom: 1px solid var(--m); cursor: pointer; }
    .item:hover { background: var(--m); }
    .item-left { display: flex; align-items: center; gap: 0.75rem; }
    .item-arrow { color: var(--primary); font-size: 14px; }
    .item:hover .item-arrow { color: var(--fg); }
    .item-title { font-size: 12px; word-break: break-all; }
    .item-provider { font-size: 10px; color: var(--d); }
    .item-link { font-size: 10px; color: var(--d); text-align: right; word-break: break-all; }
    .item:hover .item-link { color: var(--primary); }

    @media (max-width: 600px) {
      .item { flex-direction: column; align-items: flex-start; gap: 0.25rem; }
      .item-left { width: 100%; }
      .item-link { width: 100%; text-align: left; margin-left: 1.5rem; }
      .hero { flex-direction: column; gap: 1rem; }
      .hero-stats { text-align: left; }
      .figlet { font-size: 28px; }
    }

    .pagination { display: flex; gap: 0.5rem; margin-top: 1rem; align-items: center; }
    .page-btn { padding: 0.3rem 0.6rem; font-family: inherit; font-size: 10px; background: none; border: 1px solid var(--m); color: var(--d); cursor: pointer; }
    .page-btn:hover:not(:disabled) { border-color: var(--primary); color: var(--primary); }
    .page-btn:disabled { opacity: 0.3; cursor: default; }
    .page-info { font-size: 10px; color: var(--d); margin: 0 0.5rem; }

    .detail { display: none; position: fixed; top: 0; right: 0; width: 400px; height: 100vh; background: var(--bg); border-left: 1px solid var(--m); padding: 1.5rem; overflow-y: auto; z-index: 100; }
    .detail.open { display: block; }
    .detail-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; padding-bottom: 1rem; border-bottom: 1px solid var(--m); }
    .detail-title { font-size: 14px; font-weight: bold; color: var(--primary); }
    .detail-close { background: none; border: none; color: var(--d); cursor: pointer; font-size: 18px; }
    .detail-close:hover { color: var(--fg); }
    .detail-row { display: flex; margin-bottom: 0.75rem; }
    .detail-label { width: 80px; font-size: 10px; color: var(--d); text-transform: uppercase; letter-spacing: 0.1em; }
    .detail-value { font-size: 12px; word-break: break-all; }
    .detail-value a { color: var(--primary); text-decoration: underline; }

    .detail-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); z-index: 99; }
    .detail.open + .detail-overlay { display: block; }

    footer { text-align: center; padding: 2rem; font-size: 9px; color: var(--d); letter-spacing: 0.1em; text-transform: uppercase; }
    footer a { color: var(--primary); }
  </style>
</head>
<body>
  <nav class="nav">
    <div class="logo">
      <div class="logo-icon"></div>
      <span class="logo-text">_stalker</span>
    </div>
  </nav>

  <div class="container">
    <div class="hero">
      <div class="hero-left">
        <div class="logo-main">STALKER</div>
        <div class="hero-sub">OpenRouter Monitoring System</div>
      </div>
      <div class="hero-stats">
        <span class="num">${rssItems.length + sitemapItems.length}</span>
        <span>Total Tracked</span>
      </div>
    </div>

    <div class="search-wrap">
      <span class="search-icon">/</span>
      <input type="text" class="search" placeholder="search tracked items..." id="search">
      <span class="search-hint">/</span>
    </div>

    <div class="section">
      <div class="section-header">
        <span class="section-title">Models</span>
        <span class="section-count" id="rss-count">${rssItems.length}</span>
      </div>
      <ul class="list" id="rss-list"></ul>
      <div class="pagination" id="rss-pagination"></div>
    </div>

    <div class="section">
      <div class="section-header">
        <span class="section-title">Pages</span>
        <span class="section-count" id="sitemap-count">${sitemapItems.length}</span>
      </div>
      <ul class="list" id="sitemap-list"></ul>
      <div class="pagination" id="sitemap-pagination"></div>
    </div>
  </div>

  <div class="detail" id="detail">
    <div class="detail-header">
      <span class="detail-title">Details</span>
      <button class="detail-close" onclick="closeDetail()">×</button>
    </div>
    <div id="detail-content"></div>
  </div>
  <div class="detail-overlay" onclick="closeDetail()"></div>

  <footer><a href="https://shubhankit.com">shubhankit.com</a></footer>

  <script>
    const rssData = ${rssJson};
    const sitemapData = ${sitemapJson};
    const ITEMS_PER_PAGE = 50;
    let currentDetail = null;

    function showDetail(item) {
      currentDetail = item;
      const content = document.getElementById('detail-content');
      content.innerHTML = \`
        <div class="detail-row"><span class="detail-label">ID</span><span class="detail-value">\${item.id}</span></div>
        <div class="detail-row"><span class="detail-label">Title</span><span class="detail-value">\${item.title}</span></div>
        <div class="detail-row"><span class="detail-label">Link</span><span class="detail-value"><a href="\${item.link}" target="_blank">\${item.link}</a></span></div>
        <div class="detail-row"><span class="detail-label">Source</span><span class="detail-value">\${item.pubDate ? 'RSS' : 'Sitemap'}</span></div>
      \`;
      document.getElementById('detail').classList.add('open');
    }

    function closeDetail() {
      document.getElementById('detail').classList.remove('open');
      currentDetail = null;
    }

    function renderList(data, listId, paginationId, countId) {
      const list = document.getElementById(listId);
      const pagination = document.getElementById(paginationId);
      const countEl = document.getElementById(countId);
      const searchQ = document.getElementById('search').value.toLowerCase();
      
      const filtered = data.filter(i => i.title.toLowerCase().includes(searchQ));
      const total = filtered.length;
      const totalPages = Math.ceil(total / ITEMS_PER_PAGE) || 1;
      
      countEl.textContent = total;
      
      let currentPage = parseInt(pagination.dataset.page || '1');
      if (currentPage > totalPages) currentPage = 1;
      
      const start = (currentPage - 1) * ITEMS_PER_PAGE;
      const pageItems = filtered.slice(start, start + ITEMS_PER_PAGE);
      
      list.innerHTML = pageItems.map(item => \`
        <li class="item" onclick="showDetail(\${JSON.stringify(item).replace(/"/g, '&quot;')})">
          <div class="item-left">
            <span class="item-arrow">›</span>
            <span class="item-title">\${item.title}</span>
          </div>
          <span class="item-link">\${item.link}</span>
        </li>
      \`).join('');
      
      pagination.innerHTML = \`
        <button class="page-btn" onclick="renderPage('\${listId}', '\${paginationId}', \${currentPage - 1})" \${currentPage === 1 ? 'disabled' : ''}>prev</button>
        <span class="page-info">\${currentPage}/\${totalPages}</span>
        <button class="page-btn" onclick="renderPage('\${listId}', '\${paginationId}', \${currentPage + 1})" \${currentPage >= totalPages ? 'disabled' : ''}>next</button>
      \`;
      pagination.dataset.page = currentPage;
    }

    function renderPage(listId, paginationId, page) {
      document.getElementById(paginationId).dataset.page = page;
      const isRss = listId === 'rss-list';
      renderList(isRss ? rssData : sitemapData, listId, paginationId, isRss ? 'rss-count' : 'sitemap-count');
    }

    function init() {
      renderList(rssData, 'rss-list', 'rss-pagination', 'rss-count');
      renderList(sitemapData, 'sitemap-list', 'sitemap-pagination', 'sitemap-count');
      
      document.getElementById('search').addEventListener('input', () => {
        renderList(rssData, 'rss-list', 'rss-pagination', 'rss-count');
        renderList(sitemapData, 'sitemap-list', 'sitemap-pagination', 'sitemap-count');
      });
    }

    init();
  </script>
</body>
</html>`;
};

const startServer = () => {
  const server = Bun.serve({
    port: PORT,
    fetch(req) {
      return new Response(getHtml(), {
        headers: { "Content-Type": "text/html" },
      });
    },
  });
  console.log(`Server running at http://localhost:${server.port}`);
};

const main = async () => {
  startServer();
  await checkRSSModels();
  await checkSitemapPages();
  setInterval(checkRSSModels, RSS_INTERVAL);
  setInterval(checkSitemapPages, SITEMAP_INTERVAL);
};

main();
