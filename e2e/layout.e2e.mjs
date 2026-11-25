// Real-browser E2E for Phase 3: theme, header/mobile navigation, footer, layout, responsiveness.
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

const mongoose = (await import(pathToFileURL(resolve(ROOT, 'server/node_modules/mongoose/index.js')).href)).default;
await mongoose.connect(TEST_DB);
assert.equal(mongoose.connection.db.databaseName, 'bookstore_test');
await mongoose.connection.db.dropDatabase();
const col = (n) => mongoose.connection.db.collection(n);

const authorId = new mongoose.Types.ObjectId();
const catId = new mongoose.Types.ObjectId();
await col('authors').insertOne({ _id: authorId, name: 'Sample Author' });
await col('categories').insertOne({ _id: catId, name: 'Fiction', slug: 'fiction' });
await col('books').insertOne({
  title: 'Sample Book', isbn: '9780000000001', description: 'A seeded sample book.',
  priceCents: 999, stock: 10, author: authorId, category: catId, createdAt: new Date(), updatedAt: new Date(),
});

const api = start(['src/index.js'], resolve(ROOT, 'server'), apiEnv);
const web = start(['node_modules/vite/bin/vite.js', '--port', String(WEB_PORT), '--strictPort'], resolve(ROOT, 'client'), process.env);

let browser;
const cleanup = async () => {
  try { await browser?.close(); } catch { /* ignore */ }
  for (const p of procs) { try { p.kill(); } catch { /* ignore */ } }
  try { await mongoose.connection.db.dropDatabase(); await mongoose.disconnect(); } catch { /* ignore */ }
};

// ---- contrast helpers (WCAG 2.x), evaluated on computed colours in the page ----
const contrastInPage = () => {
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r, g, b, a };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const solidBg = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c.a > 0.99) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const ratio = (el) => {
    const fg = parse(getComputedStyle(el).color);
    const bg = solidBg(el);
    const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const pick = (sel) => document.querySelector(sel);
  const targets = {
    'body text on page': pick('main h1'),
    'header brand': pick('.bk-brand'),
    'header nav link': pick('header a.cds--header__menu-item'),
    'footer text': pick('.bk-footer__blurb'),
    'footer link': pick('.bk-footer__list a'),
    'footer heading': pick('.bk-footer__heading'),
  };
  return Object.fromEntries(Object.entries(targets).filter(([, el]) => el).map(([k, el]) => [k, ratio(el)]));
};

