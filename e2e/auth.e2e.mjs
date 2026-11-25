// Real-browser E2E for Phase 2 (Microsoft Edge via playwright-core).
// Safety: the API runs against the dedicated bookstore_test database only. The script refuses to
// run otherwise, drops that database before and after, and never connects to "bookstore".
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

// Reuse the real .env for secrets but force the TEST database, and never print its values.
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
const bookId = new mongoose.Types.ObjectId();
await col('authors').insertOne({ _id: authorId, name: 'Sample Author' });
await col('categories').insertOne({ _id: catId, name: 'Fiction', slug: 'fiction' });
await col('books').insertOne({
  _id: bookId, title: 'Sample Book', isbn: '9780000000001', description: 'A seeded sample book.',
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

try {
  await waitFor(`http://127.0.0.1:${API_PORT}/api/health`);
  await waitFor(`${ORIGIN}/`);

  browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const warm = await browser.newPage();
  await warm.goto(ORIGIN + '/', { timeout: 120000 });
  await warm.getByRole('banner').waitFor({ timeout: 120000 });
  await warm.close();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 900) + ' @ ' + page.url()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  const apiCalls = [];
  page.on('request', (r) => { if (r.url().includes('/api/')) apiCalls.push(r); });

  const user = { firstName: 'Asha', lastName: 'Rao', email: 'asha.e2e@example.com', password: 'Str0ng-Passw0rd!' };
  const fill = (label, value) => page.getByLabel(label, { exact: true }).fill(value);
  const headerAction = (name) => page.getByRole('banner').getByRole('button', { name, exact: true });
  const submit = (name) => page.getByRole('button', { name, exact: true }).last(); // the form button, after the header one
  const loginUi = async (email, password) => {
    await page.goto(`${ORIGIN}/login`);
    await fill('Email', email);
    await fill('Password', password);
    await submit('Log in').click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'));
    await headerAction('Log out').waitFor();
  };
  const registerUi = async (u) => {
    await page.goto(`${ORIGIN}/register`);
    await fill('First name', u.firstName);
    await fill('Last name', u.lastName);
    await fill('Email', u.email);
    await fill('Password', u.password);
    await fill('Confirm password', u.password);
    await submit('Register').click();
  };

  // ---------------------------------------------------------------- guest
  await step('guest: header shows Log in / Register only', async () => {
    await page.goto(`${ORIGIN}/`);
    await headerAction('Log in').waitFor();
    await headerAction('Register').waitFor();
    assert.equal(await headerAction('Log out').count(), 0);
    assert.equal(await page.getByRole('link', { name: 'Admin' }).count(), 0);
  });
  await step('protected route as guest redirects to /login', async () => {
    await page.goto(`${ORIGIN}/account`);
    await page.waitForURL('**/login');
    await page.getByRole('heading', { name: 'Log in' }).waitFor();
  });
  await step('ADMIN route as guest redirects to /login', async () => {
    await page.goto(`${ORIGIN}/admin`);
    await page.waitForURL('**/login');
  });

  // ---------------------------------------------------------------- register
  await step('register form shows client-side validation messages', async () => {
    await page.goto(`${ORIGIN}/register`);
    await submit('Register').click();
    await page.getByText('First name is required').waitFor();
    await page.getByText('Email is required').waitFor();
    await fill('Email', 'not-an-email');
    await fill('Password', 'short');
    await fill('Confirm password', 'different');
    await submit('Register').click();
    await page.getByText('Enter a valid email address').waitFor();
    await page.getByText('Must be at least 8 characters').waitFor();
    await page.getByText('Passwords do not match').waitFor();
  });
  await step('register a new customer -> /login with success message; stored as CUSTOMER with bcrypt hash', async () => {
    await registerUi(user);
    await page.waitForURL('**/login');
    await page.getByText('Account created').waitFor();
    const doc = await col('users').findOne({ email: user.email });
    assert.equal(doc.role, 'CUSTOMER');
    assert.match(doc.passwordHash, /^\$2[aby]\$12\$/);
  });
  await step('register request body contains no confirmPassword and no role', async () => {
    const reg = apiCalls.find((r) => r.url().endsWith('/api/auth/register') && r.method() === 'POST');
    assert.deepEqual(Object.keys(JSON.parse(reg.postData())).sort(), ['email', 'firstName', 'lastName', 'password']);
  });
  await step('duplicate email shows the server error and stays on /register', async () => {
    await registerUi({ ...user, firstName: 'Dup' });
    await page.getByText('An account with this email already exists').waitFor();
    assert.match(page.url(), /\/register$/);
  });

  // ---------------------------------------------------------------- invalid login
  await step('wrong password: generic error, no cookie, stays on /login', async () => {
    await page.goto(`${ORIGIN}/login`);
    await fill('Email', user.email);
    await fill('Password', 'Wrong-Password-1');
    await submit('Log in').click();
    await page.getByText('Invalid email or password').waitFor();
    assert.match(page.url(), /\/login$/);
    assert.equal((await context.cookies()).filter((c) => c.name === 'bookstore_session').length, 0);
  });
  await step('unknown email: identical error message', async () => {
    await fill('Email', 'nobody@example.com');
    await fill('Password', 'Wrong-Password-1');
    await submit('Log in').click();
    await page.getByText('Invalid email or password').waitFor();
  });
  await step('empty login form shows required errors', async () => {
    await page.goto(`${ORIGIN}/login`);
    await submit('Log in').click();
    await page.getByText('Email is required').waitFor();
    await page.getByText('Password is required').waitFor();
  });

  // ---------------------------------------------------------------- valid login
  await step('valid login -> home; header shows Account + Log out', async () => {
    await loginUi(user.email, user.password);
    assert.equal(page.url(), `${ORIGIN}/`);
    await headerAction('Account: Asha').waitFor();
    assert.equal(await headerAction('Log in').count(), 0);
    assert.equal(await page.getByRole('link', { name: 'Admin' }).count(), 0);
  });
  await step('cookie is httpOnly + SameSite=Strict and not readable by JavaScript', async () => {
    const c = (await context.cookies()).find((x) => x.name === 'bookstore_session');
    assert.ok(c);
    assert.equal(c.httpOnly, true);
    assert.equal(c.sameSite, 'Strict');
    assert.equal(await page.evaluate(() => document.cookie), '');
  });
  await step('nothing stored in localStorage / sessionStorage (no JWT, no CSRF token)', async () => {
    const dump = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }));
    assert.equal(dump, '{"l":{},"s":{}}');
  });
  await step('logged-in user is redirected away from /login and /register', async () => {
    await page.goto(`${ORIGIN}/login`);
    await page.waitForURL(`${ORIGIN}/`);
    await page.goto(`${ORIGIN}/register`);
    await page.waitForURL(`${ORIGIN}/`);
  });

  // ---------------------------------------------------------------- persistence
  await step('refresh keeps the session (restored by GET /api/auth/me)', async () => {
    await page.goto(`${ORIGIN}/account`);
    await page.getByRole('heading', { name: 'My account' }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: 'My account' }).waitFor();
    await headerAction('Log out').waitFor();
    await page.getByText(user.email).waitFor();
    assert.ok(apiCalls.some((r) => r.url().endsWith('/api/auth/me')));
  });
  await step('deep link to a protected page after refresh does not bounce through /login', async () => {
    const p2 = await context.newPage();
    const urls = [];
    p2.on('framenavigated', (f) => { if (f === p2.mainFrame()) urls.push(f.url()); });
    await p2.goto(`${ORIGIN}/account`);
    await p2.getByRole('heading', { name: 'My account' }).waitFor();
    assert.ok(!urls.some((u) => u.endsWith('/login')), `visited: ${urls}`);
    await p2.close();
  });
  await step('CUSTOMER opening /admin sees "Access denied" and no Admin link', async () => {
    await page.goto(`${ORIGIN}/admin`);
    await page.getByRole('heading', { name: 'Access denied' }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Admin' }).count(), 0);
  });

  // ---------------------------------------------------------------- CSRF + logout
  await step('CSRF: the logout request sent by the app carries X-CSRF-Token and succeeds (204)', async () => {
    await page.goto(`${ORIGIN}/`);
    await headerAction('Log out').waitFor();
    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().endsWith('/api/auth/logout')),
      headerAction('Log out').click(),
    ]);
    const token = await req.headerValue('x-csrf-token');
    assert.ok(token && token.length > 20, 'X-CSRF-Token header missing');
    assert.equal((await req.response()).status(), 204);
  });
  await step('logout ends the session: guest header, cookie gone, protected pages locked, survives refresh', async () => {
    await headerAction('Log in').waitFor();
    assert.equal(await headerAction('Log out').count(), 0);
    assert.equal((await context.cookies()).filter((c) => c.name === 'bookstore_session').length, 0);
    await page.goto(`${ORIGIN}/account`);
    await page.waitForURL('**/login');
    await page.reload();
    await headerAction('Log in').waitFor();
  });
  await step('CSRF attack: forged requests with the cookie but no / wrong X-CSRF-Token get 403; session survives', async () => {
    await loginUi(user.email, user.password);
    const statuses = await page.evaluate(async () => {
      const post = (headers) => fetch('/api/auth/logout', { method: 'POST', credentials: 'include', headers }).then((r) => r.status);
      return [await post({}), await post({ 'X-CSRF-Token': 'forged' })];
    });
    assert.deepEqual(statuses, [403, 403]);
    await page.goto(`${ORIGIN}/account`);
    await page.getByRole('heading', { name: 'My account' }).waitFor();
  });
  await step('CSRF attack: cross-site form POST from another origin does not log the user out', async () => {
    const evil = await context.newPage();
    await evil.route('http://evil.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<form id=f method=POST action="http://127.0.0.1:${API_PORT}/api/auth/logout"></form><script>document.getElementById('f').submit()</script>`,
      }));
    await evil.goto('http://evil.test/attack.html').catch(() => {});
    await evil.waitForTimeout(1000);
    await evil.close();
    await page.goto(`${ORIGIN}/account`);
    await page.getByRole('heading', { name: 'My account' }).waitFor();
  });
  await step('CSRF: API rejects a foreign Origin header even for login', async () => {
    const res = await fetch(`http://127.0.0.1:${API_PORT}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.test' },
      body: JSON.stringify({ email: user.email, password: user.password }),
    });
    assert.equal(res.status, 403);
  });

  // ---------------------------------------------------------------- expired session
  await step('expired session: tab refocus detects it, shows a notice and returns to login', async () => {
    await page.goto(`${ORIGIN}/account`);
    await page.getByRole('heading', { name: 'My account' }).waitFor();
    await col('users').deleteOne({ email: user.email }); // server-side the session is no longer valid
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByText('Your session has expired. Please log in again.').waitFor();
    await headerAction('Log in').waitFor();
    await page.waitForURL('**/login');
  });
  await step('expired cookie + refresh behaves like a guest', async () => {
    await context.clearCookies();
    await page.goto(`${ORIGIN}/account`);
    await page.waitForURL('**/login');
  });
  await step('after login the user returns to the page they originally requested', async () => {
    await registerUi(user);
    await page.waitForURL('**/login');
    await context.clearCookies();
    await page.goto(`${ORIGIN}/account`);
    await page.waitForURL('**/login');
    await fill('Email', user.email);
    await fill('Password', user.password);
    await submit('Log in').click();
    await page.waitForURL(`${ORIGIN}/account`);
    await page.getByRole('heading', { name: 'My account' }).waitFor();
  });

  // ---------------------------------------------------------------- ADMIN
  await step('ADMIN: /admin opens and the header shows the Admin link', async () => {
    await headerAction('Log out').click();
    await headerAction('Log in').waitFor();
    await col('users').updateOne({ email: user.email }, { $set: { role: 'ADMIN' } }); // test DB only
    await loginUi(user.email, user.password);
    await page.getByRole('banner').getByRole('link', { name: 'Admin' }).click(); // the footer also has an Admin link
    await page.waitForURL('**/admin');
    await page.getByRole('heading', { name: 'Admin', exact: true }).waitFor();
  });
  await step('ADMIN demoted server-side loses access after the next reload', async () => {
    await col('users').updateOne({ email: user.email }, { $set: { role: 'CUSTOMER' } });
    await page.reload();
    await page.getByRole('heading', { name: 'Access denied' }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Admin' }).count(), 0);
  });

  // ---------------------------------------------------------------- existing pages
  await step('Books page still lists books', async () => {
    await page.goto(`${ORIGIN}/books`);
    await page.getByRole('heading', { name: 'Books' }).waitFor();
    await page.getByRole('link', { name: 'Sample Book' }).waitFor();
    await page.getByText('Sample Author').first().waitFor(); // the generated cover repeats the author
  });
  await step('Book Details page still works', async () => {
    await page.getByRole('link', { name: 'Sample Book' }).click();
    await page.waitForURL(`**/books/${bookId}`);
    await page.getByRole('heading', { name: 'Sample Book' }).waitFor();
    await page.getByText('₹9.99').waitFor();
  });
  await step('Home, Cart and 404 pages still render', async () => {
    await page.goto(`${ORIGIN}/`);
    await page.getByRole('heading', { name: 'Welcome to the Bookstore' }).waitFor();
    await page.goto(`${ORIGIN}/cart`);
    await page.getByRole('heading', { name: 'Cart' }).waitFor();
    await page.goto(`${ORIGIN}/does-not-exist`);
    await page.getByRole('heading', { name: 'Page not found' }).waitFor();
  });

  // ---------------------------------------------------------------- server unreachable
  await step('session check fails (server unreachable): retry screen, no false logout, Retry recovers', async () => {
    const p3 = await context.newPage();
    await p3.route('**/api/auth/me', (route) => route.abort());
    await p3.goto(`${ORIGIN}/account`);
    await p3.getByText('Cannot reach the server').waitFor();
    await p3.unroute('**/api/auth/me');
    await p3.getByRole('button', { name: 'Retry' }).click();
    await p3.getByRole('heading', { name: 'My account' }).waitFor();
    await p3.close();
  });

  // ---------------------------------------------------------------- responsive
  await step('responsive: login & register fit 375px / 768px / 1280px with no horizontal scroll', async () => {
    await context.clearCookies();
    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      for (const path of ['/login', '/register']) {
        await page.goto(`${ORIGIN}${path}`);
        await page.getByLabel('Email', { exact: true }).waitFor();
        const m = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          formWidth: document.querySelector('form').getBoundingClientRect().width,
          vw: window.innerWidth,
        }));
        assert.ok(m.overflow <= 0, `horizontal overflow ${m.overflow}px at ${width}px on ${path}`);
        assert.ok(m.formWidth <= m.vw, `form wider than viewport at ${width}px on ${path}`);
        await headerAction('Log in').waitFor(); // auth actions stay reachable on small screens
      }
      await page.goto(`${ORIGIN}/login`);
      await page.screenshot({ path: resolve(SHOTS, `login-${width}.png`) });
    }
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`${ORIGIN}/register`);
    await page.screenshot({ path: resolve(SHOTS, 'register-375.png'), fullPage: true });
  });

  await step('no unexpected browser console errors', async () => {
    const unexpected = consoleErrors.filter((t) => !/status of (401|403|409)|Failed to load resource|net::ERR/i.test(t));
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
