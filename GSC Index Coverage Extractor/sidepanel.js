/**
 * Side panel logic for GSC Index Coverage Extractor.
 * Controls the UI, communicates with background service worker,
 * and handles Excel/CSV export.
 */

// DOM Elements
const statusBar = document.getElementById('statusBar');
const statusText = document.getElementById('statusText');
const propertiesSection = document.getElementById('propertiesSection');
const optionsSection = document.getElementById('optionsSection');
const controlsSection = document.getElementById('controlsSection');
const progressSection = document.getElementById('progressSection');
const exportSection = document.getElementById('exportSection');
const propertySearch = document.getElementById('propertySearch');
const propertyList = document.getElementById('propertyList');
const selectedCount = document.getElementById('selectedCount');
const progressProperty = document.getElementById('progressProperty');
const progressReport = document.getElementById('progressReport');
const progressBar = document.getElementById('progressBar');
const progressPercent = document.getElementById('progressPercent');
const progressUrls = document.getElementById('progressUrls');
const exportInfo = document.getElementById('exportInfo');
const logContainer = document.getElementById('logContainer');

// State
let properties = [];
let extractionPort = null;
let extractionResults = null;
let isExtracting = false;

function isGscUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === 'search.google.com' && u.pathname.includes('/search-console');
  } catch { return false; }
}

let activeTabId = null;

// --- Logging ---

function addLog(message, type = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  entry.textContent = `[${time}] ${message}`;
  logContainer.appendChild(entry);
  logContainer.scrollTop = logContainer.scrollHeight;
}

document.getElementById('clearLogBtn').addEventListener('click', () => {
  logContainer.innerHTML = '';
});

// --- Status ---

function setStatus(state, message) {
  statusBar.className = `status-bar status-${state}`;
  statusText.textContent = message;
}

// --- Properties ---

// SVG icons for property tiles (inline, no external requests)
const SVG_DOMAIN = '<svg viewBox="0 0 24 24" fill="none" stroke="#ffb947" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';
const SVG_LINK = '<svg viewBox="0 0 24 24" fill="none" stroke="#ffb947" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
const SVG_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="#072d4b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

function renderProperties(filter = '') {
  propertyList.innerHTML = '';
  const lower = filter.toLowerCase();

  const filtered = properties.filter(p =>
    p.toLowerCase().includes(lower)
  );

  if (filtered.length === 0) {
    propertyList.innerHTML =
      '<div style="padding:14px;color:#5a7a94;text-align:center;font-size:12px">No properties found</div>';
    return;
  }

  for (const prop of filtered) {
    const isDomain = prop.startsWith('sc-domain:');
    const item = document.createElement('div');
    item.className = 'property-item';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = `prop-${encodeURIComponent(prop)}`;
    cb.value = prop;
    cb.addEventListener('change', () => {
      item.classList.toggle('selected', cb.checked);
      updateSelectedCount();
    });

    // Avatar with SVG icon
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.innerHTML = isDomain ? SVG_DOMAIN : SVG_LINK;

    // Details (name + type)
    const details = document.createElement('div');
    details.style.cssText = 'flex:1;min-width:0';

    const label = document.createElement('label');
    label.textContent = prop;

    const typeLabel = document.createElement('div');
    typeLabel.className = 'prop-type';
    typeLabel.textContent = isDomain ? 'Domain property' : 'URL prefix';

    details.appendChild(label);
    details.appendChild(typeLabel);

    // Check selector
    const selector = document.createElement('div');
    selector.className = 'selector';
    selector.innerHTML = SVG_CHECK;

    item.appendChild(cb);
    item.appendChild(avatar);
    item.appendChild(details);
    item.appendChild(selector);

    item.addEventListener('click', e => {
      if (e.target !== cb) {
        cb.checked = !cb.checked;
        item.classList.toggle('selected', cb.checked);
        updateSelectedCount();
      }
    });

    propertyList.appendChild(item);
  }
}

function getSelectedProperties() {
  return Array.from(propertyList.querySelectorAll('input:checked')).map(
    cb => cb.value
  );
}

function updateSelectedCount() {
  const count = getSelectedProperties().length;
  selectedCount.textContent = `${count} selected`;
  document.getElementById('startBtn').disabled = count === 0;
}

propertySearch.addEventListener('input', () => {
  renderProperties(propertySearch.value);
});

document.getElementById('selectAllBtn').addEventListener('click', () => {
  propertyList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = true;
  });
  updateSelectedCount();
});

document.getElementById('deselectAllBtn').addEventListener('click', () => {
  propertyList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = false;
  });
  updateSelectedCount();
});

