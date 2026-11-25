// Seeds the demonstration catalogue into the development database ONLY.
// Fails closed: it refuses to write unless the target is exactly "bookstore" on a loopback host, and the
// live connection (SELECT current_database()) confirms the same name before any seed write happens.
// Run:  npm run db:seed
import '../src/config/env.js';
import { prisma } from '../src/lib/prisma.js';
import { seedCatalogue } from '../src/seed/catalogue.js';

const EXPECTED_DB = 'bookstore';
const REJECTED_DBS = ['bookstore_test'];
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

class SeedSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SeedSafetyError';
  }
}

/** Static check of the configured URL. Never includes the URL or any credential in an error message. */
function assertConfiguredTarget() {
  if (process.env.NODE_ENV === 'test') {
    throw new SeedSafetyError('NODE_ENV is "test"; the demonstration seed must not run in test mode.');
  }

  let parsed;
  try {
    parsed = new URL(process.env.DATABASE_URL ?? '');
  } catch {
    throw new SeedSafetyError('DATABASE_URL is missing or malformed; cannot verify the target database.');
  }

  if (!['postgresql:', 'postgres:'].includes(parsed.protocol)) {
    throw new SeedSafetyError('DATABASE_URL must use the postgresql:// scheme.');
  }
  if (!LOCAL_HOSTS.includes(parsed.hostname.toLowerCase())) {
    throw new SeedSafetyError(`Host "${parsed.hostname}" is not a loopback address.`);
  }

  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (REJECTED_DBS.includes(dbName)) {
    throw new SeedSafetyError(`Target database "${dbName}" is explicitly rejected for seeding.`);
  }
  if (dbName !== EXPECTED_DB) {
    throw new SeedSafetyError(`Target database is "${dbName}", but exactly "${EXPECTED_DB}" is required.`);
  }
}

/** Live check: the connection that will perform the writes must really be connected to the expected database. */
async function assertConnectedDatabase() {
  let rows;
  try {
    rows = await prisma.$queryRaw`SELECT current_database() AS db_name`;
  } catch (err) {
    // Report only the error class; the message can echo connection details.
    throw new SeedSafetyError(`Could not verify the connected database (${err.name}); refusing to write.`);
  }
  const actual = rows?.[0]?.db_name;
  if (actual !== EXPECTED_DB) {
    throw new SeedSafetyError(`Connected database is "${actual}", but exactly "${EXPECTED_DB}" is required.`);
  }
}

try {
  assertConfiguredTarget();
  await assertConnectedDatabase();
  console.info(`Verified target database "${EXPECTED_DB}". Seeding...`);

  const { books, inserted } = await seedCatalogue();
  console.info(`Seed complete: ${books} books in catalogue, ${inserted} newly added, existing books untouched`);
} catch (err) {
  // Print only the message of our own safety errors; for anything else print the class, never connection details.
  console.error('Seed failed:', err instanceof SeedSafetyError ? err.message : err.name);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
