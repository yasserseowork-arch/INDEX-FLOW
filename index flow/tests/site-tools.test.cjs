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
  }
  getBoundingClientRect() { return { width: 100, height: 20 }; }
  getAttribute(name) { return this.attrs[name] || null; }
  querySelectorAll(selector) { return selector === 'a[href]' ? (this.links || []) : []; }
  click() { this.clicked = true; }
}

function createGscHarness({ bodyText = '', rows = [], actions = [], location = 'https://search.google.com/search-console/index?resource_id=sc-domain%3Aexample.com' } = {}) {
  let contentListener;
  const document = {
    body: { innerText: bodyText },
    title: 'Google Search Console',
    querySelector: () => null,
    querySelectorAll(selector) {
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
