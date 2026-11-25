// Real-browser E2E for Phase 5: shopping cart (guest, localStorage, stock limits, validation against the API).
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
const CART_KEY = 'bookstore_cart';

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
await seedCatalogue();
const books = mongoose.connection.db.collection('books');
const authors = mongoose.connection.db.collection('authors');
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
const money = (paise) => inr.format(paise / 100);

// Three in-stock books with known stock, plus the seeded out-of-stock one.
const pool = await books.find({ stock: { $gt: 5 } }).sort({ title: 1 }).limit(3).toArray();
const [bookA, bookB, bookC] = pool.map((b) => ({ id: b._id.toString(), title: b.title, price: b.priceCents, authorId: b.author }));
for (const b of [bookA, bookB, bookC]) b.author = (await authors.findOne({ _id: b.authorId })).name;
const out = await books.findOne({ title: 'Twenty Thousand Leagues Under the Seas' });
const outBook = { id: out._id.toString(), title: out.title, price: out.priceCents };
assert.equal(out.stock, 0);
const GHOST = '000000000000000000000001';
const setStock = (b, stock) => books.updateOne({ _id: new mongoose.Types.ObjectId(b.id) }, { $set: { stock } });

const api = start(['src/index.js'], resolve(ROOT, 'server'), apiEnv);
const web = start(['node_modules/vite/bin/vite.js', '--port', String(WEB_PORT), '--strictPort'], resolve(ROOT, 'client'), process.env);

