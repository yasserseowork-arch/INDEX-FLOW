/**
 * Background service worker for GSC Index Coverage Extractor.
 * Orchestrates tab navigation, content script injection, and data extraction.
 */

// Open side panel when extension icon is clicked
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

// Fallback: if setPanelBehavior doesn't work, use action.onClicked
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    // Side panel open failed
  }
});

/**
 * Navigate a tab to a URL and wait for it to finish loading.
 * @param {number} tabId - Chrome tab ID
 * @param {string} url - URL to navigate to
 * @returns {Promise<void>}
 */
async function navigateAndWait(tabId, url) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Navigation timeout'));
    }, 30000);

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        // Brief buffer for SPA render — content script uses MutationObserver for actual readiness
        setTimeout(resolve, 300);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url });
  });
}

/**
 * Ensure the content script is injected and ready in a tab.
 * @param {number} tabId - Chrome tab ID
 */
async function ensureContentScript(tabId) {
  try {
    // Try to ping the content script
    const response = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    if (response?.success) return;
  } catch {
    // Content script not ready, inject it
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    // Wait for it to initialize
    await new Promise(resolve => setTimeout(resolve, 500));
  } catch (e) {
    // Content script injection failed
  }
}

/**
 * Send a message to the content script in a tab and get a response.
 * @param {number} tabId - Chrome tab ID
 * @param {Object} message - Message to send
 * @returns {Promise<any>} Response data
 */
async function sendToContentScript(tabId, message) {
  await ensureContentScript(tabId);

  // Retry up to 3 times with increasing delays
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      if (response?.success) return response.data;
      if (response?.error) throw new Error(response.error);
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise(resolve =>
        setTimeout(resolve, 1000 * (attempt + 1))
      );
      await ensureContentScript(tabId);
    }
  }
}

/**
 * Check if the current page is a Google error page (500, 429, etc.).
 * @param {number} tabId - Chrome tab ID
 * @returns {Promise<{error: boolean, code: string, message: string}>}
 */
async function checkForGoogleError(tabId) {
  try {
    return await sendToContentScript(tabId, { action: 'detectGoogleError' });
  } catch {
    return { error: false };
  }
}

/**
 * Navigate to a URL, wait for load, and check for Google error pages.
 * Throws an error if Google returns a 500, 429, or other error page.
 * @param {number} tabId - Chrome tab ID
 * @param {string} url - URL to navigate to
 */
async function navigateAndCheck(tabId, url) {
  await navigateAndWait(tabId, url);
  const errorCheck = await checkForGoogleError(tabId);
  if (errorCheck.error) {
    throw new Error(errorCheck.message);
  }
}

// GSC URL path prefix for multi-account support (e.g., '/u/0' or '')
let gscPathPrefix = '';

/**
 * Detect the /u/N/ path prefix from a GSC URL.
 * @param {string} url - Current GSC page URL
 */
function detectGscPrefix(url) {
  const match = url?.match(/search\.google\.com(\/u\/\d+)\/search-console/);
  gscPathPrefix = match?.[1] || '';
}

/**
 * Build GSC URL for a specific page.
 * @param {string} property - GSC property URL
 * @param {string} page - Page path (e.g., 'index', 'sitemaps')
 * @param {Object} extraParams - Additional URL parameters
 * @returns {string} Full GSC URL
 */
function buildGscUrl(property, page, extraParams = {}) {
  const base = `https://search.google.com${gscPathPrefix}/search-console/${page}`;
  const params = new URLSearchParams({ resource_id: property, ...extraParams });
  return `${base}?${params.toString()}`;
}

// Store extraction state for persistence
let extractionState = {
  running: false,
  aborted: false,
  currentProperty: '',
  currentReport: '',
  results: {},
  progress: { current: 0, total: 0, urls: 0 },
};

