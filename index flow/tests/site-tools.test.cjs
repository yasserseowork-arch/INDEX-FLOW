const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');

class FakeHTMLElement {
  constructor(text, attrs = {}) {
    this.innerText = text;
    this.textContent = text;
    this.attrs = attrs;
    this.disabled = false;
    this.clicked = false;
    this.children = [];
  }
  getBoundingClientRect() { return { width: 100, height: 20 }; }
  getAttribute(name) { return this.attrs[name] || null; }
  querySelector(selector) { return selector === 'a[href]' ? (this.links || [])[0] || null : null; }
  querySelectorAll(selector) { return selector === 'a[href]' ? (this.links || []) : []; }
  dispatchEvent() { this.clicked = true; return true; }
  click() { this.clicked = true; }
}

function createGscHarness({ bodyText = '', rows = [], actions = [], propertyOptions = [], location = 'https://search.google.com/search-console/index?resource_id=sc-domain%3Aexample.com' } = {}) {
  let contentListener;
  const document = {
    body: { innerText: bodyText },
    title: 'Google Search Console',
    querySelector(selector) {
      if (selector === "[jsname='iuXDpb']" && propertyOptions.length) return { getAttribute: () => null, childElementCount: 1, children: [{}] };
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "[role='option'], [jsname='iuXDpb'] *, [role='listbox'] *") return propertyOptions;
      if (selector === '[role="row"]' || selector === '[role="row"], table tr') return rows;
      if (selector === 'table tr') return [];
      if (selector.includes('button') || selector.includes('[role=button]') || selector.includes('[role=menuitem]')) return actions;
      if (selector === 'a[href]') return [];
      return [];
    }
  };
  const context = {
    console,
    document,
    window: {},
    location: new URL(location),
    HTMLElement: FakeHTMLElement,
    URL,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    chrome: {
      runtime: {
        onMessage: { addListener(listener) { contentListener = listener; } },
        sendMessage() { return Promise.resolve({ success: true }); }
      }
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    MutationObserver: class {}
  };
  vm.runInNewContext(source, context, { filename: 'content-script.js' });
  return {
    send(message) {
      return new Promise((resolve, reject) => {
        try {
          const keepAlive = contentListener(message, {}, resolve);
          if (keepAlive === false && message.type !== 'GSC_READ_REPORT' && message.type !== 'GSC_READ_SITEMAPS' && message.type !== 'GSC_GET_REPORT_AVAILABILITY') {
            resolve(undefined);
          }
        } catch (error) { reject(error); }
      });
    }
  };
}

test('property picker recognizes bare domain Properties such as aetheer.com', async () => {
  const property = new FakeHTMLElement('aetheer.com موقع إلكتروني في النطاق', { role: 'option' });
  const harness = createGscHarness({
    propertyOptions: [property],
    location: 'https://search.google.com/search-console?resource_id=sc-domain%3Aother-example.com'
  });
  const result = await harness.send({ type: 'SWITCH_PROPERTY', host: 'aetheer.com' });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.resourceId, 'sc-domain:aetheer.com');
});

test('coverage scan extracts Not Started issue rows and makes validation available only when Google exposes its action', async () => {
  const issue = new FakeHTMLElement("Excluded by 'noindex' tag\nWebsite\nNot Started\n4,422");
  const action = new FakeHTMLElement('Start validation');
  const harness = createGscHarness({
    bodyText: "Why pages aren't indexed\nExcluded by 'noindex' tag\nNot Started",
    rows: [issue],
    actions: [action]
  });
  const { data } = await harness.send({ type: 'GSC_READ_REPORT' });
  assert.equal(data.notStartedCount, 1);
  assert.equal(data.rows[0].validation, 'not_started');
  assert.match(data.rows[0].reason, /noindex/i);
  assert.equal(data.canStartValidation, true);

  const result = await harness.send({ type: 'GSC_START_VALIDATION' });
  assert.equal(result.data.started, true);
  assert.equal(action.clicked, true);
});

test('validation action is not clicked if Not Started is absent', async () => {
  const action = new FakeHTMLElement('Start validation');
  const harness = createGscHarness({ bodyText: 'Issue validation Passed', actions: [action] });
  const result = await harness.send({ type: 'GSC_START_VALIDATION' });
  assert.equal(result.data.started, false);
  assert.equal(action.clicked, false);
});

test('sitemap report parser returns sitemap URL, Google status, and discovered page count', async () => {
  const row = new FakeHTMLElement('https://example.com/sitemap-products.xml\nSitemap\nOct 16, 2026\nNov 10, 2026\nSuccess\n1,441');
  const harness = createGscHarness({ rows: [row], location: 'https://search.google.com/search-console/sitemaps?resource_id=sc-domain%3Aexample.com' });
  const { data } = await harness.send({ type: 'GSC_READ_SITEMAPS' });
  assert.equal(data.rowCount, 1);
  assert.match(data.rows[0].sitemap, /sitemap-products\.xml/);
  assert.equal(data.rows[0].status, 'Success');
  assert.equal(data.rows[0].count, '1,441');
});
