import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { ORIGIN, createClient, env, startTestServer, validUser, prisma } from './helpers.js';

const { hashPassword } = await import('../src/services/auth.service.js');
const COOKIE = 'bookstore_session';

let ctx;
before(async () => {
  ctx = await startTestServer();
});
after(async () => {
  await ctx.stop();
});

const newClient = () => createClient(ctx.baseUrl);
const csrf = (token) => ({ headers: { 'X-CSRF-Token': token } });

async function registerAndLogin(overrides = {}) {
  const client = newClient();
  const user = validUser(overrides);
  await client.post('/api/auth/register', user);
  const res = await client.post('/api/auth/login', { email: user.email, password: user.password });
  return { client, user, login: res };
}

describe('POST /api/auth/register', () => {
  test('creates a CUSTOMER and returns no password hash or token', async () => {
    const res = await newClient().post('/api/auth/register', validUser());
    assert.equal(res.status, 201);
    assert.equal(res.json.user.email, 'asha@example.com');
    assert.equal(res.json.user.role, 'CUSTOMER');
    assert.equal(res.json.user.firstName, 'Asha');
    assert.ok(res.json.user.id);
    assert.equal(res.setCookies.length, 0, 'register must not log the user in');
    for (const forbidden of ['passwordHash', 'password', 'token', '_id', '__v']) {
      assert.equal(forbidden in res.json.user, false, `${forbidden} leaked`);
    }
    assert.ok(!res.text.includes('$2'), 'bcrypt hash must not appear in response');
  });

  test('stores a bcrypt hash, never the plain password', async () => {
    await newClient().post('/api/auth/register', validUser({ email: 'hash@example.com' }));
    const stored = await prisma.user.findUnique({ where: { email: 'hash@example.com' } });
    assert.match(stored.passwordHash, /^\$2[aby]\$12\$/);
    assert.notEqual(stored.passwordHash, validUser().password);
  });

  test('ignores a role sent by the client (CUSTOMER only)', async () => {
    const res = await newClient().post(
      '/api/auth/register',
      validUser({ email: 'sneaky@example.com', role: 'ADMIN' }),
    );
    assert.equal(res.status, 201);
    assert.equal(res.json.user.role, 'CUSTOMER');
    const stored = await prisma.user.findUnique({ where: { email: 'sneaky@example.com' } });
    assert.equal(stored.role, 'CUSTOMER');
  });

  test('rejects a duplicate email with 409 (case-insensitive)', async () => {
    const c = newClient();
    await c.post('/api/auth/register', validUser({ email: 'dup@example.com' }));
    const res = await c.post('/api/auth/register', validUser({ email: 'DUP@Example.com' }));
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'An account with this email already exists');
  });

  test('rejects invalid input with 400', async () => {
    const c = newClient();
    const bad = [
      validUser({ password: 'short' }),
      validUser({ password: 'x'.repeat(73) }), // over bcrypt's 72-byte limit
      validUser({ password: 'é'.repeat(37) }), // 74 bytes
      validUser({ email: 'not-an-email' }),
      validUser({ firstName: '' }),
      validUser({ lastName: '   ' }),
      validUser({ firstName: 'x'.repeat(51) }),
      { email: 'a@b.com', password: 'Str0ng-Passw0rd!' }, // names missing
      {},
    ];
    for (const body of bad) {
      const res = await c.post('/api/auth/register', body);
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(Object.keys(body))}`);
      assert.deepEqual(res.json, { error: 'Invalid request' });
    }
  });

  test('rejects malformed JSON with 400', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ "email": ',
    });
    assert.equal(res.status, 400);
  });

  test('accepts a 72-byte password (the bcrypt maximum)', async () => {
    const res = await newClient().post(
      '/api/auth/register',
      validUser({ email: 'long@example.com', password: 'a'.repeat(72) }),
    );
    assert.equal(res.status, 201);
  });

  test('NoSQL operator objects are rejected', async () => {
    const res = await newClient().post('/api/auth/register', validUser({ email: { $ne: '' } }));
    assert.equal(res.status, 400);
  });
});

describe('POST /api/auth/login', () => {
  test('success sets an httpOnly, SameSite=Strict cookie and returns no JWT or hash', async () => {
    const { login } = await registerAndLogin({ email: 'login@example.com' });
    assert.equal(login.status, 200);
    assert.equal(login.json.user.email, 'login@example.com');
    assert.ok(login.json.csrfToken);

    const cookie = login.setCookies.find((c) => c.startsWith(`${COOKIE}=`));
    assert.ok(cookie, 'session cookie missing');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.match(cookie, /Path=\//i);
    assert.match(cookie, /Max-Age=\d+/i);
    assert.equal(login.headers.get('cache-control'), 'no-store');

    const token = cookie.split(';')[0].split('=')[1];
    assert.ok(!login.text.includes(token), 'JWT must not be in the response body');
    assert.ok(!login.text.includes('$2'), 'hash must not be in the response body');
    assert.equal('passwordHash' in login.json.user, false);
  });

  test('JWT contains only the user id and no personal data', async () => {
    const { client, login } = await registerAndLogin({ email: 'claims@example.com' });
    const payload = jwt.decode(client.cookie(COOKIE));
    assert.equal(payload.sub, login.json.user.id);
    assert.ok(payload.jti && payload.exp && payload.iat);
    for (const key of ['email', 'role', 'passwordHash', 'firstName']) {
      assert.equal(key in payload, false, `${key} must not be in the JWT`);
    }
    const lifetimeMin = (payload.exp - payload.iat) / 60;
    assert.equal(lifetimeMin, env.JWT_EXPIRES_MINUTES);
  });

  test('wrong password and unknown email give the identical response', async () => {
    const { user } = await registerAndLogin({ email: 'same@example.com' });
    const c = newClient();
    const wrongPw = await c.post('/api/auth/login', { email: user.email, password: 'Wrong-Password-1' });
    const unknown = await c.post('/api/auth/login', { email: 'nobody@example.com', password: 'Wrong-Password-1' });
    assert.equal(wrongPw.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(wrongPw.json, unknown.json);
    assert.deepEqual(wrongPw.json, { error: 'Invalid email or password' });
    assert.equal(wrongPw.setCookies.length, 0);
  });

  test('email is case-insensitive', async () => {
    const { user } = await registerAndLogin({ email: 'case@example.com' });
    const res = await newClient().post('/api/auth/login', { email: 'CASE@EXAMPLE.COM', password: user.password });
    assert.equal(res.status, 200);
  });

  test('rejects invalid bodies and NoSQL injection attempts', async () => {
    await registerAndLogin({ email: 'inject@example.com' });
    const c = newClient();
    for (const body of [
      {},
      { email: 'inject@example.com' },
      { email: { $ne: null }, password: { $ne: null } },
      { email: 'inject@example.com', password: { $ne: '' } },
    ]) {
      const res = await c.post('/api/auth/login', body);
      assert.ok([400, 401].includes(res.status), `injection got ${res.status}`);
      assert.equal(res.setCookies.length, 0);
    }
  });
});

describe('GET /api/auth/me', () => {
  test('returns the current user and a CSRF token with a valid session', async () => {
    const { client, login } = await registerAndLogin({ email: 'me@example.com' });
    const res = await client.get('/api/auth/me');
    assert.equal(res.status, 200);
    assert.equal(res.json.user.email, 'me@example.com');
    assert.equal(res.json.csrfToken, login.json.csrfToken);
    assert.equal('passwordHash' in res.json.user, false);
    assert.ok(!res.text.includes(client.cookie(COOKIE)));
  });

  test('401 without a cookie', async () => {
    const res = await newClient().get('/api/auth/me');
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, { error: 'Authentication required' });
  });

  test('401 for a tampered token', async () => {
    const { client } = await registerAndLogin({ email: 'tamper@example.com' });
    const token = client.cookie(COOKIE);
    const [h, p, s] = token.split('.');
    const flipped = s.slice(0, -2) + (s.endsWith('A') ? 'B' : 'A') + 'x';
    for (const bad of [`${h}.${p}.${flipped}`, `${h}.${p}x.${s}`, 'garbage', `${h}.${p}.`]) {
      const res = await newClient().get('/api/auth/me', { cookie: `${COOKIE}=${bad}` });
      assert.equal(res.status, 401);
    }
  });

  test('401 for an expired token', async () => {
    const { login } = await registerAndLogin({ email: 'expired@example.com' });
    const expired = jwt.sign({}, env.JWT_SECRET, {
      algorithm: 'HS256',
      subject: login.json.user.id,
      jwtid: 'x',
      issuer: 'bookstore-api',
      audience: 'bookstore-web',
      expiresIn: -60,
    });
    const res = await newClient().get('/api/auth/me', { cookie: `${COOKIE}=${expired}` });
    assert.equal(res.status, 401);
  });

  test('401 for tokens signed with another secret, alg=none, or wrong audience', async () => {
    const { login } = await registerAndLogin({ email: 'forged@example.com' });
    const sub = login.json.user.id;
    const base = { subject: sub, jwtid: 'x', issuer: 'bookstore-api', audience: 'bookstore-web', expiresIn: 600 };
    const forged = [
      jwt.sign({}, 'a-completely-different-secret-value-0123456789', { algorithm: 'HS256', ...base }),
      jwt.sign({}, env.JWT_SECRET, { algorithm: 'HS256', ...base, audience: 'someone-else' }),
      jwt.sign({}, env.JWT_SECRET, { algorithm: 'HS256', ...base, issuer: 'someone-else' }),
      jwt.sign({}, '', { algorithm: 'none', ...base }),
    ];
    for (const token of forged) {
      const res = await newClient().get('/api/auth/me', { cookie: `${COOKIE}=${token}` });
      assert.equal(res.status, 401);
    }
  });

  test('401 when the user was deleted after login', async () => {
    const { client, login } = await registerAndLogin({ email: 'gone@example.com' });
    await prisma.user.delete({ where: { id: login.json.user.id } });
    assert.equal((await client.get('/api/auth/me')).status, 401);
  });
});

describe('POST /api/auth/logout', () => {
  test('clears the cookie so /me returns 401', async () => {
    const { client, login } = await registerAndLogin({ email: 'logout@example.com' });
    assert.equal((await client.get('/api/auth/me')).status, 200);

    const res = await client.post('/api/auth/logout', undefined, csrf(login.json.csrfToken));
    assert.equal(res.status, 204);
    const cleared = res.setCookies.find((c) => c.startsWith(`${COOKIE}=`));
    assert.ok(cleared && /Expires=Thu, 01 Jan 1970/i.test(cleared), 'cookie should be expired');
    assert.equal(client.cookie(COOKIE), undefined);
    assert.equal((await client.get('/api/auth/me')).status, 401);
  });

  test('logout without a session is harmless', async () => {
    const res = await newClient().post('/api/auth/logout');
    assert.equal(res.status, 204);
  });
});

describe('CSRF protection', () => {
  test('state-changing request with a session but no CSRF token is rejected', async () => {
    const { client } = await registerAndLogin({ email: 'csrf1@example.com' });
    const res = await client.post('/api/auth/logout');
    assert.equal(res.status, 403);
    assert.equal((await client.get('/api/auth/me')).status, 200, 'session must remain intact');
  });

  test('wrong or foreign CSRF token is rejected', async () => {
    const a = await registerAndLogin({ email: 'csrf2a@example.com' });
    const b = await registerAndLogin({ email: 'csrf2b@example.com' });
    assert.equal((await a.client.post('/api/auth/logout', undefined, csrf('nope'))).status, 403);
    assert.equal((await a.client.post('/api/auth/logout', undefined, csrf(b.login.json.csrfToken))).status, 403);
    assert.equal((await a.client.post('/api/auth/logout', undefined, csrf(a.login.json.csrfToken))).status, 204);
  });

  test('cross-site Origin is rejected, even without a session', async () => {
    const res = await newClient().post('/api/auth/login', { email: 'x@example.com', password: 'whatever12' }, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(res.status, 403);
    assert.deepEqual(res.json, { error: 'Forbidden' });
  });

  test('cross-site Origin with a valid session and valid token is still rejected', async () => {
    const { client, login } = await registerAndLogin({ email: 'csrf3@example.com' });
    const res = await client.post('/api/auth/logout', undefined, {
      headers: { Origin: 'https://evil.example', 'X-CSRF-Token': login.json.csrfToken },
    });
    assert.equal(res.status, 403);
  });

  test('allowed Origin works', async () => {
    const res = await newClient().post('/api/auth/register', validUser({ email: 'origin@example.com' }), {
      headers: { Origin: ORIGIN },
    });
    assert.equal(res.status, 201);
  });

  test('safe GET requests do not need a CSRF token', async () => {
    const { client } = await registerAndLogin({ email: 'csrf4@example.com' });
    assert.equal((await client.get('/api/auth/me')).status, 200);
    assert.equal((await client.get('/api/books')).status, 200);
  });

  test('CORS allows credentials only for the configured client origin', async () => {
    const ok = await fetch(`${ctx.baseUrl}/api/health`, { headers: { Origin: ORIGIN } });
    assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(ok.headers.get('access-control-allow-credentials'), 'true');
    const evil = await fetch(`${ctx.baseUrl}/api/health`, { headers: { Origin: 'https://evil.example' } });
    assert.notEqual(evil.headers.get('access-control-allow-origin'), 'https://evil.example');
  });
});

describe('role-based access (requireRole)', () => {
  test('requireAuth + requireRole: CUSTOMER gets 403, ADMIN passes, anonymous gets 401', async () => {
    const { requireAuth } = await import('../src/middleware/auth.js');
    const { requireRole } = await import('../src/middleware/auth.js');
    const { default: express } = await import('express');
    const cookieParser = (await import('cookie-parser')).default;
    const { errorHandler } = await import('../src/middleware/errorHandler.js');

    const app = express();
    app.use(cookieParser());
    app.get('/admin-only', requireAuth, requireRole('ADMIN'), (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);
    const server = await new Promise((r) => {
      const s = app.listen(0, '127.0.0.1', () => r(s));
    });
    const url = `http://127.0.0.1:${server.address().port}/admin-only`;

    try {
      const customer = await registerAndLogin({ email: 'cust@example.com' });
      const admin = await registerAndLogin({ email: 'admin@example.com' });
      await prisma.user.update({ where: { email: 'admin@example.com' }, data: { role: 'ADMIN' } });

      const call = (client) =>
        fetch(url, { headers: client ? { Cookie: `${COOKIE}=${client.cookie(COOKIE)}` } : {} });
      assert.equal((await call(null)).status, 401);
      assert.equal((await call(customer.client)).status, 403);
      assert.equal((await call(admin.client)).status, 200);

      // Role changes apply immediately because the role is read from the database, not from the token.
      await prisma.user.update({ where: { email: 'admin@example.com' }, data: { role: 'CUSTOMER' } });
      assert.equal((await call(admin.client)).status, 403);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe('create-admin script helpers', () => {
  test('hashPassword produces a verifiable bcrypt hash and admin role can be stored', async () => {
    const hash = await hashPassword('Admin-Passw0rd!');
    assert.match(hash, /^\$2[aby]\$12\$/);
    const u = await prisma.user.create({
      data: {
        firstName: 'Ad',
        lastName: 'Min',
        email: 'created-admin@example.com',
        passwordHash: hash,
        role: 'ADMIN',
      },
    });
    assert.equal(u.role, 'ADMIN');
  });

  test('database in use is the dedicated test database', () => {
    assert.ok(process.env.DATABASE_URL.includes('bookstore_test'));
  });
});
