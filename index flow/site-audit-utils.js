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

  const declared = [];
  for (const match of robotsText.matchAll(/^\s*sitemap\s*:\s*(\S+)\s*$/gim)) {
    try {
      const candidate = new URL(match[1], robotsUrl);
      if ((candidate.protocol === "https:" || candidate.protocol === "http:") && belongsToSite(candidate.hostname, site.hostname)) declared.push(candidate.toString());
    } catch { }
  }
  const candidates = [...new Set(declared)].slice(0, 5);
  const triedCommonPaths = candidates.length === 0;
  if (triedCommonPaths) {
    for (const path of ["/sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml", "/wp-sitemap.xml"]) candidates.push(new URL(path, site.origin).toString());
  }

  const checks = await Promise.all(candidates.map(async (sitemapUrl) => {
    try {
      const result = await fetchPrefix(sitemapUrl, { fetchImpl, timeoutMs, maxCharacters: 12 * 1024 });
      const finalUrl = result.response.url || sitemapUrl;
      const finalHost = new URL(finalUrl).hostname;
      const validXml = result.response.ok && belongsToSite(finalHost, site.hostname) && /<(?:\w+:)?(?:urlset|sitemapindex)\b/i.test(result.text);
      return validXml ? { url: sitemapUrl, finalUrl, status: result.response.status, source: declared.includes(sitemapUrl) ? "robots.txt" : "common path" } : null;
    } catch { return null; }
  }));
  return { robotsUrl, robotsStatus, sitemapCount: checks.filter(Boolean).length, sitemaps: checks.filter(Boolean) };
}
