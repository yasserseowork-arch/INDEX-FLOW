import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalSiteHost, discoverSiteSitemaps, normalizeSitemapForCompare, normalizeWebsiteUrl } from '../site-audit-utils.js';

function fakeResponse(url, status, text, finalUrl = url) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: finalUrl,
    body: null,
    async text() { return text; }
  };
}

test('website URL accepts a bare domain and reduces a page URL to its site origin', () => {
  assert.equal(normalizeWebsiteUrl('example.com/category/product?ref=ad#details'), 'https://example.com/');
  assert.equal(normalizeWebsiteUrl('http://www.example.com/'), 'http://www.example.com/');
  assert.equal(canonicalSiteHost('www.Example.com.'), 'example.com');
  assert.equal(normalizeSitemapForCompare('/sitemap.xml#top', 'https://example.com/'), 'https://example.com/sitemap.xml');
});

test('website URL rejects non-web protocols and embedded credentials', () => {
  assert.throws(() => normalizeWebsiteUrl('javascript:alert(1)'));
  assert.throws(() => normalizeWebsiteUrl('https://user:pass@example.com'));
});

test('sitemap is discovered from robots.txt and verified as same-site XML', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/robots.txt')) {
      return fakeResponse(url, 200, 'User-agent: *\nDisallow: /private\nSitemap: https://www.example.com/maps/index.xml');
    }
    if (url === 'https://www.example.com/maps/index.xml') {
      return fakeResponse(url, 200, '<?xml version="1.0"?><sitemapindex></sitemapindex>');
    }
    return fakeResponse(url, 404, 'not found');
  };
  const result = await discoverSiteSitemaps('https://example.com/', { fetchImpl, timeoutMs: 50 });
  assert.equal(result.robotsStatus, 200);
  assert.equal(result.sitemapCount, 1);
  assert.equal(result.sitemaps[0].source, 'robots.txt');
  assert.equal(result.sitemaps[0].url, 'https://www.example.com/maps/index.xml');
  assert.equal(calls.length, 2);
});

test('common sitemap locations are checked when robots.txt does not declare one', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/robots.txt')) return fakeResponse(url, 404, '');
    if (url.endsWith('/sitemap_index.xml')) return fakeResponse(url, 200, '<sitemapindex></sitemapindex>');
    return fakeResponse(url, 404, '');
  };
  const result = await discoverSiteSitemaps('https://example.com', { fetchImpl, timeoutMs: 50 });
  assert.equal(result.robotsStatus, 404);
  assert.deepEqual(result.sitemaps.map((item) => item.source), ['common path']);
  assert.equal(result.sitemaps[0].url, 'https://example.com/sitemap_index.xml');
});

test('cross-site sitemap declarations are ignored', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/robots.txt')) return fakeResponse(url, 200, 'Sitemap: https://other.example.net/sitemap.xml');
    return fakeResponse(url, 404, '');
  };
  const result = await discoverSiteSitemaps('https://example.com', { fetchImpl, timeoutMs: 50 });
  assert.equal(result.sitemapCount, 0);
  assert.deepEqual(result.sitemaps, []);
});
