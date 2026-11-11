export function normalizeWebsiteUrl(value) {
  const raw = String(value || "").trim();
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(candidate);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !url.hostname.includes(".")) {
    throw new Error("رابط الموقع غير صالح؛ استخدم رابطًا مثل https://example.com.");
  }
  url.hash = "";
  url.search = "";
  return `${url.origin}/`;
}

export function canonicalSiteHost(host) {
  return String(host || "").toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

export function normalizeSitemapForCompare(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    url.hash = "";
    return url.href.replace(/\/$/, "").toLowerCase();
  } catch {
    return "";
  }
}

async function readResponsePrefix(response, maxCharacters) {
  if (!response.body?.getReader) return (await response.text()).slice(0, maxCharacters);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < maxCharacters) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    try { await reader.cancel(); } catch { }
  }
  return text.slice(0, maxCharacters);
}

async function fetchPrefix(url, { fetchImpl, timeoutMs, maxCharacters }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "follow",
      credentials: "omit",
      cache: "no-store"
    });
    const text = response.ok ? await readResponsePrefix(response, maxCharacters) : "";
    return { response, text };
  } finally {
    clearTimeout(timer);
  }
}

function belongsToSite(candidateHost, siteHost) {
  const candidate = canonicalSiteHost(candidateHost);
  const site = canonicalSiteHost(siteHost);
  return candidate === site || candidate.endsWith(`.${site}`);
}

function extractRobotsDirectives(robotsText) {
  const directives = [];
  let currentAgents = [];
  let groupHasRules = false;
  for (const rawLine of String(robotsText || "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const match = line.match(/^(user-agent|disallow|allow|sitemap)\s*:\s*(.*?)\s*$/i);
    if (!match) continue;
    const kind = match[1].toLowerCase();
    const value = match[2].trim();
    if (kind === "user-agent") {
      if (groupHasRules) {
        currentAgents = [];
        groupHasRules = false;
      }
      currentAgents.push(value.toLowerCase());
      continue;
    }
    if (kind === "sitemap") {
      directives.push({ type: kind, value, agents: [] });
      continue;
    }
    if (value) {
      directives.push({ type: kind, value, agents: currentAgents.length ? currentAgents.slice() : ["*"] });
      groupHasRules = true;
    }
  }
  return directives.slice(0, 100);
}

async function verifySitemaps(candidates, { fetchImpl, timeoutMs, robotsUrl, declared }) {
  const verified = [];
  for (let offset = 0; offset < candidates.length; offset += 4) {
    const batch = candidates.slice(offset, offset + 4);
    const results = await Promise.all(batch.map(async (sitemapUrl) => {
      try {
        const result = await fetchPrefix(sitemapUrl, { fetchImpl, timeoutMs, maxCharacters: 12 * 1024 });
        const finalUrl = result.response.url || sitemapUrl;
        const finalHost = new URL(finalUrl).hostname;
        const validXml = result.response.ok && belongsToSite(finalHost, new URL(robotsUrl).hostname) && /<(?:\w+:)?(?:urlset|sitemapindex)\b/i.test(result.text);
        return validXml ? { url: sitemapUrl, finalUrl, status: result.response.status, source: declared.has(sitemapUrl) ? "robots.txt" : "common path" } : null;
      } catch { return null; }
    }));
    verified.push(...results.filter(Boolean));
  }
  return verified;
}

export async function discoverSiteSitemaps(websiteUrl, { fetchImpl = globalThis.fetch, timeoutMs = 9000 } = {}) {
  const normalizedSiteUrl = normalizeWebsiteUrl(websiteUrl);
  const site = new URL(normalizedSiteUrl);
  const robotsUrl = new URL("/robots.txt", site.origin).toString();
  let robotsStatus = "غير متاح";
  let robotsText = "";
  try {
    const result = await fetchPrefix(robotsUrl, { fetchImpl, timeoutMs, maxCharacters: 256 * 1024 });
    robotsStatus = result.response.status;
    robotsText = result.response.ok ? result.text : "";
  } catch (error) {
    robotsStatus = error?.name === "AbortError" ? "timeout" : "تعذر الجلب";
  }

  const robotsDirectives = extractRobotsDirectives(robotsText);
  const declared = new Set();
  for (const directive of robotsDirectives) {
    if (directive.type !== "sitemap") continue;
    try {
      const candidate = new URL(directive.value, robotsUrl);
      if ((candidate.protocol === "https:" || candidate.protocol === "http:") && belongsToSite(candidate.hostname, site.hostname)) declared.add(candidate.toString());
    } catch { }
  }

  // Prefer sitemaps explicitly declared in robots.txt. If every declaration is
  // stale or inaccessible, still probe the conventional locations as a fallback.
  let sitemaps = await verifySitemaps([...declared].slice(0, 20), { fetchImpl, timeoutMs, robotsUrl, declared });
  let triedCommonPaths = false;
  if (!sitemaps.length) {
    triedCommonPaths = true;
    const commonPaths = ["/sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml", "/wp-sitemap.xml"];
    const candidates = commonPaths.map((path) => new URL(path, site.origin).toString()).filter((url) => !declared.has(url));
    sitemaps = await verifySitemaps(candidates, { fetchImpl, timeoutMs, robotsUrl, declared: new Set() });
  }

  const googleAgents = new Set(["*", "googlebot", "googlebot-news", "googlebot-image", "googlebot-video"]);
  const blockedRoot = robotsDirectives.some((item) => item.type === "disallow" && item.value === "/" && item.agents.some((agent) => googleAgents.has(agent)));
  return {
    robotsUrl,
    robotsStatus,
    robotsDirectives,
    blockedRoot,
    sitemapCount: sitemaps.length,
    sitemapDiscoveryLimit: 20,
    triedCommonPaths,
    sitemaps
  };
}
