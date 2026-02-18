import axios from "axios";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

const NTFY_TOPIC = process.env.NTFY_TOPIC ?? "stalker-ai-model-alert";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL ?? "";
const SITEMAP_INTERVAL = 3000;
const RSS_INTERVAL = 180000;
const SNAPSHOT_DIR = path.resolve(__dirname, "../");

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

// const sendDiscord = async (message: string) => {
//   if (!DISCORD_WEBHOOK_URL) return;
//   await axios.post(DISCORD_WEBHOOK_URL, { content: message }, { timeout: 10_000 });
// };

const notify = async (type: string, title: string, message: string) => {
  await sendNtfy(type, title, message);
  // await sendDiscord(message);
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

const main = async () => {
  await checkRSSModels();
  await checkSitemapPages();

  if (process.env.RUN_ONCE === "true") {
    console.log("[Main] Single-run mode complete. Exiting.");
    process.exit(0);
  }

  setInterval(checkRSSModels, RSS_INTERVAL);
  setInterval(checkSitemapPages, SITEMAP_INTERVAL);
};

main();