/**
 * Main extraction handler — processes messages from the side panel.
 */
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'extraction') return;

  let aborted = false;
  let portAlive = true;

  // Track the active port globally so reconnecting side panels can replace it
  extractionState.activePort = port;

  // If extraction is already running (reconnection), send current state
  if (extractionState.running) {
    try {
      port.postMessage({
        type: 'status',
        message: 'Reconnected — extraction still in progress',
      });
    } catch {}
  }

  port.onDisconnect.addListener(() => {
    portAlive = false;
    // Do NOT set aborted — extraction continues, side panel can reconnect
  });

  // Safe message sender — tries port, falls back to storage for progress
  function safeSend(msg) {
    const activePort = extractionState.activePort;
    try {
      activePort?.postMessage(msg);
    } catch {
      // Port dead — write progress to storage so side panel can poll
      if (msg.type === 'progress' || msg.type === 'complete' || msg.type === 'error') {
        chrome.storage.session.set({ extractionProgress: msg });
      }
    }
  }

  port.onMessage.addListener(async msg => {
    if (msg.action === 'abort') {
      aborted = true;
      extractionState.aborted = true;
      extractionState.running = false;
      return;
    }

    if (msg.action === 'startExtraction') {
      const { tabId, properties, options } = msg;
      const delay = (options.delay || 3) * 1000;
      const extractCoverage = options.extractCoverage !== false;
      const extractSitemaps = options.extractSitemaps !== false;
      const extractHistory = options.extractHistory !== false;
      const dateFormat = options.dateFormat || 'DD/MM/YYYY';

      // Detect /u/N/ prefix from the current tab for multi-account support
      gscPathPrefix = '';
      try {
        const tab = await chrome.tabs.get(tabId);
        detectGscPrefix(tab.url);
      } catch {}

      extractionState = {
        running: true,
        aborted: false,
        activePort: extractionState.activePort,
        results: {},
        progress: { current: 0, total: properties.length, urls: 0 },
      };
      aborted = false;

      const allResults = {};

      try {
        for (let pi = 0; pi < properties.length; pi++) {
          if (aborted) break;

          const property = properties[pi];
          extractionState.currentProperty = property;

          safeSend({
            type: 'progress',
            phase: 'property',
            property,
            propertyIndex: pi,
            totalProperties: properties.length,
          });

          allResults[property] = {
            coverage: [],
            summary: [],
            history: [],
            sitemapSummary: [],
            sitemapUrls: [],
          };

          // --- INDEX COVERAGE ---
          if (!extractCoverage) {
            safeSend({
              type: 'status',
              message: `Skipping index coverage (disabled) for ${property}`,
            });
          }

          if (extractCoverage) {
          // Step 1: Navigate to the index coverage page
          const coverageUrl = buildGscUrl(property, 'index');
          safeSend({
            type: 'status',
            message: `Navigating to index coverage for ${property}...`,
          });

          await navigateAndCheck(tabId, coverageUrl);

          if (aborted) break;

          // Step 2: Extract report IDs
          safeSend({
            type: 'status',
            message: 'Extracting report IDs...',
          });

          const reports = await sendToContentScript(tabId, {
            action: 'extractReportIDs',
            property,
          });

          safeSend({
            type: 'status',
            message: `Found ${reports?.length || 0} report categories`,
          });

          // Step 2b: Extract indexed pages (ALL_URLS) — the most important report
          if (!aborted) {
            safeSend({
              type: 'status',
              message: 'Extracting indexed pages (ALL_URLS)...',
            });

            const allUrlsPage = buildGscUrl(property, 'index/drilldown', {
              pages: 'ALL_URLS',
            });
            await navigateAndCheck(tabId, allUrlsPage);

            if (!aborted) {
              const heading = await sendToContentScript(tabId, {
                action: 'getPageHeading',
              });

              // Extract total from the page
              let totalCount = 0;
              try {
                totalCount = await sendToContentScript(tabId, {
                  action: 'extractTotalCount',
                });
              } catch {}

              let allUrls = [];
              try {
                allUrls = await sendToContentScript(tabId, {
                  action: 'extractReportUrls', dateFormat,
                  category: heading || 'All indexed pages',
                });
              } catch (e) {
                safeSend({
                  type: 'warning',
                  message: 'Could not extract indexed pages (ALL_URLS)',
                });
              }

              if (allUrls && allUrls.length > 0) {
                allResults[property].coverage.push(...allUrls);
                extractionState.progress.urls += allUrls.length;

                safeSend({
                  type: 'urls',
                  count: allUrls.length,
                  total: allResults[property].coverage.length,
                  reportName: heading || 'All indexed pages',
                });
              }

              allResults[property].summary.push({
                property,
                category: heading || 'All indexed pages',
                urls: allUrls?.length || 0,
                total: totalCount || allUrls?.length || 0,
                ratio: totalCount ? `${allUrls?.length || 0}/${totalCount}` : '',
              });

              // Extract historic chart data
              if (extractHistory) {
                try {
                  const histData = await sendToContentScript(tabId, {
                    action: 'extractHistoricData', dateFormat,
                  });
                  if (histData && histData.length > 0) {
                    const reportName = heading || 'All indexed pages';
                    allResults[property].history.push(
                      ...histData.map(h => ({ property, report: reportName, ...h }))
                    );
                  }
                } catch {}
              }
            }
          }

          if (reports && reports.length > 0) {
            // Step 3: Visit each report and extract URLs
            for (let ri = 0; ri < reports.length; ri++) {
              if (aborted) break;

              const report = reports[ri];

              try {
                // Use item_key for individual report drilldowns
                const reportUrl = buildGscUrl(property, 'index/drilldown', {
                  item_key: report.id,
                });

                safeSend({
                  type: 'progress',
                  phase: 'report',
                  property,
                  propertyIndex: pi,
                  totalProperties: properties.length,
                  reportIndex: ri,
                  totalReports: reports.length,
                  reportId: report.id,
                });

                await navigateAndCheck(tabId, reportUrl);

                if (aborted) break;

                // Get the page heading (report category name)
                const heading = await sendToContentScript(tabId, {
                  action: 'getPageHeading',
                });

                // Extract URLs from this report (first page only, like CLI)
                let pageUrls = [];
                try {
                  pageUrls = await sendToContentScript(tabId, {
                    action: 'extractReportUrls', dateFormat,
                    category: heading || report.id,
                  });
                } catch (e) {
                  safeSend({
                    type: 'warning',
                    message: `Could not extract URLs from report: ${heading || report.id}`,
                  });
                }

                if (pageUrls && pageUrls.length > 0) {
                  allResults[property].coverage.push(...pageUrls);
                  extractionState.progress.urls += pageUrls.length;

                  safeSend({
                    type: 'urls',
                    count: pageUrls.length,
                    total: allResults[property].coverage.length,
                    reportName: heading || report.id,
                  });
                }

                // Extract total count for ratio
                let reportTotal = 0;
                try {
                  reportTotal = await sendToContentScript(tabId, {
                    action: 'extractTotalCount',
                  });
                } catch {}

                // Add to summary with ratio
                allResults[property].summary.push({
                  property,
                  category: heading || report.id,
                  urls: pageUrls?.length || 0,
                  total: reportTotal || pageUrls?.length || 0,
                  ratio: reportTotal ? `${pageUrls?.length || 0}/${reportTotal}` : '',
                });

                // Extract historic chart data
                if (extractHistory) {
                  try {
                    const histData = await sendToContentScript(tabId, {
                      action: 'extractHistoricData', dateFormat,
                    });
                    if (histData && histData.length > 0) {
                      const reportName = heading || report.id;
                      allResults[property].history.push(
                        ...histData.map(h => ({ property, report: reportName, ...h }))
                      );
                    }
                  } catch {}
                }
              } catch (reportErr) {
                safeSend({
                  type: 'warning',
                  message: `Skipped report ${report.id}: ${reportErr.message}`,
                });
              }
            }
          }
          } // end if (extractCoverage)

          // --- SITEMAPS ---
          if (extractSitemaps && !aborted) {
            try {
              safeSend({
                type: 'status',
                message: `Extracting sitemaps for ${property}...`,
              });

              const sitemapsUrl = buildGscUrl(property, 'sitemaps');
              await navigateAndCheck(tabId, sitemapsUrl);

              if (!aborted) {
                const sitemapList = await sendToContentScript(tabId, {
                  action: 'extractSitemapList',
                });

                if (sitemapList && sitemapList.length > 0) {
                  allResults[property].sitemapSummary = sitemapList.map(s => ({
                    property,
                    ...s,
                  }));

                  safeSend({
                    type: 'status',
                    message: `Found ${sitemapList.length} sitemaps`,
                  });

                  // Visit each sitemap for detailed coverage
                  let consecutiveEmpty = 0;
                  const MAX_CONSECUTIVE_EMPTY = 3;

                  for (let si = 0; si < sitemapList.length; si++) {
                    if (aborted) break;

                    const sitemap = sitemapList[si];
                    if (!sitemap.sitemap) continue;

                    // Stop early if too many consecutive sitemaps have no data
                    if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY) {
                      const remaining = sitemapList.length - si;
                      safeSend({
                        type: 'warning',
                        message: `Skipping ${remaining} remaining sitemaps (${MAX_CONSECUTIVE_EMPTY} consecutive had no data)`,
                      });
                      break;
                    }

                    try {
                      safeSend({
                        type: 'progress',
                        phase: 'sitemap',
                        property,
                        sitemapIndex: si,
                        totalSitemaps: sitemapList.length,
                        sitemap: sitemap.sitemap,
                      });

                      // Navigate to sitemap coverage detail via index page
                      const sitemapDetailUrl = buildGscUrl(
                        property,
                        'index',
                        { pages: 'SITEMAP', sitemap: sitemap.sitemap }
                      );
                      await navigateAndCheck(tabId, sitemapDetailUrl);

                      if (aborted) break;

                      const sitemapUrls = await sendToContentScript(tabId, {
                        action: 'extractSitemapCoverage',
                      });

                      if (sitemapUrls && sitemapUrls.length > 0) {
                        consecutiveEmpty = 0;
                        const enrichedUrls = sitemapUrls.map(u => ({
                          property,
                          sitemap: sitemap.sitemap,
                          ...u,
                        }));
                        allResults[property].sitemapUrls.push(...enrichedUrls);
                      } else {
                        consecutiveEmpty++;
                        safeSend({
                          type: 'warning',
                          message: `No data for sitemap: ${sitemap.sitemap} (may be processing)`,
                        });
                      }
                    } catch (sitemapErr) {
                      // Don't count errors as empty — transient failures shouldn't trigger early-stop
                      safeSend({
                        type: 'warning',
                        message: `Skipped sitemap ${sitemap.sitemap}: ${sitemapErr.message}`,
                      });
                    }

                    // 4s delay between sitemaps (matches CLI)
                    if (si < sitemapList.length - 1) {
                      await new Promise(r => setTimeout(r, 4000));
                    }
                  }
                }
              }
            } catch (e) {
              safeSend({
                type: 'warning',
                message: `Sitemap extraction failed: ${e.message}`,
              });
            }
          }

          // Wait between properties
          if (pi < properties.length - 1 && !aborted) {
            await new Promise(r => setTimeout(r, delay));
          }
        }

        // Store results
        extractionState.results = allResults;
        extractionState.running = false;

        await chrome.storage.local.set({
          lastResults: allResults,
          lastExtraction: new Date().toISOString(),
        });

        safeSend({
          type: 'complete',
          results: allResults,
          aborted,
        });
      } catch (e) {
        // Save partial results so user can download what was extracted
        extractionState.results = allResults;
        extractionState.running = false;

        const hasData = Object.values(allResults).some(
          r => r.coverage.length > 0 || r.sitemapUrls.length > 0 || r.history.length > 0
        );

        if (hasData) {
          await chrome.storage.local.set({
            lastResults: allResults,
            lastExtraction: new Date().toISOString(),
          });
          safeSend({
            type: 'complete',
            results: allResults,
            aborted,
            partial: true,
            error: e.message,
          });
        } else {
          safeSend({
            type: 'error',
            message: e.message,
          });
        }
      }
    }
  });
});

// Handle messages from the side panel (non-port)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'getState') {
    sendResponse(extractionState);
    return;
  }

  if (msg.action === 'detectProperties') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!tab) {
          sendResponse({ success: false, error: 'No active tab' });
          return;
        }

        await ensureContentScript(tab.id);
        const properties = await sendToContentScript(tab.id, {
          action: 'detectProperties',
        });
        sendResponse({ success: true, data: properties, tabId: tab.id });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.action === 'getLastResults') {
    chrome.storage.local.get(['lastResults', 'lastExtraction'], data => {
      sendResponse(data);
    });
    return true;
  }
});