document.getElementById('refreshBtn').addEventListener('click', detectProperties);
document.getElementById('restartBtn').addEventListener('click', () => {
  // Unhide all sections, hide export, reset progress
  propertiesSection.classList.remove('section-dimmed');
  optionsSection.classList.remove('section-dimmed');
  controlsSection.classList.remove('section-dimmed');
  progressSection.classList.remove('section-dimmed');
  exportSection.style.display = 'none';
  progressSection.style.display = 'none';
  progressBar.style.width = '0%';
  progressPercent.textContent = '0%';
  progressUrls.textContent = '0 URLs extracted';
  setStatus('connected', `Connected — ${properties.length} properties found`);
  addLog('Ready for new extraction', 'info');

  // Show just-completed results in the "Previous results" accordion
  if (extractionResults) {
    showPreviousResults(extractionResults, new Date().toLocaleString());
  }
});

// --- Detection ---

async function detectProperties() {
  addLog('Detecting GSC properties...');
  setStatus('connected', 'Detecting properties...');

  // Remove dimming from previous extraction
  propertiesSection.classList.remove('section-dimmed');
  optionsSection.classList.remove('section-dimmed');
  controlsSection.classList.remove('section-dimmed');
  progressSection.classList.remove('section-dimmed');

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'detectProperties',
    });

    if (response?.success && response.data?.length > 0) {
      properties = response.data;
      activeTabId = response.tabId;

      renderProperties();
      propertiesSection.style.display = '';
      optionsSection.style.display = '';
      controlsSection.style.display = '';

      setStatus('connected', `Connected — ${properties.length} properties found`);
      addLog(`Found ${properties.length} properties`, 'success');
    } else {
      setStatus('connected', 'Connected — navigate to GSC home to detect properties');
      addLog(
        'No properties found. Make sure you are on the GSC home page.',
        'warning'
      );
      propertiesSection.style.display = 'none';
      optionsSection.style.display = 'none';
      controlsSection.style.display = 'none';
    }
  } catch (e) {
    setStatus('disconnected', 'Could not connect to GSC page');
    addLog(`Detection error: ${e.message}`, 'error');
  }
}

// --- Extraction ---

document.getElementById('startBtn').addEventListener('click', startExtraction);
document.getElementById('stopBtn').addEventListener('click', stopExtraction);

function attachPortMessageListener(port) {
  port.onMessage.addListener(msg => {
    switch (msg.type) {
      case 'progress': handleProgress(msg); break;
      case 'status': addLog(msg.message); break;
      case 'urls':
        addLog(`Extracted ${msg.count} URLs from "${msg.reportName}" (total: ${msg.total})`, 'data');
        progressUrls.textContent = `${msg.total} URLs extracted`;
        break;
      case 'warning': addLog(msg.message, 'warning'); break;
      case 'error':
        addLog(`Error: ${msg.message}`, 'error');
        finishExtraction(false);
        break;
      case 'complete':
        extractionResults = msg.results;
        if (msg.partial) {
          addLog(`Partial extraction complete (error: ${msg.error})`, 'warning');
          addLog('Downloaded data is available below', 'success');
        } else {
          addLog(msg.aborted ? 'Extraction stopped by user' : 'Extraction complete!', msg.aborted ? 'warning' : 'success');
        }
        finishExtraction(!msg.aborted);
        break;
    }
  });
}

function setupPortDisconnectHandler(port) {
  port.onDisconnect.addListener(() => {
    if (!isExtracting) return;
    addLog('Connection to background lost. Reconnecting...', 'warning');
    setTimeout(() => {
      if (!isExtracting) return;
      try {
        extractionPort = chrome.runtime.connect({ name: 'extraction' });
        attachPortMessageListener(extractionPort);
        setupPortDisconnectHandler(extractionPort);
        addLog('Reconnected to background service worker', 'success');
      } catch (e) {
        addLog(`Reconnection failed: ${e.message}`, 'error');
        finishExtraction(false);
      }
    }, 500);
  });
}

