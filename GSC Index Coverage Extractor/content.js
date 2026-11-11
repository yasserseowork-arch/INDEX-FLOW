/**
 * Content script for GSC Index Coverage Extractor.
 * Injected into Google Search Console pages.
 * Handles DOM extraction and communicates with the background service worker.
 */

(() => {
  // Guard against duplicate injection — ensureContentScript() may re-inject
  if (window.__gscExtractorLoaded) return;
  window.__gscExtractorLoaded = true;

  /**
   * Format a Date object according to the specified format string.
   * @param {Date} d - Date object
   * @param {string} format - 'DD/MM/YYYY', 'MM/DD/YYYY', or 'YYYY-MM-DD'
   * @returns {string}
   */
  function formatDate(d, format) {
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    if (format === 'MM/DD/YYYY') return `${mm}/${dd}/${yyyy}`;
    if (format === 'YYYY-MM-DD') return `${yyyy}-${mm}-${dd}`;
    return `${dd}/${mm}/${yyyy}`;
  }

  /**
   * Parse a date string from GSC (locale-dependent) into a Date object.
   * Handles M/D/YY, D/M/YY, and other common formats.
   * @param {string} dateStr - Raw date string from GSC DOM
   * @returns {Date|null}
   */
  function parseGscDate(dateStr) {
    if (!dateStr || dateStr === 'No date') return null;
    // Clean the string
    const clean = dateStr.replace(/[^\d/\-\.]/g, '').trim();
    const parts = clean.split(/[/\-\.]/);
    if (parts.length !== 3) return null;

    let [a, b, c] = parts.map(Number);
    // Expand 2-digit year
    if (c < 100) c += 2000;

    // Disambiguate: if first part > 12, it must be a day (DD/MM/YYYY format)
    let d;
    if (a > 12) {
      d = new Date(c, b - 1, a); // DD/MM/YYYY
    } else if (b > 12) {
      // If second part > 12, it must be a day (MM/DD/YYYY format)
      d = new Date(c, a - 1, b); // MM/DD/YYYY
    } else {
      // Ambiguous (both <= 12) — assume MM/DD/YYYY (US format, common GSC default)
      d = new Date(c, a - 1, b);
    }
    return isNaN(d.getTime()) ? null : d;
  }

  /**
   * Parse a count from a DOM element, handling abbreviated numbers (848K, 7.32M).
   * Prefers the title attribute (contains real number), falls back to suffix parsing.
   * @param {Element} el - DOM element containing the count
   * @returns {number}
   */
  function parseCount(el) {
    if (!el) return 0;
    // Prefer title attribute (GSC puts real numbers there, e.g. title="848,275")
    const title = el.getAttribute('title') || el.closest('.nnLLaf[title], .CO3mte[title]')?.getAttribute('title');
    if (title) {
      const num = parseInt(title.replace(/[,.\s]/g, ''));
      if (!isNaN(num)) return num;
    }
    // Fall back to parsing innerText with K/M/B suffixes
    const text = (el.innerText || '').trim();
    const suffixMatch = text.match(/^([\d,.]+)\s*([KMBkmb])?$/);
    if (suffixMatch) {
      const num = parseFloat(suffixMatch[1].replace(/,/g, ''));
      const suffix = (suffixMatch[2] || '').toUpperCase();
      if (suffix === 'K') return Math.round(num * 1000);
      if (suffix === 'M') return Math.round(num * 1000000);
      if (suffix === 'B') return Math.round(num * 1000000000);
      return Math.round(num);
    }
    return parseInt(text.replace(/[,.\s]/g, '')) || 0;
  }

  /**
   * Wait for an element to appear in the DOM using MutationObserver.
   * @param {string} selector - CSS selector to wait for
   * @param {number} timeout - Max wait time in ms
   * @returns {Promise<Element>}
   */
  function waitForElement(selector, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(selector);
      if (existing) return resolve(existing);

      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timeout waiting for ${selector}`));
      }, timeout);
    });
  }

  /**
   * Detect all GSC properties from the property dropdown.
   * Primary: reads data-resourceid attributes from the dropdown options.
   * Fallback: regex-matches URLs in embedded script blocks.
   * @returns {string[]} Array of GSC property URLs
   */
  /**
   * Check if a candidate property string is a real GSC property.
   * Filters out encoded nav URLs, Google URLs, sitemap XML paths, etc.
   */
  function isValidProperty(str) {
    if (!str) return false;
    if (!str.startsWith('sc-domain:') && !str.startsWith('http')) return false;
    // Encoded GSC navigation URLs (contain query params like pages=SITEMAP)
    if (str.includes('%26') || str.includes('\\u0026') || str.includes('pages=') || str.includes('pages%3D')) return false;
    // Sitemap XML paths
    if (/\.xml\b/i.test(str)) return false;
    // Blocked domains
    const blocked = [
      'google.com', 'google.es', 'google.co', 'googleapis.com', 'gstatic.com',
      'w3.org', 'schema.org', 'youtube.com', 'android.com',
      'apple.com', 'mozilla.org', 'chromium.org', 'angular.dev',
      'cloudflare.com', 'jsdelivr.net', 'unpkg.com',
    ];
    if (blocked.some(d => str.includes(d))) return false;
    return true;
  }

  function detectProperties() {
    try {
      const properties = new Set();

      // Primary method: ariaLabel from the property switcher dropdown
      const dropdowns = document.querySelectorAll('.u3WVdc.jBmls');
      if (dropdowns.length >= 2) {
        const container = dropdowns[1].childNodes[0];
        if (container) {
          for (const node of container.childNodes) {
            const label = node.ariaLabel;
            if (isValidProperty(label)) properties.add(label);
          }
        }
      }

      if (properties.size > 0) {
        return Array.from(properties).sort();
      }

      // Fallback: data-resourceid attributes
      const dropdownItems = document.querySelectorAll('[data-resourceid]');
      for (const el of dropdownItems) {
        const id = el.getAttribute('data-resourceid');
        if (isValidProperty(id)) properties.add(id);
      }

      if (properties.size > 0) {
        return Array.from(properties).sort();
      }

      // Last resort: parse script blocks
      const scripts = Array.from(
        document.querySelectorAll('script[nonce]'),
        el => el.text
      );

      for (const scriptText of scripts) {
        const regex = /((?:https?:\/\/|sc-domain:)[^"'\s,\]]+)/g;
        for (const match of scriptText.matchAll(regex)) {
          if (isValidProperty(match[1])) properties.add(match[1]);
        }
      }

      return Array.from(properties).sort();
    } catch (e) {
      return [];
    }
  }

  /**
   * Get the current property from the URL parameters.
   * @returns {string|null} Current property URL or null
   */
  function getCurrentProperty() {
    const params = new URLSearchParams(window.location.search);
    return params.get('resource_id') || null;
  }

  /**
   * Extract index coverage report categories and their URL counts.
   * Called on the index coverage overview page.
   * @returns {Promise<Array<{category: string, count: number, status: string}>>}
   */
  async function extractCoverageCategories() {
    try {
      // Wait for the table/list of categories to load
      await waitForElement('.nnLLaf, .WjMRLb, table', 20000);

      const categories = [];

      // Try to find category rows in the coverage report
      const rows = document.querySelectorAll('.nnLLaf .WjMRLb, table tbody tr');

      for (const row of rows) {
        const nameEl = row.querySelector('.QNAi2d, td:first-child');
        const countEl = row.querySelector('.d8GKJb, td:last-child');

        if (nameEl && countEl) {
          const category = nameEl.innerText.trim();
          const count = parseCount(countEl);

          if (category) {
            categories.push({ category, count });
          }
        }
      }

      return categories;
    } catch (e) {
      return [];
    }
  }

  /**
   * Extract report IDs from the current page's script blocks.
   * These IDs are used to navigate to individual report pages.
   * @param {string} property - The GSC property URL
   * @returns {Array<{id: string, category: string}>}
   */
  function extractReportIDs(property) {
    try {
      const scripts = Array.from(
        document.querySelectorAll('script[nonce]'),
        el => el.text
      );

      const reports = [];
      const seenIds = new Set();

      // Escape the property URL for use in regex
      const escapedProp = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      for (const scriptText of scripts) {
        // Look for report IDs associated with this property
        // Pattern: "property_url",13,"report_id" — note 13 is unquoted in GSC data
        const regex = new RegExp(
          `"${escapedProp}",13,"([^"]+)"`,
          'g'
        );

        for (const match of scriptText.matchAll(regex)) {
          const id = match[1];
          if (!seenIds.has(id)) {
            seenIds.add(id);
            reports.push({ id });
          }
        }
      }

      return reports;
    } catch (e) {
      return [];
    }
  }

  /**
   * Check if the page shows a "no data" message from GSC.
   * @returns {string|null} The no-data message found, or null
   */
  function detectNoDataMessage() {
    const bodyText = document.body?.innerText || '';
    const patterns = [
      'Processing data, please check again',
      'No data available',
      'Not enough data',
      'Data is not available',
    ];
    for (const p of patterns) {
      if (bodyText.includes(p)) return p;
    }
    return null;
  }

  /**
   * Extract URLs from a report detail page.
   * @param {string} category - The report category name
   * @returns {Promise<Array<{status: string, reportName: string, url: string, updated: string}>>}
   */
  async function extractReportUrls(category, dateFormat) {
    try {
      // Check for "no data" message before waiting
      const noData = detectNoDataMessage();
      if (noData) {
        return [];
      }

      // Wait for URL list to load
      await waitForElement('.OOHai', 20000);

      const rawUpdated =
        document.querySelector('.zTJZxd.zOPr2c')?.innerText ?? 'No date';
      const reportName =
        document.querySelector('.Iq9klb')?.innerText ?? category ?? 'Unknown';

      // Parse and reformat the date
      const parsedDate = parseGscDate(rawUpdated);
      const updated = parsedDate ? formatDate(parsedDate, dateFormat) : rawUpdated;

      const urlElements = document.querySelectorAll('.OOHai');
      const urls = [];

      for (const el of urlElements) {
        urls.push({
          status: category || reportName,
          'report name': reportName,
          url: el.innerText.replace(/[\uE14D\uE89E\uE8B6]/g, '').trim(),
          updated,
        });
      }

      return urls;
    } catch (e) {
      return [];
    }
  }

  /**
   * Extract sitemap list from the sitemaps page.
   * @returns {Promise<Array<{sitemap: string, type: string, submitted: string, lastRead: string, status: string, discoveredUrls: number}>>}
   */
  async function extractSitemapList() {
    try {
      await waitForElement('table tbody tr, .nnLLaf', 20000);

      const sitemaps = [];
      const rows = document.querySelectorAll('table tbody tr');

      for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 4) {
          sitemaps.push({
            sitemap: cells[0]?.innerText?.trim() || '',
            type: cells[1]?.innerText?.trim() || '',
            submitted: cells[2]?.innerText?.trim() || '',
            lastRead: cells[3]?.innerText?.trim() || '',
            status: cells[4]?.innerText?.trim() || '',
            discoveredUrls: parseCount(cells[5]),
          });
        }
      }

      return sitemaps;
    } catch (e) {
      return [];
    }
  }

  /**
   * Extract sitemap coverage details for a specific sitemap.
   * @returns {Promise<Array<{url: string, status: string, lastCrawled: string}>>}
   */
  async function extractSitemapCoverage() {
    try {
      // Check for "no data" message before waiting
      const noData = detectNoDataMessage();
      if (noData) {
        return [];
      }

      await waitForElement('.OOHai, table tbody tr', 20000);

      const urls = [];
      const urlElements = document.querySelectorAll('.OOHai');

      if (urlElements.length > 0) {
        for (const el of urlElements) {
          urls.push({
            url: el.innerText.replace(/[\uE14D\uE89E\uE8B6]/g, '').trim(),
          });
        }
      } else {
        // Fallback: try table rows
        const rows = document.querySelectorAll('table tbody tr');
        for (const row of rows) {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 1) {
            urls.push({
              url: cells[0]?.innerText?.trim() || '',
              status: cells[1]?.innerText?.trim() || '',
              lastCrawled: cells[2]?.innerText?.trim() || '',
            });
          }
        }
      }

      return urls;
    } catch (e) {
      return [];
    }
  }

  /**
   * Extract the total URL count from a report page (e.g., "1,234 URLs").
   * Uses the .CO3mte selector which shows the total count in GSC.
   * @returns {number} Total count, or 0 if not found
   */
  function extractTotalCount() {
    const el = document.querySelector('.CO3mte');
    return parseCount(el);
  }

  /**
   * Extract historic chart data from the ds:12 script block.
   * Returns daily timestamp-count pairs from the GSC bar chart.
   * @returns {Array<{date: string, count: number}>}
   */
  function extractHistoricData(dateFormat) {
    try {
      const scriptEl = document.querySelector('script.ds\\:12');
      if (!scriptEl) return [];

      const text = scriptEl.textContent;
      // Match all [timestamp, [count]] pairs — count may be "NaN" or a number
      const pairs = [];
      const regex = /\[(\d{13}),\s*\[("NaN"|\d+)\]\]/g;
      for (const match of text.matchAll(regex)) {
        const ts = parseInt(match[1]);
        const raw = match[2];
        const count = raw === '"NaN"' ? null : parseInt(raw);
        pairs.push({ date: formatDate(new Date(ts), dateFormat), count });
      }
      return pairs;
    } catch (e) {
      return [];
    }
  }

  /**
   * Get page title/heading - useful for identifying report category.
   * @returns {string}
   */
  function getPageHeading() {
    const heading =
      document.querySelector('.Iq9klb') ||
      document.querySelector('h1') ||
      document.querySelector('.kQ7Ome');
    return heading?.innerText?.trim() || '';
  }

  /**
   * Detect if the page is a Google error page (500, 429, etc.).
   * @returns {{error: boolean, code: string, message: string}}
   */
  function detectGoogleError() {
    const bodyText = document.body?.innerText || '';
    const title = document.title || '';

    // Google error pages show "N. That's an error." pattern
    const errorMatch = bodyText.match(/(\d{3})\.\s*That'?s an error/i);
    if (errorMatch) {
      return { error: true, code: errorMatch[1], message: `Google ${errorMatch[1]} error` };
    }

    // Check title for error codes
    if (/Error\s+\d{3}/.test(title)) {
      const code = title.match(/\d{3}/)?.[0] || 'unknown';
      return { error: true, code, message: `Google error (${code})` };
    }

    // Rate limit / "Too many requests" messages
    if (bodyText.includes('Too Many Requests') || /rate.?limit/i.test(bodyText)) {
      return { error: true, code: '429', message: 'Google rate limit (429)' };
    }

    return { error: false, code: null, message: null };
  }

  // Listen for messages from the background service worker
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const handlers = {
      detectProperties: async () => detectProperties(),
      getCurrentProperty: async () => getCurrentProperty(),
      extractCoverageCategories: async () => extractCoverageCategories(),
      extractReportIDs: async () => extractReportIDs(msg.property),
      extractReportUrls: async () => extractReportUrls(msg.category, msg.dateFormat),
      extractTotalCount: async () => extractTotalCount(),
      extractHistoricData: async () => extractHistoricData(msg.dateFormat),
      extractSitemapList: async () => extractSitemapList(),
      extractSitemapCoverage: async () => extractSitemapCoverage(),
      getPageHeading: async () => getPageHeading(),
      detectGoogleError: async () => detectGoogleError(),
      waitForContent: async () => {
        try {
          await waitForElement(msg.selector || '.OOHai', msg.timeout || 15000);
          return { ready: true };
        } catch {
          return { ready: false };
        }
      },
      ping: async () => ({ alive: true }),
    };

    const handler = handlers[msg.action];
    if (handler) {
      handler()
        .then(result => sendResponse({ success: true, data: result }))
        .catch(err =>
          sendResponse({ success: false, error: err.message })
        );
      return true; // Keep message channel open for async response
    }
  });

  // Notify that content script is loaded
  chrome.runtime.sendMessage({ action: 'contentScriptReady' });
})();
