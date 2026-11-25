// Test helper. Runs against a SEPARATE database and refuses to touch anything else.
// Must be imported before any application module, because the app reads process.env on import.
import assert from 'node:assert/strict';

const DEFAULT_DEV_DB = 'bookstore';
const DEFAULT_TEST_DB = 'bookstore_test';
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];
const VALID_PROTOCOLS = ['postgresql:', 'postgres:'];

/**
 * Validates a connection URL for protocol, local-only host, and structural well-formedness.
 * Throws clean errors without credentials on failure.
 */
function validateDatabaseUrl(urlStr, expectedDbName = null) {
  if (!urlStr) {
    throw new Error('CRITICAL: Database validation failed. URL string is missing.');
  }

  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch (err) {
    throw new Error('CRITICAL: Database validation failed. URL is malformed.');
  }

  // 1. Verify protocol is strictly PostgreSQL
  const protocol = parsed.protocol.toLowerCase();
  if (!VALID_PROTOCOLS.includes(protocol)) {
    throw new Error(`CRITICAL: Database validation failed. Protocol "${protocol}" is invalid. Expected "postgresql:" or "postgres:".`);
  }

  // 2. Verify hostname is strictly a local host
  const host = parsed.hostname.toLowerCase();
  if (!LOCAL_HOSTS.includes(host)) {
    throw new Error(`CRITICAL: Database validation failed. Host "${host}" is NOT a local host.`);
  }

  // 3. If an expected database name is provided, verify pathname matches exactly
  if (expectedDbName !== null) {
    const path = parsed.pathname;
    if (path !== `/${expectedDbName}`) {
      throw new Error(`CRITICAL: Database validation failed. Path "${path}" is NOT "/${expectedDbName}".`);
    }
  }

  return parsed;
}

// ==========================================
// 1. Validate the ORIGINAL DATABASE_URL synchronously before changing anything
// ==========================================
const originalUrl = process.env.DATABASE_URL;
if (!originalUrl) {
  throw new Error('CRITICAL: DATABASE_URL environment variable is missing.');
}

// Validate original URL and ensure its pathname is exactly "/bookstore"
const parsedOriginal = validateDatabaseUrl(originalUrl, DEFAULT_DEV_DB);

// ==========================================
// 2. Derive the test database URL only after original URL passes validation
// ==========================================
parsedOriginal.pathname = `/${DEFAULT_TEST_DB}`;
const derivedTestUrlStr = parsedOriginal.toString();

// ==========================================
// 3. Parse and run the final database guard on the derived test URL to verify path and host
// ==========================================
validateDatabaseUrl(derivedTestUrlStr, DEFAULT_TEST_DB);

// ==========================================
// 4. Update the environment variables
// ==========================================
process.env.DATABASE_URL = derivedTestUrlStr;
process.env.NODE_ENV = 'test';
process.env.AUTH_RATE_LIMIT ??= '1000';

// ==========================================
// 5. Dynamically import application and Prisma modules ONLY after validation passes
// ==========================================
const { default: app } = await import('../src/app.js');
const { env } = await import('../src/config/env.js');
const { prisma } = await import('../src/lib/prisma.js');

export { app, env, prisma };
export const ORIGIN = env.CLIENT_ORIGIN[0];

/** Safety guard executed before database mutations or tests. */
export function assertTestDatabase() {
  const activeUrl = process.env.DATABASE_URL;
  validateDatabaseUrl(activeUrl, DEFAULT_TEST_DB);
}

/** 
 * Synced allowlist of actual PostgreSQL table names defined in schema.prisma.
 * Hardcoded and immutable; rejects all external input to prevent SQL injection.
 */
const TABLE_ALLOWLIST = ['order_items', 'orders', 'books', 'authors', 'categories', 'users'];

async function cleanDatabase() {
  assertTestDatabase();

  // Active PostgreSQL connection identity check using Prisma
  const result = await prisma.$queryRaw`
    SELECT current_database() AS db_name
  `;
  if (result[0]?.db_name !== 'bookstore_test') {
    throw new Error(
      'Database safety check failed: connected database is not bookstore_test.'
    );
  }

  for (const table of TABLE_ALLOWLIST) {
    assertTestDatabase();
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE;`);
  }
}

export async function startTestServer() {
  assertTestDatabase();
  await cleanDatabase();

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    baseUrl,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      assertTestDatabase();
      await cleanDatabase();
      await prisma.$disconnect();
    },
  };
}

/** Minimal HTTP client that keeps cookies like a browser would. */
export function createClient(baseUrl) {
  let cookieHeader = '';
  const jar = new Map();

  async function request(method, path, { body, headers = {}, cookie } = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ?? cookieHeader ? { Cookie: cookie ?? cookieHeader } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const setCookies = res.headers.getSetCookie();
    for (const line of setCookies) {
      const [pair] = line.split(';');
      const [name, ...rest] = pair.split('=');
      const value = rest.join('=');
      if (value === '') jar.delete(name);
      else jar.set(name, value);
    }
    cookieHeader = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, headers: res.headers, setCookies, json, text };
  }

  return {
    request,
    get: (path, opts) => request('GET', path, opts),
    post: (path, body, opts = {}) => request('POST', path, { ...opts, body }),
    cookie: (name) => jar.get(name),
    clearCookies: () => {
      jar.clear();
      cookieHeader = '';
    },
  };
}

export const validUser = (overrides = {}) => ({
  firstName: 'Asha',
  lastName: 'Rao',
  email: 'asha@example.com',
  password: 'Str0ng-Passw0rd!',
  ...overrides,
});