async function startExtraction() {
  const selected = getSelectedProperties();
  if (selected.length === 0) return;

  isExtracting = true;
  extractionResults = null;

  // UI updates — remove any dimming from previous extraction
  propertiesSection.classList.remove('section-dimmed');
  optionsSection.classList.remove('section-dimmed');
  controlsSection.classList.remove('section-dimmed');
  progressSection.classList.remove('section-dimmed');

  document.getElementById('startBtn').style.display = 'none';
  document.getElementById('stopBtn').style.display = '';
  progressSection.style.display = '';
  exportSection.style.display = 'none';

  setStatus('extracting', 'Extracting...');
  addLog(`Starting extraction for ${selected.length} properties`, 'data');

  // Get options
  const options = {
    extractCoverage: document.getElementById('extractCoverage').checked,
    extractSitemaps: document.getElementById('extractSitemaps').checked,
    extractHistory: document.getElementById('extractHistory').checked,
    delay: parseInt(document.getElementById('delaySelect').value),
    dateFormat: document.getElementById('dateFormatSelect').value,
  };

  // Open port to background service worker
  extractionPort = chrome.runtime.connect({ name: 'extraction' });
  attachPortMessageListener(extractionPort);
  setupPortDisconnectHandler(extractionPort);

  // Start extraction
  extractionPort.postMessage({
    action: 'startExtraction',
    tabId: activeTabId,
    properties: selected,
    options,
  });
}

function handleProgress(msg) {
  if (msg.phase === 'property') {
    progressProperty.textContent = msg.property;
    progressReport.textContent = `Property ${msg.propertyIndex + 1} of ${msg.totalProperties}`;
    const percent = Math.round(
      (msg.propertyIndex / msg.totalProperties) * 100
    );
    progressBar.style.width = `${percent}%`;
    progressPercent.textContent = `${percent}%`;
  } else if (msg.phase === 'report') {
    progressReport.textContent = `Report ${msg.reportIndex + 1} of ${msg.totalReports}`;
    const propProgress =
      (msg.propertyIndex || 0) / (msg.totalProperties || 1);
    const reportProgress =
      (msg.reportIndex / msg.totalReports) *
      (1 / (msg.totalProperties || 1));
    const percent = Math.round((propProgress + reportProgress) * 100);
    progressBar.style.width = `${percent}%`;
    progressPercent.textContent = `${percent}%`;
  } else if (msg.phase === 'sitemap') {
    progressReport.textContent = `Sitemap ${msg.sitemapIndex + 1} of ${msg.totalSitemaps}: ${msg.sitemap}`;
  }
}

function stopExtraction() {
  if (extractionPort) {
    extractionPort.postMessage({ action: 'abort' });
  }
  isExtracting = false;
  addLog('Stopping extraction...', 'warning');
}

function finishExtraction(success) {
  isExtracting = false;
  // Hide previous results banner — fresh results take priority
  document.getElementById('previousResults').style.display = 'none';

  document.getElementById('startBtn').style.display = '';
  document.getElementById('stopBtn').style.display = 'none';

  progressBar.style.width = '100%';
  progressPercent.textContent = '100%';

  if (success) {
    setStatus('complete', 'Finished! Download your results below');
    // Dim non-essential sections — only export, log, and refresh stay active
    propertiesSection.classList.add('section-dimmed');
    optionsSection.classList.add('section-dimmed');
    controlsSection.classList.add('section-dimmed');
    progressSection.classList.add('section-dimmed');
  } else {
    setStatus('connected', 'Extraction stopped');
  }

  if (extractionResults) {
    exportSection.style.display = '';
    const totalUrls = Object.values(extractionResults).reduce(
      (sum, r) => sum + (r.coverage?.length || 0),
      0
    );
    const totalSitemapUrls = Object.values(extractionResults).reduce(
      (sum, r) => sum + (r.sitemapUrls?.length || 0),
      0
    );
    const propCount = Object.keys(extractionResults).length;
    exportInfo.textContent = `${totalUrls} coverage URLs, ${totalSitemapUrls} sitemap URLs across ${propCount} properties`;
    addLog(
      `Extraction complete! ${totalUrls} coverage URLs, ${totalSitemapUrls} sitemap URLs from ${propCount} properties. Use the export buttons to download.`,
      'success'
    );
  }
}

// --- Export ---

document
  .getElementById('exportExcelBtn')
  .addEventListener('click', exportExcel);
document.getElementById('exportCsvBtn').addEventListener('click', exportCsv);

// Per-property export for previous results
async function exportSinglePropertyExcel(property, data) {
  addLog(`Generating Excel for ${property}...`, 'data');
  try {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'GSC Coverage Extractor';
    workbook.created = new Date();
    const { short } = friendlySiteName(property);
    if (data.summary?.length > 0) createExcelTab(workbook, data.summary, `${short}_SUM`);
    if (data.coverage?.length > 0) createExcelTab(workbook, data.coverage, `${short}_COV`);
    if (data.sitemapSummary?.length > 0) createExcelTab(workbook, data.sitemapSummary, `${short}_SUM_MAPS`);
    if (data.sitemapUrls?.length > 0) createExcelTab(workbook, data.sitemapUrls, `${short}_MAPS`);
    if (data.history?.length > 0) createExcelTab(workbook, data.history, `${short}_HIST`);
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: `gsc-index-${short}_${currentDate()}.xlsx`, saveAs: true });
    addLog(`Excel file for ${property} ready`, 'success');
  } catch (e) {
    addLog(`Excel export error: ${e.message}`, 'error');
  }
}