let browser;
const contexts = [];
const consoleErrors = [];
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

  // A brand-new browser profile = a brand-new guest with empty storage.
  const newPage = async ({ width = 1280, scheme = 'light', storageState } = {}) => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, storageState });
    contexts.push(ctx);
    const p = await ctx.newPage();
    p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 600) + ' @ ' + p.url()); });
    p.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    return p;
  };
  // Puts raw text in localStorage BEFORE the app reads it (visit a page, write, then reload on /cart).
  const seedStorage = async (p, raw, path = '/cart') => {
    await p.goto(`${ORIGIN}/about`);
    await p.evaluate(([k, v]) => localStorage.setItem(k, v), [CART_KEY, raw]);
    await p.goto(`${ORIGIN}${path}`);
  };
  const cartJson = (...items) => JSON.stringify({ v: 1, items: items.map(([b, quantity]) => ({ bookId: b.id ?? b, quantity })) });
  const stored = (p) => p.evaluate((k) => localStorage.getItem(k), CART_KEY);
  const storedItems = async (p) => JSON.parse(await stored(p)).items;
  const banner = (p) => p.getByRole('banner');
  const badge = (p) => banner(p).locator('[data-testid="cart-count"]:visible');
  const lines = (p) => p.getByTestId('cart-line');
  const line = (p, b) => lines(p).filter({ hasText: b.title });
  const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const openBook = async (p, b) => {
    await p.goto(`${ORIGIN}/books/${b.id}`);
    await p.locator('.bk-detail h1').waitFor();
  };
  const addBtn = (p) => p.getByRole('button', { name: 'Add to cart' });
  const cartReady = async (p) => { await lines(p).first().waitFor(); };

  await setStock(bookA, 3);
  await setStock(bookB, 10);
  await setStock(bookC, 1);

  // ---------------------------------------------------------------- empty + guest add
  let page = await newPage();
  await step('empty cart: no header badge, nothing stored, friendly empty state with a link to books', async () => {
    await page.goto(`${ORIGIN}/cart`);
    await page.getByRole('heading', { name: 'Cart', level: 1 }).waitFor();
    await page.getByTestId('cart-empty').waitFor();
    assert.equal(await badge(page).count(), 0);
    assert.equal(await stored(page), null);
    assert.equal(await banner(page).getByRole('link', { name: 'Cart', exact: true }).first().isVisible(), true);
    await page.getByRole('link', { name: 'Browse books' }).click();
    await page.waitForURL('**/books');
  });

  await step('guest (not logged in) can add a book from its details page; header count appears', async () => {
    await openBook(page, bookB);
    await addBtn(page).click();
    await page.getByTestId('in-cart-note').filter({ hasText: '1 in your cart' }).waitFor();
    await page.getByText('Added to your cart. You now have 1.').waitFor({ state: 'attached' });
    assert.equal((await badge(page).first().innerText()).trim(), '1');
    assert.equal(await banner(page).getByRole('link', { name: 'Cart, 1 item' }).count() > 0, true);
    assert.equal(await page.getByRole('link', { name: 'View cart' }).isVisible(), true);
  });

  await step('adding again increases the quantity and the header count', async () => {
    await addBtn(page).click();
    await page.getByTestId('in-cart-note').filter({ hasText: '2 in your cart' }).waitFor();
    assert.equal((await badge(page).first().innerText()).trim(), '2');
    await banner(page).getByRole('link', { name: 'Cart, 2 items' }).first().waitFor();
  });

  await step('localStorage holds only book ids and quantities: no prices, titles, tokens or secrets', async () => {
    const raw = await stored(page);
    assert.deepEqual(JSON.parse(raw), { v: 1, items: [{ bookId: bookB.id, quantity: 2 }] });
    const all = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
    assert.ok(!/token|csrf|jwt|password|priceCents|title/i.test(all), all);
    assert.equal(await page.evaluate(() => document.cookie), '');
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).length), 0);
  });

  await step('stock limit on the details page: Add is disabled at the maximum and says why', async () => {
    await openBook(page, bookA); // stock 3
    for (let i = 1; i <= 3; i += 1) await addBtn(page).click();
    await page.getByText('Added to your cart. You have all 3 available copies.').waitFor({ state: 'attached' });
    assert.equal(await addBtn(page).isDisabled(), true);
    await page.getByTestId('in-cart-note').filter({ hasText: '3 in your cart (maximum available: 3)' }).waitFor();
    assert.equal((await storedItems(page)).find((i) => i.bookId === bookA.id).quantity, 3);
    assert.equal((await badge(page).first().innerText()).trim(), '5');
  });

  // ---------------------------------------------------------------- cart page
  await step('cart page: title, author, ₹ unit price, quantity, line total, stock, subtotal and total', async () => {
    await page.getByRole('banner').getByRole('link', { name: /^Cart/ }).first().click();
    await page.waitForURL('**/cart');
    await page.getByRole('heading', { name: 'Cart', level: 1 }).waitFor();
    await cartReady(page);
    assert.equal(await lines(page).count(), 2);
    const a = line(page, bookA);
    const b = line(page, bookB);
    await a.getByRole('link', { name: bookA.title }).waitFor();
    assert.ok((await a.innerText()).includes(`by ${bookA.author}`));
    assert.ok((await a.innerText()).includes(`${money(bookA.price)} each`));
    assert.equal(await a.getByTestId('line-qty').innerText(), '3');
    assert.equal((await a.getByTestId('line-total').innerText()).replace('Line total:', '').trim(), money(bookA.price * 3));
    assert.equal(await a.getByTestId('line-stock').innerText(), '3 in stock');
    assert.equal(await b.getByTestId('line-qty').innerText(), '2');
    assert.equal(await b.getByTestId('line-stock').innerText(), '10 in stock');
    const sum = bookA.price * 3 + bookB.price * 2;
    assert.equal(await page.getByTestId('summary-subtotal').innerText(), money(sum));
    assert.equal(await page.getByTestId('summary-total').innerText(), money(sum));
    assert.equal(await page.getByTestId('summary-units').innerText(), '5');
    assert.ok(/^₹\d{1,3}(,\d{2,3})*\.\d{2}$/.test(await page.getByTestId('summary-total').innerText()));
    assert.equal(await page.locator('main h1').count(), 1);
  });

  await step('cart page: at maximum stock "+" is disabled with a visible reason; "-" lowers and totals follow', async () => {
    const a = line(page, bookA);
    assert.equal(await a.getByRole('button', { name: `Increase quantity of ${bookA.title}` }).isDisabled(), true);
    await a.getByTestId('line-limit').filter({ hasText: 'Maximum available (3)' }).waitFor();
    await a.getByRole('button', { name: `Decrease quantity of ${bookA.title}` }).click();
    assert.equal(await a.getByTestId('line-qty').innerText(), '2');
    assert.equal(await a.getByTestId('line-limit').count(), 0);
    assert.equal(await page.getByTestId('summary-total').innerText(), money(bookA.price * 2 + bookB.price * 2));
    assert.equal((await badge(page).first().innerText()).trim(), '4');
    await page.getByText(`Quantity of ${bookA.title} is 2.`).waitFor({ state: 'attached' });
  });

  await step('cart page: quantity never goes below 1 ("-" disabled at 1) and "+" works up to stock', async () => {
    const a = line(page, bookA);
    const minus = a.getByRole('button', { name: `Decrease quantity of ${bookA.title}` });
    const plus = a.getByRole('button', { name: `Increase quantity of ${bookA.title}` });
    await minus.click();
    assert.equal(await a.getByTestId('line-qty').innerText(), '1');
    assert.equal(await minus.isDisabled(), true);
    await plus.click();
    await plus.click();
    assert.equal(await a.getByTestId('line-qty').innerText(), '3');
    assert.equal(await plus.isDisabled(), true);
    assert.equal((await storedItems(page)).find((i) => i.bookId === bookA.id).quantity, 3);
  });

  await step('cart page: remove deletes one book, updates totals, header and storage', async () => {
    await line(page, bookA).getByRole('button', { name: /^Remove/ }).click();
    await lines(page).filter({ hasText: bookA.title }).waitFor({ state: 'detached' });
    assert.equal(await lines(page).count(), 1);
    assert.equal(await page.getByTestId('summary-total').innerText(), money(bookB.price * 2));
    assert.equal((await badge(page).first().innerText()).trim(), '2');
    assert.deepEqual(await storedItems(page), [{ bookId: bookB.id, quantity: 2 }]);
  });

  await step('cart page: clear cart asks first; cancel keeps items, confirm empties cart, badge and storage', async () => {
    await page.getByRole('button', { name: 'Clear cart' }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await lines(page).count(), 1);
    await page.getByRole('button', { name: 'Clear cart' }).click();
    await page.getByRole('button', { name: 'Yes, clear cart' }).click();
    await page.getByTestId('cart-empty').waitFor();
    assert.equal(await badge(page).count(), 0);
    assert.equal(await stored(page), null);
  });

  // ---------------------------------------------------------------- persistence
  await step('cart survives a refresh, and a full browser restart (new context with the same storage)', async () => {
    await seedStorage(page, cartJson([bookA, 2], [bookC, 1]));
    await cartReady(page);
    await page.reload();
    await cartReady(page);
    assert.equal(await lines(page).count(), 2);
    assert.equal((await badge(page).first().innerText()).trim(), '3');
    await page.goto(`${ORIGIN}/books`);
    assert.equal((await badge(page).first().innerText()).trim(), '3');

    const state = await page.context().storageState();
    const reopened = await newPage({ storageState: state });
    await reopened.goto(`${ORIGIN}/cart`);
    await cartReady(reopened);
    assert.equal(await line(reopened, bookA).getByTestId('line-qty').innerText(), '2');
    assert.equal((await badge(reopened).first().innerText()).trim(), '3');
    await reopened.context().close();
  });

  await step('theme choice and cart do not interfere (switching theme keeps the cart)', async () => {
    await page.goto(`${ORIGIN}/cart`);
    await cartReady(page);
    await banner(page).getByRole('button', { name: 'Switch to dark theme' }).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    const keys = await page.evaluate(() => Object.keys(localStorage).sort());
    assert.deepEqual(keys, [CART_KEY, 'bookstore_theme']);
    await page.reload();
    await cartReady(page);
    await banner(page).getByRole('button', { name: 'Switch to light theme' }).click();
  });

  await step('two tabs stay in step: a change in one tab updates the header count in the other', async () => {
    const other = await page.context().newPage();
    await other.goto(`${ORIGIN}/cart`);
    await cartReady(other);
    await line(other, bookA).getByRole('button', { name: `Increase quantity of ${bookA.title}` }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="cart-count"]')?.textContent === '4');
    await other.close();
  });

  // ---------------------------------------------------------------- data correctness
  await step('prices, titles and stock in localStorage are never trusted: the API values are shown', async () => {
    const p = await newPage();
    const tampered = JSON.stringify({
      v: 1,
      items: [{ bookId: bookB.id, quantity: 2, priceCents: 1, title: 'HACKED', stock: 9999, price: 0 }],
    });
    await seedStorage(p, tampered);
    await cartReady(p);
    assert.equal(await line(p, bookB).count(), 1);
    assert.equal(await p.getByText('HACKED').count(), 0);
    assert.equal(await p.getByTestId('summary-total').innerText(), money(bookB.price * 2));
    // Any later change rewrites the stored cart in its clean form.
    await line(p, bookB).getByRole('button', { name: `Increase quantity of ${bookB.title}` }).click();
    assert.deepEqual(JSON.parse(await stored(p)), { v: 1, items: [{ bookId: bookB.id, quantity: 3 }] });
    await p.context().close();
  });

  await step('a quantity above stock in storage is lowered to stock, with an explanation, and saved', async () => {
    const p = await newPage();
    await seedStorage(p, cartJson([bookC, 7])); // stock is 1
    await cartReady(p);
    assert.equal(await line(p, bookC).getByTestId('line-qty').innerText(), '1');
    await p.getByText(/Only 1 copy of .* is in stock, so the quantity was lowered to 1/).waitFor();
    assert.deepEqual(await storedItems(p), [{ bookId: bookC.id, quantity: 1 }]);
    assert.equal(await p.getByTestId('summary-total').innerText(), money(bookC.price));
    await p.context().close();
  });

  await step('stock reduced after adding: quantity is lowered when the cart page loads', async () => {
    const p = await newPage();
    await seedStorage(p, cartJson([bookB, 6]));
    await cartReady(p);
    assert.equal(await line(p, bookB).getByTestId('line-qty').innerText(), '6');
    await setStock(bookB, 4);
    await p.reload();
    await cartReady(p);
    assert.equal(await line(p, bookB).getByTestId('line-qty').innerText(), '4');
    await p.getByText(/Only 4 copies of .* are in stock, so the quantity was lowered to 4/).waitFor();
    assert.equal(await p.getByTestId('summary-total').innerText(), money(bookB.price * 4));
    await setStock(bookB, 10);
    await p.context().close();
  });

  await step('a deleted/unknown book is removed with a notice; the rest of the cart stays', async () => {
    const p = await newPage();
    await seedStorage(p, cartJson([GHOST, 2], [bookC, 1]));
    await cartReady(p);
    await p.getByText('A book in your cart is no longer available and was removed.').waitFor();
    assert.equal(await lines(p).count(), 1);
    assert.deepEqual(await storedItems(p), [{ bookId: bookC.id, quantity: 1 }]);
    assert.equal((await badge(p).first().innerText()).trim(), '1');
    await p.context().close();
  });

  await step('a cart holding only a deleted book ends up empty (storage key removed)', async () => {
    const p = await newPage();
    await seedStorage(p, cartJson([GHOST, 1]));
    await p.getByTestId('cart-empty').waitFor();
    assert.equal(await stored(p), null);
    assert.equal(await badge(p).count(), 0);
    await p.context().close();
  });

  await step('an out-of-stock book is flagged, has no quantity controls, is left out of the total and can be removed', async () => {
    const p = await newPage();
    await seedStorage(p, cartJson([outBook, 2], [bookC, 1]));
    await cartReady(p);
    await lines(p).nth(1).waitFor();
    const o = line(p, outBook);
    assert.ok((await o.innerText()).includes('Out of stock'));
    assert.equal(await o.getByTestId('line-stock').innerText(), 'Out of stock: not included in the total.');
    assert.equal(await o.getByRole('button', { name: /Increase quantity/ }).count(), 0);
    assert.equal(await o.getByTestId('line-total').innerText(), 'Unavailable');
    assert.equal(await p.getByTestId('summary-total').innerText(), money(bookC.price));
    assert.equal(await p.getByTestId('summary-units').innerText(), '1');
    await p.getByText(/Unavailable or unchecked books are not included/).waitFor();
    await p.screenshot({ path: resolve(SHOTS, 'cart-outofstock-1280.png'), fullPage: true });
    await o.getByRole('button', { name: /^Remove/ }).click();
    await lines(p).filter({ hasText: outBook.title }).waitFor({ state: 'detached' });
    assert.deepEqual(await storedItems(p), [{ bookId: bookC.id, quantity: 1 }]);
    await p.context().close();
  });

  await step('a book that became out of stock after it was added is kept but not sellable', async () => {
    const p = await newPage();
    await setStock(bookC, 0);
    await seedStorage(p, cartJson([bookC, 1]));
    await cartReady(p);
    assert.equal(await line(p, bookC).getByTestId('line-total').innerText(), 'Unavailable');
    assert.equal(await p.getByTestId('summary-total').innerText(), money(0));
    assert.deepEqual(await storedItems(p), [{ bookId: bookC.id, quantity: 1 }]);
    await openBook(p, bookC);
    assert.equal(await p.locator('[data-slot="add-to-cart"]').getByRole('button', { name: 'Out of stock' }).isDisabled(), true);
    await p.locator('[data-slot="add-to-cart"]').getByRole('link', { name: 'Review your cart' }).waitFor();
    await setStock(bookC, 1);
    await p.context().close();
  });

  await step('corrupted storage never breaks the app: it starts empty and clears the bad value', async () => {
    const samples = ['not json', '{"v":1,"items":', 'null', '[]', '{"v":9,"items":[]}', '{"v":1,"items":"x"}', '\u0000\u0001'];
    for (const raw of samples) {
      const p = await newPage();
      await seedStorage(p, raw);
      await p.getByTestId('cart-empty').waitFor();
      assert.equal(await stored(p), null, `bad value ${JSON.stringify(raw)} should be cleared`);
      assert.equal(await badge(p).count(), 0);
      await p.context().close();
    }
  });

  await step('malformed lines are dropped, good lines kept; injection-style ids are ignored', async () => {
    const p = await newPage();
    const raw = JSON.stringify({
      v: 1,
      items: [
        { bookId: bookC.id, quantity: 1 },
        { bookId: '../../etc/passwd', quantity: 1 },
        { bookId: { $gt: '' }, quantity: 1 },
        { bookId: '<script>alert(1)</script>', quantity: 1 },
        { bookId: bookB.id, quantity: -4 },
        { bookId: bookB.id, quantity: 'many' },
        { bookId: bookB.id, quantity: 2.5 },
        null,
      ],
    });
    const requests = [];
    p.on('request', (r) => { if (r.url().includes('/api/books/')) requests.push(r.url()); });
    await seedStorage(p, raw);
    await cartReady(p);
    assert.equal(await lines(p).count(), 1);
    const unique = [...new Set(requests)]; // React StrictMode runs effects twice in dev
    assert.equal(unique.length, 1, unique.join(' '));
    assert.ok(unique[0].endsWith(`/api/books/${bookC.id}`));
    await p.context().close();
  });

  await step('cart is capped at 20 different books and 99 copies of one book', async () => {
    const p = await newPage();
    const many = Array.from({ length: 30 }, (_, i) => ({ bookId: i.toString(16).padStart(24, '0'), quantity: 1 }));
    await seedStorage(p, JSON.stringify({ v: 1, items: [...many, { bookId: bookB.id, quantity: 500 }] }));
    await p.getByTestId('cart-empty').or(lines(p).first()).waitFor();
    await p.waitForTimeout(500);
    assert.equal(await p.getByTestId('cart-empty').count(), 1); // 20 unknown ids -> all removed
    await p.context().close();
  });

  await step('while prices load a skeleton shows; if the API fails the line says so, offers retry and stays out of the total', async () => {
    const p = await newPage();
    await p.route(`**/api/books/${bookB.id}`, async (route) => {
      await new Promise((r) => setTimeout(r, 900));
      await route.abort();
    });
    await seedStorage(p, cartJson([bookB, 2]));
    await p.getByTestId('cart-skeleton').waitFor();
    await p.getByText('We could not check its current price and stock').waitFor();
    assert.equal(await p.getByTestId('summary-total').innerText(), money(0));
    assert.deepEqual(await storedItems(p), [{ bookId: bookB.id, quantity: 2 }]); // nothing is lost
    await p.unroute(`**/api/books/${bookB.id}`);
    await p.getByRole('button', { name: 'Try again' }).click();
    await line(p, bookB).getByTestId('line-qty').waitFor();
    assert.equal(await p.getByTestId('summary-total').innerText(), money(bookB.price * 2));
    await p.context().close();
  });

  await step('cart UI has no checkout, payment or order controls yet', async () => {
    const p = await newPage();
    await seedStorage(p, cartJson([bookB, 1]));
    await cartReady(p);
    assert.equal(await p.getByRole('button', { name: /checkout|pay|place order/i }).count(), 0);
    assert.equal(await p.getByRole('link', { name: /checkout/i }).count(), 0);
    await p.context().close();
  });

  // ---------------------------------------------------------------- responsive, themes
  const filled = cartJson([bookA, 3], [bookB, 2], [outBook, 1]);
  await step('responsive: no horizontal scrolling at 375/768/1280 (filled and empty cart, details page)', async () => {
    for (const width of [375, 768, 1280]) {
      const p = await newPage({ width });
      await seedStorage(p, filled);
      await cartReady(p);
      await lines(p).nth(2).waitFor();
      let o = await overflow(p);
      assert.ok(o <= 0, `${o}px overflow on filled cart at ${width}px`);
      await p.screenshot({ path: resolve(SHOTS, `cart-${width}.png`), fullPage: true });
      await openBook(p, bookB);
      await addBtn(p).click();
      o = await overflow(p);
      assert.ok(o <= 0, `${o}px overflow on details at ${width}px`);
      await p.screenshot({ path: resolve(SHOTS, `detail-addtocart-${width}.png`), fullPage: true });
      await p.goto(`${ORIGIN}/cart`);
      await cartReady(p);
      await p.getByRole('button', { name: 'Clear cart' }).click();
      await p.getByRole('button', { name: 'Yes, clear cart' }).click();
      await p.getByTestId('cart-empty').waitFor();
      o = await overflow(p);
      assert.ok(o <= 0, `${o}px overflow on empty cart at ${width}px`);
      await p.screenshot({ path: resolve(SHOTS, `cart-empty-${width}.png`), fullPage: true });
      await p.context().close();
    }
  });

  await step('responsive: layout switches (stacked on mobile, row on desktop) and controls are at least 40px tall', async () => {
    const mobile = await newPage({ width: 375 });
    await seedStorage(mobile, cartJson([bookB, 2]));
    await cartReady(mobile);
    const mLine = await line(mobile, bookB).boundingBox();
    const mQty = await mobile.getByTestId('line-qty').boundingBox();
    const mTotal = await line(mobile, bookB).getByTestId('line-total').boundingBox();
    assert.ok(mTotal.y > mQty.y, 'total is below the quantity controls on mobile');
    const plus = await line(mobile, bookB).getByRole('button', { name: /Increase quantity/ }).boundingBox();
    assert.ok(plus.height >= 40 && plus.width >= 40, `+ button ${plus.width}x${plus.height}`);
    assert.ok(mLine.width <= 375);
    await mobile.context().close();

    const desk = await newPage({ width: 1280 });
    await seedStorage(desk, cartJson([bookB, 2]));
    await cartReady(desk);
    const dQty = await desk.getByTestId('line-qty').boundingBox();
    const dTotal = await line(desk, bookB).getByTestId('line-total').boundingBox();
    assert.ok(Math.abs(dTotal.y - dQty.y) < 60, 'total is on the same row as the quantity on desktop');
    const summary = await desk.locator('.bk-cart__summary').boundingBox();
    const first = await lines(desk).first().boundingBox();
    assert.ok(summary.x > first.x + first.width - 1, 'summary sits beside the list on desktop');
    await desk.context().close();
  });

  const contrast = (p, selectors) => p.evaluate((sel) => {
    const parse = (c) => c.match(/[\d.]+/g).map(Number);
    const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    const bgOf = (el) => { for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c.length < 4 || c[3] > 0.99) return c; } return [255, 255, 255]; };
    const ratioOf = (el) => { const [hi, lo] = [lum(parse(getComputedStyle(el).color)), lum(bgOf(el))].sort((a, b) => b - a); return (hi + 0.05) / (lo + 0.05); };
    return Object.fromEntries(sel.map((s) => [s, ratioOf(document.querySelector(s))]));
  }, selectors);
  const CART_SELECTORS = [
    '.bk-cart-line__title a', '.bk-cart-line__meta', '.bk-cart-line__total', '.bk-qty__value',
    '.bk-summary dt', '.bk-summary__total dd', '.bk-summary__note', '.bk-cart-badge', '.bk-cart-line__limit',
  ];
  for (const scheme of ['light', 'dark']) {
    await step(`themes: ${scheme} mode cart text and header badge meet 4.5:1 contrast; screenshots taken`, async () => {
      const p = await newPage({ scheme });
      await p.goto(`${ORIGIN}/about`);
      await p.evaluate((s) => localStorage.setItem('bookstore_theme', s), scheme);
      await seedStorage(p, cartJson([bookA, 3], [bookB, 2]));
      await cartReady(p);
      await lines(p).nth(1).waitFor();
      assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), scheme);
      const ratios = await contrast(p, CART_SELECTORS);
      for (const [s, r] of Object.entries(ratios)) assert.ok(r >= 4.5, `${scheme} ${s} contrast ${r.toFixed(2)}`);
      await p.screenshot({ path: resolve(SHOTS, `cart-${scheme}-1280.png`), fullPage: true });
      await openBook(p, bookB);
      await addBtn(p).click();
      const detail = await contrast(p, ['.bk-detail__cart-note', '.bk-detail__price']);
      for (const [s, r] of Object.entries(detail)) assert.ok(r >= 4.5, `${scheme} ${s} contrast ${r.toFixed(2)}`);
      await p.screenshot({ path: resolve(SHOTS, `detail-addtocart-${scheme}-1280.png`), fullPage: true });
      await p.context().close();
    });
  }

  await step('mobile menu: Cart link shows the count and still navigates', async () => {
    const p = await newPage({ width: 375 });
    await seedStorage(p, cartJson([bookB, 2]), '/books');
    await p.getByRole('heading', { name: 'Books', level: 1 }).waitFor();
    await banner(p).getByRole('button', { name: 'Open menu' }).click();
    const menu = p.locator('nav[aria-label="Main menu"]');
    const link = menu.getByRole('link', { name: 'Cart, 2 items' });
    await link.waitFor({ state: 'visible' });
    assert.equal((await menu.locator('[data-testid="cart-count"]').innerText()).trim(), '2');
    await link.click();
    await p.waitForURL('**/cart');
    await p.getByRole('heading', { name: 'Cart', level: 1 }).waitFor();
    await p.context().close();
  });

  await step('keyboard: the add-to-cart and quantity buttons can be used without a mouse', async () => {
    const p = await newPage();
    await openBook(p, bookB);
    await addBtn(p).focus();
    await p.keyboard.press('Enter');
    await p.getByTestId('in-cart-note').filter({ hasText: '1 in your cart' }).waitFor();
    await p.goto(`${ORIGIN}/cart`);
    await cartReady(p);
    await line(p, bookB).getByRole('button', { name: /Increase quantity/ }).focus();
    await p.keyboard.press('Space');
    await line(p, bookB).getByTestId('line-qty').filter({ hasText: '2' }).waitFor();
    await p.context().close();
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
