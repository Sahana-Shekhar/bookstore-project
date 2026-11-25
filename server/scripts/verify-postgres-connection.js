// Read-only connectivity check for the local PostgreSQL development and test databases.
// Reads DATABASE_URL from the normal environment configuration (never from source code) and never prints it.
// Run:  node --env-file=.env scripts/verify-postgres-connection.js
// It only executes `SELECT current_database()`; it performs no writes.
import { env } from '../src/config/env.js';
import { PrismaClient } from '@prisma/client';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const DEV_DB = 'bookstore';
const TEST_DB = 'bookstore_test';

function withDatabase(base, dbName, hostOverride) {
  const url = new URL(base.toString());
  url.pathname = `/${dbName}`;
  if (hostOverride) url.hostname = hostOverride;
  return url.toString();
}

async function testConnection(url, label, expectedDb) {
  const client = new PrismaClient({ datasources: { db: { url } }, log: [] });
  try {
    const rows = await client.$queryRaw`SELECT current_database() AS db_name`;
    const actual = rows[0]?.db_name;
    const ok = actual === expectedDb;
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}: connected database is "${actual}" (expected "${expectedDb}")`);
    return ok;
  } catch (err) {
    // Report only the error class and Prisma code, never the message (it can echo connection details).
    console.log(`[FAIL] ${label}: connection failed (${err.name}${err.code ? `, ${err.code}` : ''})`);
    return false;
  } finally {
    await client.$disconnect();
  }
}

async function run() {
  let base;
  try {
    base = new URL(env.DATABASE_URL);
  } catch {
    console.error('CRITICAL: DATABASE_URL is not a valid URL.');
    process.exit(1);
  }

  if (!['postgresql:', 'postgres:'].includes(base.protocol)) {
    console.error('CRITICAL: DATABASE_URL must use the postgresql:// scheme.');
    process.exit(1);
  }
  if (!LOCAL_HOSTS.includes(base.hostname.toLowerCase())) {
    console.error(`CRITICAL: Host "${base.hostname}" is NOT a local host.`);
    process.exit(1);
  }

  console.log('--- Connection Configuration ---');
  console.log(`Host:         ${base.hostname}`);
  console.log(`Port:         ${base.port || '5432'}`);
  console.log(`Dev DB:       ${DEV_DB}`);
  console.log(`Test DB:      ${TEST_DB}`);
  console.log('--------------------------------\n');

  let allOk = true;
  for (const [dbName, label] of [[DEV_DB, 'Development'], [TEST_DB, 'Test']]) {
    console.log(`Testing ${label} database ("${dbName}"):`);
    let ok = await testConnection(withDatabase(base, dbName), `${dbName} via "${base.hostname}"`, dbName);
    if (!ok && base.hostname.toLowerCase() === 'localhost') {
      ok = await testConnection(withDatabase(base, dbName, '127.0.0.1'), `${dbName} via "127.0.0.1"`, dbName);
    }
    allOk &&= ok;
    console.log('');
  }
  process.exitCode = allOk ? 0 : 1;
}

run().catch(() => {
  console.error('Verification failed unexpectedly.');
  process.exitCode = 1;
});