function exportSinglePropertyCsv(property, data) {
  addLog(`Generating CSV for ${property}...`, 'data');
  try {
    const { short } = friendlySiteName(property);
    if (data.coverage?.length > 0) {
      const rows = data.coverage.map(row => ({ property, ...row }));
      downloadCsv(rows, `gsc-index-${short}_coverage_${currentDate()}.csv`);
    }
    if (data.sitemapUrls?.length > 0) {
      downloadCsv(data.sitemapUrls, `gsc-index-${short}_sitemaps_${currentDate()}.csv`);
    }
    addLog(`CSV files for ${property} ready`, 'success');
  } catch (e) {
    addLog(`CSV export error: ${e.message}`, 'error');
  }
}

async function exportExcel() {
  if (!extractionResults) return;

  addLog('Generating Excel file...', 'data');

  try {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'GSC Coverage Extractor';
    workbook.created = new Date();

    for (const [property, data] of Object.entries(extractionResults)) {
      const { short } = friendlySiteName(property);

      if (data.summary?.length > 0) createExcelTab(workbook, data.summary, `${short}_SUM`);
      if (data.coverage?.length > 0) createExcelTab(workbook, data.coverage, `${short}_COV`);
      if (data.sitemapSummary?.length > 0) createExcelTab(workbook, data.sitemapSummary, `${short}_SUM_MAPS`);
      if (data.sitemapUrls?.length > 0) createExcelTab(workbook, data.sitemapUrls, `${short}_MAPS`);
      if (data.history?.length > 0) createExcelTab(workbook, data.history, `${short}_HIST`);
    }

    // Generate and download
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const props = Object.keys(extractionResults);
    const namePart = props.length === 1
      ? friendlySiteName(props[0]).short
      : `${friendlySiteName(props[0]).short}_+${props.length - 1}`;
    const filename = `gsc-index-${namePart}_${currentDate()}.xlsx`;

    chrome.downloads.download({
      url,
      filename,
      saveAs: true,
    });

    addLog(`Excel file "${filename}" ready for download`, 'success');
  } catch (e) {
    addLog(`Excel export error: ${e.message}`, 'error');
  }
}

function createExcelTab(workbook, data, sheetName) {
  if (!data || data.length === 0) return;

  // Truncate sheet name to 31 chars (Excel limit)
  const name = sheetName.substring(0, 31);
  const sheet = workbook.addWorksheet(name);

  // Add headers
  const headers = Object.keys(data[0]);
  sheet.addRow(headers);

  // Style header row
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1A73E8' },
  };

  // Add data rows
  for (const row of data) {
    sheet.addRow(headers.map(h => row[h] ?? ''));
  }

  // Auto-width columns
  for (let i = 0; i < headers.length; i++) {
    const col = sheet.getColumn(i + 1);
    let maxLength = headers[i].length;
    for (const row of data) {
      const val = String(row[headers[i]] ?? '');
      if (val.length > maxLength) maxLength = val.length;
    }
    col.width = Math.min(maxLength + 2, 120);
  }
}

function exportCsv() {
  if (!extractionResults) return;

  addLog('Generating CSV files...', 'data');

  try {
    const allCoverage = [];
    const allSitemaps = [];
    const allHistory = [];

    for (const [property, data] of Object.entries(extractionResults)) {
      if (data.coverage) {
        allCoverage.push(...data.coverage.map(row => ({ property, ...row })));
      }
      if (data.sitemapUrls) {
        allSitemaps.push(...data.sitemapUrls);
      }
      if (data.history) {
        allHistory.push(...data.history);
      }
    }

    const props = Object.keys(extractionResults);
    const namePart = props.length === 1
      ? friendlySiteName(props[0]).short
      : `${friendlySiteName(props[0]).short}_+${props.length - 1}`;

    if (allCoverage.length > 0) {
      downloadCsv(allCoverage, `gsc-index-${namePart}_coverage_${currentDate()}.csv`);
    }

    if (allSitemaps.length > 0) {
      downloadCsv(allSitemaps, `gsc-index-${namePart}_sitemaps_${currentDate()}.csv`);
    }

    if (allHistory.length > 0) {
      downloadCsv(allHistory, `gsc-index-${namePart}_history_${currentDate()}.csv`);
    }

    addLog('CSV files ready for download', 'success');
  } catch (e) {
    addLog(`CSV export error: ${e.message}`, 'error');
  }
}

