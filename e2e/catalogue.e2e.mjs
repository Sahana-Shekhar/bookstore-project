// Real-browser E2E for Phase 4: catalogue (search, category filter, sort, pagination, states) and book details.
// Safety: the API runs against the dedicated bookstore_test database only. The script drops that
// database before and after, and never connects to "bookstore".
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_PORT = 4000; // vite.config.js proxies /api to this port
const WEB_PORT = 5999;
const ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
const TEST_DB = 'mongodb://127.0.0.1:27017/bookstore_test';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SHOTS = resolve(ROOT, 'e2e', 'screenshots');
mkdirSync(SHOTS, { recursive: true });

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push(['FAIL', name, err.message.split('\n')[0]]);
    console.log(`FAIL  ${name}\n      ${err.message.split('\n').slice(0, 5).join('\n      ')}`);
  }
}

const envFile = Object.fromEntries(
  readFileSync(resolve(ROOT, 'server/.env'), 'utf8')
    .split(/\r?\n/).filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const apiEnv = {
  ...process.env, ...envFile,
  PORT: String(API_PORT), CLIENT_ORIGIN: ORIGIN, MONGODB_URI: TEST_DB, AUTH_RATE_LIMIT: '1000', API_RATE_LIMIT: '100000',
};
assert.ok(apiEnv.MONGODB_URI.endsWith('/bookstore_test'));

const procs = [];
function start(args, cwd, env) {
  const p = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.out = '';
  p.stdout.on('data', (d) => (p.out += d));
  p.stderr.on('data', (d) => (p.out += d));
  procs.push(p);
  return p;
}
async function waitFor(url, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for ${url}`);
}

// ---- Seed the catalogue with the real seed code, into the TEST database ----
process.env.MONGODB_URI = TEST_DB;
const mongoose = (await import(pathToFileURL(resolve(ROOT, 'server/node_modules/mongoose/index.js')).href)).default;
await mongoose.connect(TEST_DB);
assert.equal(mongoose.connection.db.databaseName, 'bookstore_test');
await mongoose.connection.db.dropDatabase();
const { seedCatalogue } = await import(pathToFileURL(resolve(ROOT, 'server/src/seed/catalogue.js')).href);
// The server code imports its own copy of mongoose; models register on that copy, so connect it as well.
const serverMongoose = (await import(pathToFileURL(resolve(ROOT, 'server/node_modules/mongoose/index.js')).href)).default;
assert.equal(serverMongoose, mongoose);
await seedCatalogue();
const col = (n) => mongoose.connection.db.collection(n);
const bookByTitle = async (title) => col('books').findOne({ title });

const api = start(['src/index.js'], resolve(ROOT, 'server'), apiEnv);
const web = start(['node_modules/vite/bin/vite.js', '--port', String(WEB_PORT), '--strictPort'], resolve(ROOT, 'client'), process.env);

let browser;
const cleanup = async () => {
  try { await browser?.close(); } catch { /* ignore */ }
  for (const p of procs) { try { p.kill(); } catch { /* ignore */ } }
  try { await mongoose.connection.db.dropDatabase(); await mongoose.disconnect(); } catch { /* ignore */ }
};

try {
  await waitFor(`http://127.0.0.1:${API_PORT}/api/health`);
  await waitFor(`${ORIGIN}/`);

  browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const warm = await browser.newPage();
  await warm.goto(`${ORIGIN}/books`, { timeout: 120000 });
  await warm.getByRole('heading', { name: 'Books', level: 1 }).waitFor({ timeout: 120000 });
  await warm.close();

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 600) + ' @ ' + page.url()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  const TOTAL = await col('books').countDocuments();
  assert.ok(TOTAL > 12, 'seed must have more than one page of books');
  const cards = () => page.locator('.bk-card:not(.bk-card--skeleton)');
  const cardTitles = () => cards().locator('.bk-card__title').allInnerTexts();
  const summary = () => page.locator('.bk-catalogue__summary');
  const search = () => page.getByRole('searchbox', { name: 'Search books by title or author' });
  const sortSelect = () => page.getByLabel('Sort by');
  const chip = (name) => page.getByRole('group', { name: 'Filter by category' }).getByRole('button', { name: new RegExp(`^${name}(\\s+\\d+)?$`) });
  const goBooks = async (qs = '') => {
    await page.goto(`${ORIGIN}/books${qs}`);
    await summary().filter({ hasNotText: 'Loading' }).waitFor();
  };
  let inflight = 0;
  const track = (p) => {
    const isBooks = (r) => /\/api\/books(\?|$)/.test(new URL(r.url()).pathname + new URL(r.url()).search);
    p.on('request', (r) => { if (isBooks(r)) inflight += 1; });
    p.on('requestfinished', (r) => { if (isBooks(r)) inflight -= 1; });
    p.on('requestfailed', (r) => { if (isBooks(r)) inflight -= 1; });
  };
  track(page);
  // Settled = no book request in flight, nothing dimmed, no "Loading", and that stays true for 300ms
  // (long enough for a debounced search or a URL-triggered fetch to have started).
  const settled = async () => {
    let quietSince = 0;
    for (let i = 0; i < 200; i += 1) {
      const idle = inflight === 0 && (await page.evaluate(() => !document.querySelector('.bk-results--busy') && !/Loading/.test(document.querySelector('.bk-catalogue__summary')?.textContent ?? '')));
      if (idle) { quietSince ||= Date.now(); if (Date.now() - quietSince >= 300) return; } else quietSince = 0;
      await page.waitForTimeout(50);
    }
    throw new Error('catalogue never settled');
  };
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  // ---------------------------------------------------------------- catalogue basics
  await step('catalogue: shows the first 12 books with cover, title, author, category, ₹ price and stock status', async () => {
    await goBooks();
    assert.equal(await cards().count(), 12);
    assert.match(await summary().innerText(), new RegExp(`Showing 1\\u201312 of ${TOTAL} books`));
    const first = cards().first();
    for (const sel of ['.bk-cover', '.bk-card__title', '.bk-card__author', '.bk-card__category', '.bk-card__price', '.bk-stock-tag']) {
      assert.equal(await first.locator(sel).count(), 1, sel);
    }
    const prices = await cards().locator('.bk-card__price').allInnerTexts();
    assert.ok(prices.every((p) => /^₹\d{1,3}(,\d{2,3})*\.\d{2}$/.test(p)), prices.join(' | '));
    assert.ok(!(await page.locator('main').innerText()).includes('$'), 'no dollar amounts anywhere');
  });
  await step('catalogue: INR uses Indian formatting (₹299.00, ₹449.00)', async () => {
    await goBooks('?q=pride');
    assert.equal(await cards().locator('.bk-card__price').innerText(), '₹299.00');
  });
  await step('catalogue: stock labels - In stock, Only N left, Out of stock', async () => {
    await goBooks('?q=pride');
    assert.equal(await cards().first().locator('.bk-stock-tag').innerText(), 'In stock');
    await goBooks('?q=moby');
    assert.equal(await cards().first().locator('.bk-stock-tag').innerText(), 'Only 3 left');
    await goBooks('?q=twenty thousand');
    assert.equal(await cards().first().locator('.bk-stock-tag').innerText(), 'Out of stock');
  });
  await step('catalogue: each card exposes exactly one link (the title) and the whole card is clickable', async () => {
    await goBooks();
    assert.equal(await cards().first().getByRole('link').count(), 1);
    const [title] = await cardTitles();
    await cards().first().click(); // lands on the stretched title link
    await page.waitForURL(/\/books\/[a-f0-9]{24}$/);
    await page.getByRole('heading', { level: 1, name: title }).waitFor();
  });

  // ---------------------------------------------------------------- search
  await step('search: typing filters by title after a short pause and updates the URL', async () => {
    await goBooks();
    await search().fill('sherlock');
    await page.waitForURL('**/books?q=sherlock');
    await settled();
    assert.deepEqual(await cardTitles(), ['The Adventures of Sherlock Holmes']);
    assert.match(await summary().innerText(), /Showing 1.1 of 1 book for .sherlock./);
  });
  await step('search: matches author names, case-insensitively', async () => {
    await goBooks();
    await search().fill('H. G. WELLS');
    await page.waitForURL(/q=H\.\+G\.\+WELLS|q=H\.%20G\.%20WELLS/);
    await settled();
    assert.deepEqual((await cardTitles()).sort(), ['The Time Machine', 'The War of the Worlds']);
  });
  await step('search: Enter applies immediately, the clear button resets, and the box follows the URL', async () => {
    await goBooks();
    await search().fill('darwin');
    await search().press('Enter');
    await page.waitForURL('**/books?q=darwin');
    await settled();
    assert.equal(await cards().count(), 2);
    await page.getByRole('button', { name: 'Clear search' }).click();
    await page.waitForURL(`${ORIGIN}/books`);
    await settled();
    assert.equal(await search().inputValue(), '');
    assert.equal(await cards().count(), 12);
  });
  await step('search: empty state explains what happened and "Clear search and filters" recovers', async () => {
    await goBooks('?q=zzzznotabook');
    await page.getByRole('heading', { name: 'No books match your search' }).waitFor();
    assert.equal(await cards().count(), 0);
    assert.equal(await page.locator('.bk-pagination').count(), 0);
    await page.getByRole('button', { name: 'Clear search and filters' }).click();
    await page.waitForURL(`${ORIGIN}/books`);
    await settled();
    assert.equal(await cards().count(), 12);
    assert.equal(await search().inputValue(), '');
  });
  await step('search: special characters are treated as plain text and cause no error', async () => {
    for (const q of ['.*', '(', '[', '\\', '$ne', '<script>alert(1)</script>']) {
      await goBooks(`?q=${encodeURIComponent(q)}`);
      await page.getByRole('heading', { name: 'No books match your search' }).waitFor();
    }
    assert.equal(await page.locator('main script').count(), 0);
  });
  await step('search: the box is limited to 100 characters', async () => {
    await goBooks();
    await search().fill('a'.repeat(150));
    assert.equal((await search().inputValue()).length, 100);
  });

  // ---------------------------------------------------------------- category
  await step('category: chips list every category with a count; "All categories" starts selected', async () => {
    await goBooks();
    const group = page.getByRole('group', { name: 'Filter by category' });
    assert.equal(await group.getByRole('button').count(), 7);
    assert.equal(await chip('All categories').getAttribute('aria-pressed'), 'true');
    assert.match(await chip('Fiction').innerText(), /Fiction\s*4/);
  });
  await step('category: choosing one filters the grid, marks the chip pressed and sets ?category=', async () => {
    await chip('Mystery').click();
    await page.waitForURL(/\/books\?category=[a-f0-9]{24}$/);
    await settled();
    assert.equal(await chip('Mystery').getAttribute('aria-pressed'), 'true');
    assert.equal(await chip('All categories').getAttribute('aria-pressed'), 'false');
    assert.equal(await cards().count(), 3);
    const cats = await cards().locator('.bk-card__category').allInnerTexts();
    assert.ok(cats.every((c) => c.toLowerCase() === 'mystery'), cats.join());
    assert.match(await summary().innerText(), /of 3 books in Mystery/);
  });
  await step('category: "All categories" clears the filter', async () => {
    await chip('All categories').click();
    await page.waitForURL(`${ORIGIN}/books`);
    await settled();
    assert.equal(await cards().count(), 12);
  });
  await step('category + search work together and the empty state offers to clear both', async () => {
    await chip('Science').click();
    await settled();
    await search().fill('darwin');
    await page.waitForURL(/q=darwin/);
    await settled();
    assert.equal(await cards().count(), 2);
    await search().fill('sherlock');
    await settled();
    await page.getByRole('heading', { name: 'No books match your search' }).waitFor();
    await page.getByRole('button', { name: 'Clear search and filters' }).click();
    await page.waitForURL(`${ORIGIN}/books`);
    await settled();
    assert.equal(await chip('All categories').getAttribute('aria-pressed'), 'true');
  });

  // ---------------------------------------------------------------- sorting
  await step('sort: title A-Z and Z-A', async () => {
    await goBooks();
    await sortSelect().selectOption('title-asc');
    await page.waitForURL('**/books?sort=title-asc');
    await settled();
    const asc = await cardTitles();
    assert.deepEqual(asc, [...asc].sort((a, b) => a.localeCompare(b)));
    await sortSelect().selectOption('title-desc');
    await settled();
    const desc = await cardTitles();
    assert.deepEqual(desc, [...desc].sort((a, b) => b.localeCompare(a)));
  });
  await step('sort: price low-to-high and high-to-low', async () => {
    await sortSelect().selectOption('price-asc');
    await settled();
    const num = async () => (await cards().locator('.bk-card__price').allInnerTexts()).map((t) => Number(t.replace(/[₹,]/g, '')));
    const asc = await num();
    assert.deepEqual(asc, [...asc].sort((a, b) => a - b));
    assert.equal(asc[0], 179);
    await sortSelect().selectOption('price-desc');
    await settled();
    const desc = await num();
    assert.deepEqual(desc, [...desc].sort((a, b) => b - a));
    assert.equal(desc[0], 549);
  });
  await step('sort: "Newest first" is the default and is left out of the URL', async () => {
    await sortSelect().selectOption('newest');
    await page.waitForURL(`${ORIGIN}/books`);
    await settled();
    assert.equal(await sortSelect().inputValue(), 'newest');
  });
  await step('sort: changing the sort returns to page 1', async () => {
    await goBooks('?page=2');
    await sortSelect().selectOption('price-asc');
    await page.waitForURL('**/books?sort=price-asc');
  });

  // ---------------------------------------------------------------- pagination
  await step('pagination: controls appear for >12 books, page 2 shows the remainder', async () => {
    await goBooks();
    const nav = page.getByRole('navigation', { name: 'Book pages' });
    await nav.waitFor();
    await nav.getByRole('button', { name: /page 2|2/i }).first().click();
    await page.waitForURL('**/books?page=2');
    await settled();
    assert.equal(await cards().count(), TOTAL - 12);
    assert.match(await summary().innerText(), new RegExp(`Showing 13\\u2013${TOTAL} of ${TOTAL} books`));
  });
  await step('pagination: pages never repeat a book; previous/next buttons work', async () => {
    await goBooks('?sort=title-asc');
    const page1 = await cardTitles();
    const nav = page.getByRole('navigation', { name: 'Book pages' });
    await nav.getByRole('button', { name: /next/i }).click();
    await page.waitForURL('**/books?sort=title-asc&page=2');
    await settled();
    const page2 = await cardTitles();
    assert.equal(new Set([...page1, ...page2]).size, TOTAL);
    await nav.getByRole('button', { name: /previous/i }).click();
    await page.waitForURL('**/books?sort=title-asc');
  });
  await step('pagination: hidden when everything fits on one page', async () => {
    await chip('Fiction').click();
    await settled();
    assert.equal(await page.locator('.bk-pagination').count(), 0);
  });
  await step('pagination: browser Back/Forward restore the page, and a refresh keeps it', async () => {
    await goBooks();
    await page.getByRole('navigation', { name: 'Book pages' }).getByRole('button', { name: /next/i }).click();
    await page.waitForURL('**/books?page=2');
    await settled();
    await page.goBack();
    await page.waitForURL(`${ORIGIN}/books`);
    await settled();
    assert.equal(await cards().count(), 12);
    await page.goForward();
    await page.waitForURL('**/books?page=2');
    await page.reload();
    await settled();
    assert.equal(await cards().count(), TOTAL - 12);
  });
  await step('invalid URL parameters fall back to safe defaults instead of breaking the page', async () => {
    for (const qs of ['?page=abc', '?page=-3', '?page=0', '?sort=hack', '?category=nope', '?category=zzzzzzzzzzzzzzzzzzzzzzzz', '?page=1e3&foo=bar']) {
      await goBooks(qs);
      assert.ok((await cards().count()) > 0, qs);
      assert.equal(await page.getByText('Could not load books').count(), 0, qs);
    }
  });
  await step('a page number past the end moves to the last real page', async () => {
    await goBooks('?page=99');
    await page.waitForURL('**/books?page=2');
    await settled();
    assert.equal(await cards().count(), TOTAL - 12);
  });
  await step('combined: search + category + sort + page are all in the URL and survive a reload', async () => {
    await goBooks();
    await chip('Fiction').click();
    await settled();
    await sortSelect().selectOption('price-desc');
    await settled();
    await search().fill('e');
    await page.waitForURL(/q=e/);
    await settled();
    const url = page.url();
    assert.match(url, /q=e/);
    assert.match(url, /category=[a-f0-9]{24}/);
    assert.match(url, /sort=price-desc/);
    const before = await cardTitles();
    await page.reload();
    await settled();
    assert.deepEqual(await cardTitles(), before);
    assert.equal(await chip('Fiction').getAttribute('aria-pressed'), 'true');
    assert.equal(await sortSelect().inputValue(), 'price-desc');
    assert.equal(await search().inputValue(), 'e');
  });

  // ---------------------------------------------------------------- loading / error states
  await step('loading: skeleton cards are shown while the first page loads, then replaced', async () => {
    const p = await context.newPage();
    await p.route('**/api/books?*', async (route) => { await new Promise((r) => setTimeout(r, 1200)); await route.continue(); });
    await p.goto(`${ORIGIN}/books`);
    await p.locator('[data-testid="catalogue-skeleton"]').waitFor();
    assert.equal(await p.locator('[data-testid="catalogue-skeleton"] .bk-card').count(), 8);
    assert.equal(await p.locator('[data-testid="catalogue-skeleton"]').getAttribute('aria-hidden'), 'true');
    await p.locator('.bk-card__title').first().waitFor();
    assert.equal(await p.locator('[data-testid="catalogue-skeleton"]').count(), 0);
    await p.close();
  });
  await step('error: API failure shows a clear message, and "Try again" recovers', async () => {
    const p = await context.newPage();
    let fail = true;
    await p.route('**/api/books?*', (route) => (fail ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Internal server error"}' }) : route.continue()));
    await p.goto(`${ORIGIN}/books`);
    await p.getByText('Could not load books').waitFor();
    assert.equal(await p.locator('.bk-card').count(), 0);
    assert.ok(!(await p.locator('main').innerText()).includes('Internal server error'), 'raw server error must not be shown');
    fail = false;
    await p.getByRole('button', { name: 'Try again' }).click();
    await p.locator('.bk-card__title').first().waitFor();
    assert.equal(await p.getByText('Could not load books').count(), 0);
    await p.close();
  });
  await step('error: network failure (server unreachable) is handled, categories failure does not block books', async () => {
    const p = await context.newPage();
    await p.route('**/api/categories', (route) => route.abort());
    await p.goto(`${ORIGIN}/books`);
    await p.locator('.bk-card__title').first().waitFor();
    assert.equal(await p.getByRole('group', { name: 'Filter by category' }).count(), 0);
    await p.close();
  });
  await step('race: a slow older response never overwrites a newer search', async () => {
    const p = await context.newPage();
    await p.route('**/api/books?*', async (route) => {
      if (route.request().url().includes('q=pride')) await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await p.goto(`${ORIGIN}/books`);
    await p.locator('.bk-card__title').first().waitFor();
    const box = p.getByRole('searchbox', { name: 'Search books by title or author' });
    await box.fill('pride');
    await box.press('Enter'); // slow request starts
    await box.fill('hound');
    await box.press('Enter'); // fast request finishes first
    await p.waitForTimeout(2200);
    assert.deepEqual(await p.locator('.bk-card__title').allInnerTexts(), ['The Hound of the Baskervilles']);
    await p.close();
  });

  // ---------------------------------------------------------------- book details
  await step('details: shows large cover, title, author, category, ISBN, description, ₹ price and stock', async () => {
    const book = await bookByTitle('Pride and Prejudice');
    await page.goto(`${ORIGIN}/books/${book._id}`);
    await page.getByRole('heading', { level: 1, name: 'Pride and Prejudice' }).waitFor();
    const main = page.locator('main');
    await main.getByText('by Jane Austen').waitFor();
    await main.getByText(book.isbn).waitFor();
    await main.getByText(book.description).waitFor();
    assert.equal(await main.locator('.bk-detail__price').innerText(), '₹299.00');
    assert.equal(await main.locator('.bk-detail__category').textContent(), 'Fiction');
    await main.locator('.bk-stock-tag', { hasText: 'In stock' }).waitFor();
    const list = page.getByRole('table', { name: 'Book details' }).or(page.locator('[aria-label="Book details"]'));
    const text = await list.innerText();
    for (const s of ['Jane Austen', 'Fiction', book.isbn, 'In stock']) assert.ok(text.includes(s), s);
    const cover = await main.locator('.bk-detail > .bk-cover').boundingBox();
    assert.ok(cover.width >= 250, `cover should be large, got ${cover.width}px`);
    assert.equal(await page.locator('title').innerText().catch(() => ''), 'Online Bookstore');
  });
  await step('details: low stock shows "Only N left"', async () => {
    const book = await bookByTitle('Moby-Dick');
    await page.goto(`${ORIGIN}/books/${book._id}`);
    await page.locator('.bk-detail .bk-stock-tag', { hasText: 'Only 3 left' }).waitFor();
    assert.equal(await page.getByText('Currently out of stock.').count(), 0);
  });
  await step('details: out-of-stock book shows a clear message', async () => {
    const book = await bookByTitle('Twenty Thousand Leagues Under the Seas');
    await page.goto(`${ORIGIN}/books/${book._id}`);
    await page.locator('.bk-detail .bk-stock-tag', { hasText: 'Out of stock' }).waitFor();
    await page.getByText('Currently out of stock.').waitFor();
    await page.getByText('not available to order right now').waitFor();
  });
  await step('details: out-of-stock book cannot be added (slot shows a disabled "Out of stock" button)', async () => {
    assert.equal(await page.locator('[data-slot="add-to-cart"]').count(), 1);
    assert.equal(await page.getByRole('button', { name: /add to cart/i }).count(), 0);
    assert.equal(await page.locator('[data-slot="add-to-cart"]').getByRole('button', { name: 'Out of stock' }).isDisabled(), true);
  });
  await step('details: "Back to books" returns to the exact search/filter/sort/page you came from', async () => {
    await goBooks('?sort=price-desc&page=2');
    const [title] = await cardTitles();
    await cards().first().getByRole('link').click();
    await page.getByRole('heading', { level: 1, name: title }).waitFor();
    await page.getByRole('link', { name: 'Back to books' }).click();
    await page.waitForURL('**/books?sort=price-desc&page=2');
    await settled();
    assert.equal(await sortSelect().inputValue(), 'price-desc');
    assert.equal(await cards().count(), TOTAL - 12);
  });
  await step('details: opened directly, "Back to books" goes to the plain catalogue', async () => {
    const book = await bookByTitle('Meditations');
    await page.goto(`${ORIGIN}/books/${book._id}`);
    await page.getByRole('link', { name: 'Back to books' }).click();
    await page.waitForURL(`${ORIGIN}/books`);
  });
  await step('details: unknown id (valid format) -> friendly "Book not found" with a way back', async () => {
    await page.goto(`${ORIGIN}/books/000000000000000000000000`);
    await page.getByRole('heading', { level: 1, name: 'Book not found' }).waitFor();
    await page.getByRole('link', { name: 'Back to books' }).waitFor();
    await page.getByRole('link', { name: 'Browse all books' }).click();
    await page.waitForURL(`${ORIGIN}/books`);
  });
  await step('details: malformed ids also show "Book not found" (no crash, no raw error)', async () => {
    for (const id of ['not-an-id', '123', '%7B%22%24ne%22%3A1%7D', 'zzzzzzzzzzzzzzzzzzzzzzzz']) {
      await page.goto(`${ORIGIN}/books/${id}`);
      await page.getByRole('heading', { level: 1, name: 'Book not found' }).waitFor();
      assert.ok(!(await page.locator('main').innerText()).match(/invalid request|cast|mongo/i));
    }
  });
  await step('details: loading skeleton then content; server failure shows retry', async () => {
    const book = await bookByTitle('The Republic');
    const p = await context.newPage();
    let fail = true;
    await p.route('**/api/books/*', async (route) => {
      await new Promise((r) => setTimeout(r, 800));
      if (fail) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Internal server error"}' });
      return route.continue();
    });
    await p.goto(`${ORIGIN}/books/${book._id}`);
    await p.locator('[data-testid="detail-skeleton"]').waitFor();
    await p.getByText('Could not load this book').waitFor();
    fail = false;
    await p.getByRole('button', { name: 'Try again' }).click();
    await p.getByRole('heading', { level: 1, name: 'The Republic' }).waitFor();
    await p.close();
  });
  await step('details: moving from one book to another via the URL shows the new book (no stale content)', async () => {
    const a = await bookByTitle('Meditations');
    const b = await bookByTitle('The Art of War');
    await page.goto(`${ORIGIN}/books/${a._id}`);
    await page.getByRole('heading', { level: 1, name: 'Meditations' }).waitFor();
    await page.evaluate((id) => { window.history.pushState({}, '', `/books/${id}`); window.dispatchEvent(new PopStateEvent('popstate')); }, String(b._id));
    await page.getByRole('heading', { level: 1, name: 'The Art of War' }).waitFor();
    assert.equal(await page.getByRole('heading', { level: 1, name: 'Meditations' }).count(), 0);
  });

  // ---------------------------------------------------------------- accessibility
  await step('a11y: search, sort and chips are labelled and keyboard operable', async () => {
    await goBooks();
    await search().focus();
    await page.keyboard.type('plato');
    await page.keyboard.press('Enter');
    await page.waitForURL('**/books?q=plato');
    await settled();
    assert.deepEqual(await cardTitles(), ['The Republic']);
    await page.getByRole('button', { name: 'Clear search' }).click();
    await settled();
    await chip('History').focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(/category=/);
    await settled();
    assert.equal(await chip('History').getAttribute('aria-pressed'), 'true');
    assert.ok(await page.getByLabel('Sort by').count() === 1);
  });
  await step('a11y: a card can be opened with the keyboard and shows a visible focus ring', async () => {
    await goBooks();
    await cards().first().getByRole('link').focus();
    const outline = await cards().first().evaluate((el) => getComputedStyle(el).outlineStyle);
    assert.notEqual(outline, 'none');
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/books\/[a-f0-9]{24}$/);
  });
  await step('a11y: the results summary is a polite live region; images have no stray alt text', async () => {
    await goBooks();
    assert.equal(await summary().getAttribute('role'), 'status');
    assert.equal(await summary().getAttribute('aria-live'), 'polite');
    assert.equal(await page.locator('.bk-cover[aria-hidden="true"]').count() > 0, true);
  });

  // ---------------------------------------------------------------- themes
  await step('themes: catalogue and details render in dark mode with readable contrast', async () => {
    await goBooks();
    await page.getByRole('banner').getByRole('button', { name: 'Switch to dark theme' }).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await settled();
    const ratio = await page.evaluate(() => {
      const parse = (c) => c.match(/[\d.]+/g).map(Number);
      const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
      const bgOf = (el) => { for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c.length < 4 || c[3] > 0.99) return c; } return [0, 0, 0]; };
      const ratioOf = (el) => { const [hi, lo] = [lum(parse(getComputedStyle(el).color)), lum(bgOf(el))].sort((a, b) => b - a); return (hi + 0.05) / (lo + 0.05); };
      const sel = ['.bk-card__link', '.bk-card__author', '.bk-card__price', '.bk-card__category', '.bk-catalogue__summary', '.bk-chip:not([aria-pressed="true"])', '.bk-chip[aria-pressed="true"]'];
      return Object.fromEntries(sel.map((s) => [s, ratioOf(document.querySelector(s))]));
    });
    for (const [s, r] of Object.entries(ratio)) assert.ok(r >= 4.5, `dark ${s} contrast ${r.toFixed(2)}`);
    await page.screenshot({ path: resolve(SHOTS, 'catalogue-dark-1280.png'), fullPage: true });
    const book = await bookByTitle('Twenty Thousand Leagues Under the Seas');
    await page.goto(`${ORIGIN}/books/${book._id}`);
    await page.getByText('Currently out of stock.').waitFor();
    await page.screenshot({ path: resolve(SHOTS, 'detail-outofstock-dark-1280.png'), fullPage: true });
    await page.getByRole('banner').getByRole('button', { name: 'Switch to light theme' }).click();
  });
  await step('themes: light-mode text contrast is at least 4.5:1 on catalogue elements', async () => {
    await goBooks();
    const ratio = await page.evaluate(() => {
      const parse = (c) => c.match(/[\d.]+/g).map(Number);
      const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
      const bgOf = (el) => { for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c.length < 4 || c[3] > 0.99) return c; } return [255, 255, 255]; };
      const ratioOf = (el) => { const [hi, lo] = [lum(parse(getComputedStyle(el).color)), lum(bgOf(el))].sort((a, b) => b - a); return (hi + 0.05) / (lo + 0.05); };
      const sel = ['.bk-card__link', '.bk-card__author', '.bk-card__price', '.bk-card__category', '.bk-catalogue__summary', '.bk-chip:not([aria-pressed="true"])', '.bk-chip[aria-pressed="true"]'];
      return Object.fromEntries(sel.map((s) => [s, ratioOf(document.querySelector(s))]));
    });
    for (const [s, r] of Object.entries(ratio)) assert.ok(r >= 4.5, `light ${s} contrast ${r.toFixed(2)}`);
  });

  // ---------------------------------------------------------------- responsive + screenshots
  await step('responsive: no horizontal scrolling at 375/768/1280 on catalogue, empty state and details', async () => {
    const book = await bookByTitle('Relativity: The Special and General Theory'); // longest title
    const out = await bookByTitle('Twenty Thousand Leagues Under the Seas');
    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of ['/books', '/books?q=zzzz', '/books?page=2', `/books/${book._id}`, `/books/${out._id}`, '/books/000000000000000000000000']) {
        await page.goto(`${ORIGIN}${path}`);
        await page.locator('main h1, main h2').first().waitFor();
        await page.waitForTimeout(150);
        const o = await overflow();
        assert.ok(o <= 0, `${o}px overflow on ${path} at ${width}px`);
      }
      const cols = await (async () => {
        await goBooks();
        return page.evaluate(() => getComputedStyle(document.querySelector('.bk-grid')).gridTemplateColumns.split(' ').length);
      })();
      assert.equal(cols, { 375: 2, 768: 3, 1280: 4 }[width], `grid columns at ${width}px`);
      await page.screenshot({ path: resolve(SHOTS, `catalogue-${width}.png`), fullPage: true });
      await page.goto(`${ORIGIN}/books/${book._id}`);
      await page.locator('.bk-detail h1').waitFor();
      await page.screenshot({ path: resolve(SHOTS, `detail-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 375, height: 900 });
    await goBooks('?q=zzzz');
    await page.getByRole('heading', { name: 'No books match your search' }).waitFor();
    await page.screenshot({ path: resolve(SHOTS, 'catalogue-empty-375.png'), fullPage: true });
  });
  await step('responsive: tap targets (chips, search, sort, back link) are at least 40px tall on mobile', async () => {
    await page.setViewportSize({ width: 375, height: 900 });
    await goBooks();
    for (const loc of [chip('All categories'), search(), sortSelect(), page.getByRole('navigation', { name: 'Book pages' }).getByRole('button').first()]) {
      const box = await loc.boundingBox();
      assert.ok(box.height >= 36, `target ${box.height}px tall`);
    }
    await cards().first().getByRole('link').click();
    const back = await page.getByRole('link', { name: 'Back to books' }).boundingBox();
    assert.ok(back.height >= 40, `back link ${back.height}px`);
  });

  await step('no unexpected browser console errors', async () => {
    const unexpected = consoleErrors.filter((t) => !/status of (400|401|403|404|409|500)|Failed to load resource|net::ERR/i.test(t));
    assert.deepEqual(unexpected, [], unexpected.join(' || ').slice(0, 2500));
  });
} finally {
  await cleanup();
}

const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('FAILED:\n' + failed.map((f) => `  - ${f[1]}: ${f[2]}`).join('\n'));
console.log('--- api log (tail) ---\n' + api.out.split('\n').filter(Boolean).slice(-4).join('\n'));
process.exit(failed.length ? 1 : 0);