try {
  await waitFor(`http://127.0.0.1:${API_PORT}/api/health`);
  await waitFor(`${ORIGIN}/`);

  browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const warm = await browser.newPage();
  await warm.goto(ORIGIN + '/', { timeout: 120000 });
  await warm.getByRole('banner').waitFor({ timeout: 120000 });
  await warm.close();

  const newContext = (opts = {}) => browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light', ...opts });
  let context = await newContext();
  let page = await context.newPage();
  const consoleErrors = [];
  const watch = (p) => {
    p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 900) + ' @ ' + p.url()); });
    p.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  };
  watch(page);

  const user = { firstName: 'Asha', lastName: 'Rao', email: 'asha.layout@example.com', password: 'Str0ng-Passw0rd!' };
  const banner = () => page.getByRole('banner');
  const footer = () => page.getByRole('contentinfo');
  const themeButton = () => banner().getByRole('button', { name: /Switch to (dark|light) theme/ });
  const htmlTheme = () => page.evaluate(() => document.documentElement.dataset.theme);
  const bodyBg = () => page.evaluate(() => getComputedStyle(document.querySelector('.bk-app')).backgroundColor);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const fill = (label, value) => page.getByLabel(label, { exact: true }).fill(value);
  const submit = (name) => page.getByRole('button', { name, exact: true }).last();
  const loginUi = async (email, password) => {
    await page.goto(`${ORIGIN}/login`);
    await fill('Email', email);
    await fill('Password', password);
    await submit('Log in').click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'));
    await banner().getByRole('button', { name: 'Log out' }).waitFor();
  };
  const logoutUi = async () => {
    await banner().getByRole('button', { name: 'Log out' }).click();
    await banner().getByRole('button', { name: 'Log in' }).waitFor();
  };
  const openMenu = async () => {
    await banner().getByRole('button', { name: 'Open menu' }).click();
    await page.locator('nav[aria-label="Main menu"].cds--side-nav--expanded').waitFor();
  };
  const sideNavWidth = () => page.evaluate(() => document.querySelector('nav[aria-label="Main menu"]').getBoundingClientRect().width);

  // ---------------------------------------------------------------- theme
  await step('theme: defaults to light when the system prefers light, toggle switches to dark', async () => {
    await page.goto(`${ORIGIN}/`);
    await banner().waitFor();
    assert.equal(await htmlTheme(), 'light');
    const light = await bodyBg();
    await themeButton().click();
    assert.equal(await htmlTheme(), 'dark');
    assert.notEqual(await bodyBg(), light, 'background should change');
    await banner().getByRole('button', { name: 'Switch to light theme' }).waitFor();
  });
  await step('theme: choice persists across refresh and navigation (stores only "dark")', async () => {
    await page.reload();
    await banner().waitFor();
    assert.equal(await htmlTheme(), 'dark');
    await page.goto(`${ORIGIN}/about`);
    assert.equal(await htmlTheme(), 'dark');
    const stored = await page.evaluate(() => ({ ...window.localStorage }));
    assert.deepEqual(stored, { bookstore_theme: 'dark' });
    assert.equal(await page.evaluate(() => Object.keys(window.sessionStorage).length), 0);
  });
  await step('theme: applied before first paint (no flash of the wrong theme)', async () => {
    // The head script must have set the theme by DOMContentLoaded, before React renders anything.
    const p = await context.newPage();
    await p.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        window.__themeAtDcl = document.documentElement.dataset.theme;
        window.__rootAtDcl = document.getElementById('root').childElementCount;
      });
    });
    await p.goto(`${ORIGIN}/about`);
    assert.equal(await p.evaluate(() => window.__themeAtDcl), 'dark');
    await p.close();
  });
  await step('theme: toggling back to light persists too', async () => {
    await themeButton().click();
    assert.equal(await htmlTheme(), 'light');
    await page.reload();
    await banner().waitFor();
    assert.equal(await htmlTheme(), 'light');
  });
  await step('theme: with nothing stored, follows the system dark preference', async () => {
    const ctx = await newContext({ colorScheme: 'dark' });
    const p = await ctx.newPage();
    await p.goto(`${ORIGIN}/`);
    await p.getByRole('banner').waitFor();
    assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await ctx.close();
  });
  await step('theme: corrupted stored value falls back safely', async () => {
    const ctx = await newContext();
    const p = await ctx.newPage();
    await p.addInitScript(() => window.localStorage.setItem('bookstore_theme', '<script>alert(1)</script>'));
    await p.goto(`${ORIGIN}/`);
    await p.getByRole('banner').waitFor();
    assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), 'light');
    await ctx.close();
  });
  await step('theme: text contrast is at least 4.5:1 in light and dark (home + footer + header)', async () => {
    for (const want of ['light', 'dark']) {
      if ((await htmlTheme()) !== want) await themeButton().click();
      await page.goto(`${ORIGIN}/about`);
      await page.getByRole('heading', { name: 'About Us' }).waitFor();
      const ratios = await page.evaluate(contrastInPage);
      for (const [name, r] of Object.entries(ratios)) {
        assert.ok(r >= 4.5, `${want}: ${name} contrast ${r.toFixed(2)} < 4.5`);
      }
      assert.ok(Object.keys(ratios).length >= 5, 'expected to measure header, body and footer');
    }
    if ((await htmlTheme()) !== 'light') await themeButton().click();
  });

  // ---------------------------------------------------------------- desktop header
  await step('desktop 1280: hamburger hidden, Home/Books/Cart visible in header, active link marked', async () => {
    await page.goto(`${ORIGIN}/books`);
    await banner().getByRole('link', { name: 'Books', exact: true }).waitFor();
    assert.equal(await banner().getByRole('button', { name: 'Open menu' }).isVisible(), false);
    for (const n of ['Home', 'Books', 'Cart']) assert.equal(await banner().getByRole('link', { name: n, exact: true }).first().isVisible(), true, n);
    const current = await banner().locator('nav[aria-label="Main"] a[aria-current="page"]').allInnerTexts();
    assert.deepEqual(current.map((t) => t.trim()), ['Books']);
  });

  // ---------------------------------------------------------------- mobile nav
  await step('mobile 375: header nav links are hidden, hamburger + theme + auth actions are visible', async () => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`${ORIGIN}/`);
    await banner().getByRole('button', { name: 'Open menu' }).waitFor();
    assert.equal(await banner().getByRole('button', { name: 'Open menu' }).isVisible(), true);
    assert.equal(await themeButton().isVisible(), true);
    assert.equal(await banner().getByRole('button', { name: 'Log in' }).isVisible(), true);
    assert.equal(await sideNavWidth(), 0, 'menu should be closed');
    assert.equal(await page.locator('nav[aria-label="Main menu"]').getAttribute('inert'), '', 'closed menu must not be focusable');
  });
  await step('mobile 375: hamburger opens the menu with Home, Books, Cart; second click closes it', async () => {
    await openMenu();
    await page.waitForFunction(() => document.querySelector('nav[aria-label="Main menu"]').getBoundingClientRect().width > 200);
    const menu = page.locator('nav[aria-label="Main menu"]');
    for (const n of ['Home', 'Books', 'Cart']) await menu.getByRole('link', { name: n, exact: true }).waitFor({ state: 'visible' });
    assert.equal(await banner().getByRole('button', { name: 'Close menu' }).getAttribute('aria-expanded'), 'true');
    await page.screenshot({ path: resolve(SHOTS, 'nav-open-375.png') });
    await banner().getByRole('button', { name: 'Close menu' }).click();
    await page.locator('nav[aria-label="Main menu"]:not(.cds--side-nav--expanded)').waitFor();
    await page.waitForFunction(() => document.querySelector('nav[aria-label="Main menu"]').getBoundingClientRect().width === 0);
  });
  await step('mobile 375: choosing Books navigates and closes the menu; Cart works too', async () => {
    await openMenu();
    await page.locator('nav[aria-label="Main menu"]').getByRole('link', { name: 'Books', exact: true }).click();
    await page.waitForURL('**/books');
    await page.getByRole('heading', { name: 'Books' }).waitFor();
    await page.waitForFunction(() => document.querySelector('nav[aria-label="Main menu"]').getBoundingClientRect().width === 0);
    await openMenu();
    await page.locator('nav[aria-label="Main menu"]').getByRole('link', { name: 'Cart', exact: true }).click();
    await page.waitForURL('**/cart');
    await page.getByRole('heading', { name: 'Cart' }).waitFor();
  });
  await step('mobile 375: Escape and tapping outside both close the menu', async () => {
    await openMenu();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('nav[aria-label="Main menu"]').getBoundingClientRect().width === 0);
    await openMenu();
    await page.mouse.click(360, 600); // on the overlay, outside the 256px menu
    await page.waitForFunction(() => document.querySelector('nav[aria-label="Main menu"]').getBoundingClientRect().width === 0);
  });
  await step('tablet 768: hamburger menu is used and works', async () => {
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto(`${ORIGIN}/`);
    await openMenu();
    await page.locator('nav[aria-label="Main menu"]').getByRole('link', { name: 'Books', exact: true }).click();
    await page.waitForURL('**/books');
  });
  await step('resizing from mobile (menu open) to desktop closes the menu and shows inline nav', async () => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`${ORIGIN}/`);
    await openMenu();
    await page.setViewportSize({ width: 1280, height: 800 });
    await banner().getByRole('link', { name: 'Books', exact: true }).first().waitFor({ state: 'visible' });
    assert.equal(await banner().getByRole('button', { name: 'Open menu' }).isVisible(), false);
    assert.equal(await page.locator('.cds--side-nav__overlay-active').count(), 0);
  });
  await step('keyboard: menu button is reachable and operable with Enter', async () => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`${ORIGIN}/`);
    await banner().getByRole('button', { name: 'Open menu' }).focus();
    await page.keyboard.press('Enter');
    await page.locator('nav[aria-label="Main menu"].cds--side-nav--expanded').waitFor();
  });

  // ---------------------------------------------------------------- guest / customer / admin navigation
  await step('guest navigation: Log in + Register in header and footer, no Account/Admin', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${ORIGIN}/`);
    await banner().getByRole('button', { name: 'Log in' }).waitFor();
    await banner().getByRole('button', { name: 'Register' }).waitFor();
    assert.equal(await banner().getByRole('button', { name: 'Log out' }).count(), 0);
    assert.equal(await page.getByRole('link', { name: 'Admin' }).count(), 0);
    await footer().getByRole('link', { name: 'Log in' }).waitFor();
    await footer().getByRole('link', { name: 'Register' }).waitFor();
    assert.equal(await footer().getByRole('link', { name: 'My account' }).count(), 0);
  });
  await step('customer navigation: Account + Log out, no Admin; footer shows My account', async () => {
    await page.goto(`${ORIGIN}/register`);
    await fill('First name', user.firstName);
    await fill('Last name', user.lastName);
    await fill('Email', user.email);
    await fill('Password', user.password);
    await fill('Confirm password', user.password);
    await submit('Register').click();
    await page.waitForURL('**/login');
    await loginUi(user.email, user.password);
    await banner().getByRole('button', { name: `Account: ${user.firstName}` }).waitFor();
    assert.equal(await banner().getByRole('button', { name: 'Log in' }).count(), 0);
    assert.equal(await page.getByRole('link', { name: 'Admin' }).count(), 0);
    await footer().getByRole('link', { name: 'My account' }).click();
    await page.waitForURL('**/account');
    await page.getByRole('heading', { name: 'My account' }).waitFor();
  });
  await step('customer on mobile: Account/Log out reachable, menu has no Admin', async () => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`${ORIGIN}/`);
    await banner().getByRole('button', { name: `Account: ${user.firstName}` }).waitFor();
    await openMenu();
    assert.equal(await page.locator('nav[aria-label="Main menu"]').getByRole('link', { name: 'Admin' }).count(), 0);
    await page.keyboard.press('Escape');
  });
  await step('admin navigation: Admin link in header, mobile menu and footer; Admin page opens', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await logoutUi();
    await col('users').updateOne({ email: user.email }, { $set: { role: 'ADMIN' } }); // test DB only
    await loginUi(user.email, user.password);
    await banner().getByRole('link', { name: 'Admin' }).first().waitFor();
    await footer().getByRole('link', { name: 'Admin' }).waitFor();
    await page.setViewportSize({ width: 375, height: 800 });
    await openMenu();
    await page.locator('nav[aria-label="Main menu"]').getByRole('link', { name: 'Admin' }).click();
    await page.waitForURL('**/admin');
    await page.getByRole('heading', { name: 'Admin', exact: true }).waitFor();
    await page.screenshot({ path: resolve(SHOTS, 'admin-375.png') });
  });

  // ---------------------------------------------------------------- footer
  await step('footer: every link goes to a working page', async () => {
    await logoutUi();
    await page.setViewportSize({ width: 1280, height: 800 });
    const cases = [
      ['Books', '/books', 'Books'], ['Cart', '/cart', 'Cart'], ['About Us', '/about', 'About Us'],
      ['Contact', '/contact', 'Contact'], ['Help', '/help', 'Help'],
      ['Log in', '/login', 'Log in'], ['Register', '/register', 'Create an account'],
    ];
    for (const [label, path, heading] of cases) {
      await page.goto(`${ORIGIN}/`);
      await footer().getByRole('link', { name: label, exact: true }).click();
      await page.waitForURL(`${ORIGIN}${path}`);
      await page.getByRole('heading', { name: heading, exact: true }).first().waitFor();
    }
  });
  await step('footer: copyright line shows the current year and the site name', async () => {
    const text = await footer().innerText();
    assert.ok(text.includes(`© ${new Date().getFullYear()} Bookstore`));
  });
  await step('footer: contains no invented external contact details (no mailto/tel/external links)', async () => {
    const hrefs = await footer().locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    assert.ok(hrefs.every((h) => h.startsWith('/')), hrefs.join(','));
  });
  await step('footer: sits at the bottom on short pages and below content on long pages', async () => {
    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${ORIGIN}/contact`);
      await footer().waitFor();
      const short = await page.evaluate(() => ({ bottom: document.querySelector('footer').getBoundingClientRect().bottom, vh: window.innerHeight }));
      assert.ok(Math.abs(short.bottom - short.vh) <= 1.5 || short.bottom > short.vh, `short page footer bottom ${short.bottom} vs ${short.vh} at ${width}`);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${ORIGIN}/contact`);
    const gap = await page.evaluate(() => {
      const f = document.querySelector('footer').getBoundingClientRect();
      return Math.round(window.innerHeight - f.bottom);
    });
    assert.ok(gap <= 1, `a gap of ${gap}px below the footer on a short page`);
    // Long page: add tall content and confirm the footer follows it instead of overlapping it.
    await page.evaluate(() => {
      const spacer = document.createElement('div');
      spacer.style.height = '2500px';
      spacer.id = 'spacer';
      document.querySelector('.bk-container').appendChild(spacer);
    });
    const long = await page.evaluate(() => ({
      footerTop: document.querySelector('footer').getBoundingClientRect().top + window.scrollY,
      spacerBottom: document.getElementById('spacer').getBoundingClientRect().bottom + window.scrollY,
    }));
    assert.ok(long.footerTop >= long.spacerBottom - 1, 'footer overlaps long content');
  });

  // ---------------------------------------------------------------- skip link & landmarks
  await step('skip link: first Tab stop, visible on focus, moves focus to #main-content', async () => {
    await page.goto(`${ORIGIN}/about`);
    await page.getByRole('heading', { name: 'About Us' }).waitFor();
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to main content' });
    assert.equal(await skip.evaluate((el) => el === document.activeElement), true);
    const box = await skip.boundingBox();
    assert.ok(box && box.y >= -1 && box.width > 20, 'skip link should be visible when focused');
    await page.keyboard.press('Enter');
    assert.ok(page.url().endsWith('#main-content'));
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'main-content');
  });
  await step('landmarks: one banner, one main, one contentinfo, one h1 per page', async () => {
    for (const path of ['/', '/books', '/cart', '/about', '/contact', '/help', '/login', '/register', '/nope']) {
      await page.goto(`${ORIGIN}${path}`);
      await page.locator('main h1').first().waitFor();
      assert.equal(await page.getByRole('banner').count(), 1, `banner on ${path}`);
      assert.equal(await page.getByRole('main').count(), 1, `main on ${path}`);
      assert.equal(await page.getByRole('contentinfo').count(), 1, `footer on ${path}`);
      assert.equal(await page.locator('h1').count(), 1, `h1 count on ${path}`);
    }
  });

  // ---------------------------------------------------------------- responsive + screenshots
  await step('responsive: no horizontal scrolling at 375/768/1280 in light and dark on every page', async () => {
    const paths = ['/', '/books', '/cart', '/about', '/contact', '/help', '/login', '/register', '/nope'];
    for (const mode of ['light', 'dark']) {
      if ((await htmlTheme()) !== mode) await themeButton().click();
      for (const width of [375, 768, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        for (const path of paths) {
          await page.goto(`${ORIGIN}${path}`);
          await page.locator('main h1').first().waitFor();
          const o = await overflow();
          assert.ok(o <= 0, `${o}px horizontal overflow on ${path} at ${width}px (${mode})`);
          const hidden = await banner().getByRole('button', { name: /Switch to/ }).isVisible();
          assert.equal(hidden, true, 'theme toggle must remain reachable');
        }
        await page.goto(`${ORIGIN}/`);
        await page.locator('main h1').waitFor();
        await page.screenshot({ path: resolve(SHOTS, `home-${mode}-${width}.png`), fullPage: true });
      }
    }
    if ((await htmlTheme()) !== 'light') await themeButton().click();
  });
  await step('responsive: admin and account pages have no horizontal overflow', async () => {
    await loginUi(user.email, user.password);
    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      for (const path of ['/account', '/admin']) {
        await page.goto(`${ORIGIN}${path}`);
        await page.locator('main h1').first().waitFor();
        assert.ok((await overflow()) <= 0, `overflow on ${path} at ${width}px`);
      }
    }
  });

  await step('no unexpected browser console errors', async () => {
    const unexpected = consoleErrors.filter((t) => !/status of (401|403|404|409)|Failed to load resource|net::ERR/i.test(t));
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