function downloadCsv(data, filename) {
  const csv = jsonToCsv(data);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  chrome.downloads.download({
    url,
    filename,
    saveAs: true,
  });
}

/**
 * Populate and show the "Previous results" accordion from stored data.
 */
function showPreviousResults(results, dateStr) {
  const listEl = document.getElementById('previousResultsList');
  listEl.innerHTML = '';
  for (const [prop, data] of Object.entries(results)) {
    const urlCount = (data.coverage?.length || 0) + (data.sitemapUrls?.length || 0);
    const line = document.createElement('div');
    line.className = 'previous-results-item';
    const propName = document.createElement('span');
    propName.className = 'prop-name';
    propName.textContent = prop;
    const propMeta = document.createElement('span');
    propMeta.className = 'prop-meta';
    propMeta.textContent = ` (${dateStr}): ${urlCount} URLs`;
    const linksDiv = document.createElement('div');
    linksDiv.className = 'previous-results-links';
    linksDiv.innerHTML = `<a href="#" class="previous-results-link prev-excel">Excel</a>` +
      `<span class="previous-results-sep">|</span>` +
      `<a href="#" class="previous-results-link prev-csv">CSV</a>`;
    line.append(propName, propMeta, linksDiv);
    line.querySelector('.prev-excel').addEventListener('click', e => {
      e.preventDefault();
      exportSinglePropertyExcel(prop, data);
    });
    line.querySelector('.prev-csv').addEventListener('click', e => {
      e.preventDefault();
      exportSinglePropertyCsv(prop, data);
    });
    listEl.appendChild(line);
  }
  document.getElementById('previousResults').style.display = '';
}

// --- Initialization ---

async function init() {
  addLog('Initializing...');

  // Check if active tab is a GSC page
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (isGscUrl(tab?.url)) {
      activeTabId = tab.id;
      setStatus('connected', 'Connected to GSC');
      addLog('GSC page detected');
      await detectProperties();
    } else {
      setStatus('disconnected', 'Not on a GSC page');
      addLog(
        'Navigate to Google Search Console to begin',
        'warning'
      );
    }
  } catch (e) {
    setStatus('disconnected', 'Could not detect page');
    addLog(`Init error: ${e.message}`, 'error');
  }

  // Load saved settings
  try {
    const settings = await chrome.storage.local.get([
      'extractCoverage',
      'extractSitemaps',
      'extractHistory',
      'delay',
      'dateFormat',
    ]);
    if (settings.extractCoverage !== undefined) {
      document.getElementById('extractCoverage').checked =
        settings.extractCoverage;
    }
    if (settings.extractSitemaps !== undefined) {
      document.getElementById('extractSitemaps').checked =
        settings.extractSitemaps;
    }
    if (settings.extractHistory !== undefined) {
      document.getElementById('extractHistory').checked =
        settings.extractHistory;
    }
    if (settings.delay !== undefined) {
      document.getElementById('delaySelect').value = settings.delay;
    }
    if (settings.dateFormat !== undefined) {
      document.getElementById('dateFormatSelect').value = settings.dateFormat;
    }
  } catch {}

  // Save settings on change
  for (const id of ['extractSitemaps', 'extractCoverage', 'extractHistory']) {
    document.getElementById(id).addEventListener('change', saveSettings);
  }
  document
    .getElementById('delaySelect')
    .addEventListener('change', saveSettings);
  document
    .getElementById('dateFormatSelect')
    .addEventListener('change', saveSettings);

  // Check for previous results — show as accordion
  try {
    const { lastResults, lastExtraction } =
      await chrome.storage.local.get(['lastResults', 'lastExtraction']);
    if (lastResults && lastExtraction) {
      extractionResults = lastResults;
      showPreviousResults(lastResults, new Date(lastExtraction).toLocaleString());
      addLog('Previous extraction results available for download');
    }
  } catch {}
}

function saveSettings() {
  chrome.storage.local.set({
    extractCoverage: document.getElementById('extractCoverage').checked,
    extractSitemaps: document.getElementById('extractSitemaps').checked,
    extractHistory: document.getElementById('extractHistory').checked,
    delay: document.getElementById('delaySelect').value,
    dateFormat: document.getElementById('dateFormatSelect').value,
  });
}

// Listen for tab changes to re-detect
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && !isExtracting) {
    if (isGscUrl(tab.url)) {
      activeTabId = tabId;
      setStatus('connected', 'Connected to GSC');
    }
  }
});

// Start
init();
