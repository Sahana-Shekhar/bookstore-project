import '../src/config/env.js';
import { MongoClient } from 'mongodb';
import { prisma } from '../src/lib/prisma.js';
import { URL } from 'node:url';

// Define FatalSafetyError to prevent swallowing safety violations
class FatalSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FatalSafetyError';
  }
}

/**
 * Safe description of an unexpected error for console output. Raw messages from Prisma, the MongoDB driver
 * and the URL parser can echo connection details or record values, so only the error class and code are shown.
 * FatalSafetyError messages are written by this script and never contain credentials, so they are kept.
 */
function describeError(err) {
  if (err instanceof FatalSafetyError) return err.message;
  const name = err?.name || 'Error';
  return err?.code ? `${name} (${err.code})` : name;
}

/** Host(s) and database name of a MongoDB URI, with any credentials, scheme and query parameters removed. */
function describeMongoTarget(uri) {
  const m = /^mongodb(?:\+srv)?:\/\/([^/?]*)(?:\/([^?]*))?/i.exec(uri || '');
  if (!m) return '[unparseable MongoDB URI]';
  const authority = m[1];
  const hosts = authority.slice(authority.lastIndexOf('@') + 1);
  return `${hosts || '[no host]'}/${m[2] || '(default database)'}`;
}

const isDryRun = process.argv.includes('--dry-run');
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/bookstore';

// 1. Decoupled Connection Verification (Runs in both Dry-Run and Migration modes)
async function verifyDatabaseConnection() {
  // Static checks
  if (process.env.NODE_ENV === 'test') {
    throw new FatalSafetyError('CRITICAL Database protection check failed: NODE_ENV is set to "test". Database connection aborted.');
  }

  const dbUrlStr = process.env.DATABASE_URL;
  if (!dbUrlStr) {
    throw new FatalSafetyError('CRITICAL Database protection check failed: DATABASE_URL is not set. Database connection aborted.');
  }

  try {
    const parsed = new URL(dbUrlStr);
    
    // Require loopback host
    const hostname = parsed.hostname;
    const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (!isLoopback) {
      throw new FatalSafetyError(`CRITICAL Database protection check failed: host "${hostname}" is not a loopback address. Database connection aborted.`);
    }

    // Require the exact expected development database name
    const dbName = parsed.pathname.replace(/^\//, '').split('?')[0];
    if (dbName !== 'bookstore') {
      throw new FatalSafetyError(`CRITICAL Database protection check failed: database name is "${dbName}", but expected "bookstore". Database connection aborted.`);
    }
  } catch (err) {
    if (err instanceof FatalSafetyError) throw err;
    throw new FatalSafetyError(`CRITICAL Database URL validation failed: ${describeError(err)}. Database connection aborted.`);
  }

  // Active runtime query check
  try {
    const result = await prisma.$queryRaw`SELECT current_database() as db_name`;
    const dbName = result[0]?.db_name;
    if (dbName !== 'bookstore') {
      throw new FatalSafetyError(`CRITICAL Connected database is "${dbName}", expected "bookstore". Database connection aborted.`);
    }
  } catch (err) {
    if (err instanceof FatalSafetyError) throw err;
    throw new FatalSafetyError(`CRITICAL Active database identity query failed: ${describeError(err)}. Database connection aborted.`);
  }
}

// 2. Decoupled Write Permission Assertion (Asserted before every write attempt)
async function assertWritePermission() {
  if (isDryRun) {
    throw new FatalSafetyError('CRITICAL Attempted database write operation while dry-run mode is enabled.');
  }
  // Double-verify connection integrity immediately before write
  await verifyDatabaseConnection();
}

// 3. Monetary and Quantity Validation Helpers
function validateMonetaryValue(val, fieldName) {
  if (val === undefined || val === null) {
    throw new Error(`Field "${fieldName}" is missing or null.`);
  }
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new Error(`Field "${fieldName}" must be a finite number.`);
  }
  if (!Number.isSafeInteger(val)) {
    throw new Error(`Field "${fieldName}" must be a safe integer.`);
  }
  if (val < 0) {
    throw new Error(`Field "${fieldName}" must be a positive/non-negative integer.`);
  }
  if (val > 2147483647) {
    throw new Error(`Field "${fieldName}" exceeds PostgreSQL INTEGER maximum limit (2,147,483,647).`);
  }
  return val;
}

function validateLineTotal(qty, unitPrice, lineTotal, orderNo) {
  validateMonetaryValue(qty, 'quantity');
  validateMonetaryValue(unitPrice, 'unitPrice');
  validateMonetaryValue(lineTotal, 'lineTotal');

  // Assert multiplication bounds
  const expectedProduct = qty * unitPrice;
  if (expectedProduct > 2147483647) {
    throw new Error(`Multiplication overflow in Order "${orderNo}": quantity * unitPrice exceeds PostgreSQL maximum.`);
  }
  if (expectedProduct !== lineTotal) {
    throw new Error(`Mathematical integrity error in Order "${orderNo}": lineTotal (${lineTotal}) does not match quantity (${qty}) * unitPrice (${unitPrice}).`);
  }
}

async function run() {
  console.info(`--- Starting Database Migration: MongoDB to PostgreSQL ---`);
  console.info(`MongoDB source: ${describeMongoTarget(mongoUri)}`);
  console.info(`Dry Run: ${isDryRun ? 'ENABLED (Writeless: No modifications will be made)' : 'DISABLED'}`);

  let mongoClient;
  let exitCode = 0;

  try {
    // Connection and database context validation in both dry-run and migration modes
    await verifyDatabaseConnection();

    mongoClient = new MongoClient(mongoUri);
    await mongoClient.connect();
    const db = mongoClient.db();

    const report = {
      users: { source: 0, migrated: 0, skipped: 0, failed: 0, reconciliationRequired: 0 },
      categories: { source: 0, migrated: 0, skipped: 0, failed: 0, reconciliationRequired: 0 },
      authors: { source: 0, migrated: 0, skipped: 0, failed: 0, reconciliationRequired: 0 },
      books: { source: 0, migrated: 0, skipped: 0, failed: 0, reconciliationRequired: 0 },
      orders: { source: 0, migrated: 0, skipped: 0, failed: 0, reconciliationRequired: 0 },
    };

    let totalWarnings = 0;

    // 1. Migrate Users
    console.info('\nMigrating Users...');
    const mongoUsers = await db.collection('users').find({}).toArray();
    report.users.source = mongoUsers.length;

    const userMap = new Map(); // mongodbIdString -> pgUuidString
    for (const u of mongoUsers) {
      const mongoIdStr = u._id.toString();

      // Validation
      if (!u.email || typeof u.email !== 'string' || u.email.trim().length === 0) {
        console.error(`Validation Error: User "${mongoIdStr}" has missing or empty email.`);
        report.users.failed++;
        exitCode = 1;
        continue;
      }
      if (!u.firstName || !u.lastName) {
        console.error(`Validation Error: User "${mongoIdStr}" is missing firstName or lastName.`);
        report.users.failed++;
        exitCode = 1;
        continue;
      }
      if (!u.passwordHash || !/^\$2[aby]\$12\$/.test(u.passwordHash)) {
        console.warn(`Validation Warning: User "${u.email}" passwordHash is invalid or not using standard bcrypt cost.`);
        totalWarnings++;
      }

      try {
        // Resolve by mongodbId first
        let existing = await prisma.user.findUnique({ where: { mongodbId: mongoIdStr } });
        if (existing) {
          userMap.set(mongoIdStr, existing.id);
          report.users.skipped++;
          continue;
        }

        // Check unique constraint matching (do not automatically link)
        const byEmail = await prisma.user.findUnique({ where: { email: u.email } });
        if (byEmail) {
          if (byEmail.mongodbId === mongoIdStr) {
            userMap.set(mongoIdStr, byEmail.id);
            report.users.skipped++;
            continue;
          } else {
            // Flag for manual reconciliation and skip to prevent overwriting/associating bad data
            console.error(`Reconciliation Required: User with email "${u.email}" exists in Postgres (id: "${byEmail.id}") but has a different or missing mongodbId. Source has "${mongoIdStr}". Skipping.`);
            report.users.reconciliationRequired++;
            exitCode = 1;
            continue;
          }
        }

        if (!isDryRun) {
          await assertWritePermission();
          const created = await prisma.user.create({
            data: {
              mongodbId: mongoIdStr,
              firstName: u.firstName.trim(),
              lastName: u.lastName.trim(),
              email: u.email.trim().toLowerCase(),
              passwordHash: u.passwordHash,
              role: u.role === 'ADMIN' ? 'ADMIN' : 'CUSTOMER',
              createdAt: u.createdAt || new Date(),
              updatedAt: u.updatedAt || new Date(),
            },
          });
          userMap.set(mongoIdStr, created.id);
          report.users.migrated++;
        } else {
          report.users.migrated++;
        }
      } catch (err) {
        if (err instanceof FatalSafetyError) throw err;
        console.error(`Failed to migrate User "${u.email}":`, describeError(err));
        report.users.failed++;
        exitCode = 1;
      }
    }

    // 2. Migrate Categories
    console.info('Migrating Categories...');
    const mongoCategories = await db.collection('categories').find({}).toArray();
    report.categories.source = mongoCategories.length;

    const categoryMap = new Map();
    for (const c of mongoCategories) {
      const mongoIdStr = c._id.toString();

      if (!c.name || !c.slug || typeof c.slug !== 'string' || c.slug.trim().length === 0) {
        console.error(`Validation Error: Category "${mongoIdStr}" has empty name or slug.`);
        report.categories.failed++;
        exitCode = 1;
        continue;
      }

      try {
        // Resolve by mongodbId first
        let existing = await prisma.category.findUnique({ where: { mongodbId: mongoIdStr } });
        if (existing) {
          categoryMap.set(mongoIdStr, existing.id);
          report.categories.skipped++;
          continue;
        }

        // Check unique slug constraint (do not automatically link)
        const bySlug = await prisma.category.findUnique({ where: { slug: c.slug } });
        if (bySlug) {
          if (bySlug.mongodbId === mongoIdStr) {
            categoryMap.set(mongoIdStr, bySlug.id);
            report.categories.skipped++;
            continue;
          } else {
            console.error(`Reconciliation Required: Category with slug "${c.slug}" exists in Postgres (id: "${bySlug.id}") but has a different or missing mongodbId. Source has "${mongoIdStr}". Skipping.`);
            report.categories.reconciliationRequired++;
            exitCode = 1;
            continue;
          }
        }

        if (!isDryRun) {
          await assertWritePermission();
          const created = await prisma.category.create({
            data: {
              mongodbId: mongoIdStr,
              name: c.name.trim(),
              slug: c.slug.trim().toLowerCase(),
              createdAt: c.createdAt || new Date(),
              updatedAt: c.createdAt || new Date(),
            },
          });
          categoryMap.set(mongoIdStr, created.id);
          report.categories.migrated++;
        } else {
          report.categories.migrated++;
        }
      } catch (err) {
        if (err instanceof FatalSafetyError) throw err;
        console.error(`Failed to migrate Category "${c.slug}":`, describeError(err));
        report.categories.failed++;
        exitCode = 1;
      }
    }

    // 3. Migrate Authors
    console.info('Migrating Authors...');
    const mongoAuthors = await db.collection('authors').find({}).toArray();
    report.authors.source = mongoAuthors.length;

    const authorMap = new Map();
    for (const a of mongoAuthors) {
      const mongoIdStr = a._id.toString();

      if (!a.name || typeof a.name !== 'string' || a.name.trim().length === 0) {
        console.error(`Validation Error: Author "${mongoIdStr}" has empty name.`);
        report.authors.failed++;
        exitCode = 1;
        continue;
      }

      try {
        // Resolve by mongodbId first
        let existing = await prisma.author.findUnique({ where: { mongodbId: mongoIdStr } });
        if (existing) {
          authorMap.set(mongoIdStr, existing.id);
          report.authors.skipped++;
          continue;
        }

        // Check unique name constraint
        const byName = await prisma.author.findUnique({ where: { name: a.name } });
        if (byName) {
          if (byName.mongodbId === mongoIdStr) {
            authorMap.set(mongoIdStr, byName.id);
            report.authors.skipped++;
            continue;
          } else {
            console.error(`Reconciliation Required: Author with name "${a.name}" exists in Postgres (id: "${byName.id}") but has a different or missing mongodbId. Source has "${mongoIdStr}". Skipping.`);
            report.authors.reconciliationRequired++;
            exitCode = 1;
            continue;
          }
        }

        if (!isDryRun) {
          await assertWritePermission();
          const created = await prisma.author.create({
            data: {
              mongodbId: mongoIdStr,
              name: a.name.trim(),
              createdAt: a.createdAt || new Date(),
              updatedAt: a.updatedAt || new Date(),
            },
          });
          authorMap.set(mongoIdStr, created.id);
          report.authors.migrated++;
        } else {
          report.authors.migrated++;
        }
      } catch (err) {
        if (err instanceof FatalSafetyError) throw err;
        console.error(`Failed to migrate Author "${a.name}":`, describeError(err));
        report.authors.failed++;
        exitCode = 1;
      }
    }

    // 4. Migrate Books
    console.info('Migrating Books...');
    const mongoBooks = await db.collection('books').find({}).toArray();
    report.books.source = mongoBooks.length;

    const bookMap = new Map();
    for (const b of mongoBooks) {
      const mongoIdStr = b._id.toString();

      // Validation
      if (!b.title || !b.isbn || typeof b.isbn !== 'string' || b.isbn.trim().length === 0) {
        console.error(`Validation Error: Book "${mongoIdStr}" has empty title or isbn.`);
        report.books.failed++;
        exitCode = 1;
        continue;
      }

      // Explicit monetary validation check (No default fallback OR assumptions)
      let price;
      try {
        price = validateMonetaryValue(b.priceCents, 'priceCents');
      } catch (valErr) {
        console.error(`Validation Error: Book "${b.title}" has invalid monetary pricing:`, valErr.message);
        report.books.failed++;
        exitCode = 1;
        continue;
      }

      if (typeof b.stock !== 'number' || !Number.isSafeInteger(b.stock) || b.stock < 0 || b.stock > 2147483647) {
        console.error(`Validation Error: Book "${b.title}" has invalid stock: ${b.stock}`);
        report.books.failed++;
        exitCode = 1;
        continue;
      }

      const pgAuthorId = authorMap.get(b.author?.toString());
      const pgCategoryId = categoryMap.get(b.category?.toString());

      if (!pgAuthorId || !pgCategoryId) {
        console.error(`Broken Active Reference Error: Book "${b.title}" refers to missing Category or Author.`);
        report.books.failed++;
        exitCode = 1;
        continue;
      }

      try {
        // Resolve by mongodbId first
        let existing = await prisma.book.findUnique({ where: { mongodbId: mongoIdStr } });
        if (existing) {
          bookMap.set(mongoIdStr, existing.id);
          report.books.skipped++;
          continue;
        }

        // Check unique isbn constraint
        const byIsbn = await prisma.book.findUnique({ where: { isbn: b.isbn } });
        if (byIsbn) {
          if (byIsbn.mongodbId === mongoIdStr) {
            bookMap.set(mongoIdStr, byIsbn.id);
            report.books.skipped++;
            continue;
          } else {
            console.error(`Reconciliation Required: Book with ISBN "${b.isbn}" exists in Postgres (id: "${byIsbn.id}") but has a different or missing mongodbId. Source has "${mongoIdStr}". Skipping.`);
            report.books.reconciliationRequired++;
            exitCode = 1;
            continue;
          }
        }

        if (!isDryRun) {
          await assertWritePermission();
          const created = await prisma.book.create({
            data: {
              mongodbId: mongoIdStr,
              title: b.title.trim(),
              isbn: b.isbn.trim(),
              description: b.description || 'N/A',
              priceCents: price,
              stock: b.stock,
              coverUrl: b.coverUrl,
              authorId: pgAuthorId,
              categoryId: pgCategoryId,
              createdAt: b.createdAt || new Date(),
              updatedAt: b.updatedAt || new Date(),
            },
          });
          bookMap.set(mongoIdStr, created.id);
          report.books.migrated++;
        } else {
          report.books.migrated++;
        }
      } catch (err) {
        if (err instanceof FatalSafetyError) throw err;
        console.error(`Failed to migrate Book "${b.title}":`, describeError(err));
        report.books.failed++;
        exitCode = 1;
      }
    }

    // 5. Migrate Orders
    console.info('Migrating Orders...');
    const mongoOrders = await db.collection('orders').find({}).toArray();
    report.orders.source = mongoOrders.length;

    for (const o of mongoOrders) {
      const mongoIdStr = o._id.toString();

      // Validation
      if (!o.orderNumber || typeof o.orderNumber !== 'string' || o.orderNumber.trim().length === 0) {
        console.error(`Validation Error: Order "${mongoIdStr}" is missing orderNumber.`);
        report.orders.failed++;
        exitCode = 1;
        continue;
      }

      const pgUserId = userMap.get(o.user?.toString());
      if (o.user && !pgUserId) {
        console.warn(`Validation Warning: Order "${o.orderNumber}" references a User ID "${o.user}" that was not migrated.`);
        totalWarnings++;
      }

      // Explicit, strict monetary extraction (No logical OR or raw assumptions)
      let subtotal, total;
      try {
        const rawSub = o.subtotalPaise !== undefined && o.subtotalPaise !== null ? o.subtotalPaise : o.subtotalCents;
        const rawTot = o.totalPaise !== undefined && o.totalPaise !== null ? o.totalPaise : o.totalCents;

        subtotal = validateMonetaryValue(rawSub, 'subtotalPaise');
        total = validateMonetaryValue(rawTot, 'totalPaise');
      } catch (valErr) {
        console.error(`Validation Error: Order "${o.orderNumber}" has invalid subtotal/total values:`, valErr.message);
        report.orders.failed++;
        exitCode = 1;
        continue;
      }

      // Validate address fields completeness
      const isAddressIncomplete = !o.shippingAddress?.street || !o.shippingAddress?.city || 
                                 !o.shippingAddress?.state || !o.shippingAddress?.postalCode || 
                                 !o.shippingAddress?.country;
      if (isAddressIncomplete) {
        console.warn(`Validation Warning: Order "${o.orderNumber}" has incomplete shipping address.`);
        totalWarnings++;
      }

      // Create Postgres mapped order items array and calculate sum
      const orderItems = [];
      let itemsValid = true;
      let calculatedSubtotalSum = 0;

      for (const item of o.items || []) {
        const pgBookId = bookMap.get(item.book?.toString());
        if (!pgBookId && item.book) {
          // Legitimate historical null reference: book was deleted, which is expected for historical snapshots
          console.info(`Historical Reference Notice: Book reference in Order Item "${item.title}" mapped to NULL (historical record).`);
        }
        
        try {
          const qty = item.quantity;
          if (typeof qty !== 'number' || !Number.isFinite(qty) || !Number.isSafeInteger(qty) || qty <= 0 || qty > 2147483647) {
            throw new Error(`Invalid item quantity: ${qty}. Must be a positive safe integer within PostgreSQL limits.`);
          }

          const unitPrice = item.unitPricePaise !== undefined && item.unitPricePaise !== null ? item.unitPricePaise : item.unitPriceCents;
          const lineTotal = item.lineTotalPaise !== undefined && item.lineTotalPaise !== null ? item.lineTotalPaise : item.lineTotalCents;

          // Double checking safe bounds and multiplication product equality before commit
          validateLineTotal(qty, unitPrice, lineTotal, o.orderNumber);

          // Add to running subtotal sum with safe checks
          calculatedSubtotalSum += lineTotal;
          if (!Number.isSafeInteger(calculatedSubtotalSum) || calculatedSubtotalSum > 2147483647) {
            throw new Error(`Running subtotal calculation overflowed PostgreSQL limit.`);
          }

          orderItems.push({
            bookId: pgBookId || null,
            title: item.title,
            quantity: qty,
            unitPricePaise: unitPrice,
            lineTotalPaise: lineTotal,
          });
        } catch (itemErr) {
          console.error(`Validation Error: Order Item "${item.title}" in Order "${o.orderNumber}" is corrupt:`, itemErr.message);
          itemsValid = false;
        }
      }

      if (!itemsValid || orderItems.length === 0) {
        console.error(`Validation Error: Order "${o.orderNumber}" has no valid items.`);
        report.orders.failed++;
        exitCode = 1;
        continue;
      }

      // Assert financial reconciliation: subtotal exactly equals sum of line totals
      if (subtotal !== calculatedSubtotalSum) {
        console.error(`Reconciliation Error: Order "${o.orderNumber}" subtotal (${subtotal}) does not match calculated sum of line totals (${calculatedSubtotalSum}). Skipping.`);
        report.orders.reconciliationRequired++;
        exitCode = 1;
        continue;
      }

      // Assert pricing rule: total matches subtotal exactly (as per e-commerce e2e guidelines)
      if (subtotal !== total) {
        console.error(`Reconciliation Error: Order "${o.orderNumber}" total (${total}) does not match subtotal (${subtotal}). Skipping.`);
        report.orders.reconciliationRequired++;
        exitCode = 1;
        continue;
      }

      try {
        // Resolve by mongodbId first
        let existing = await prisma.order.findUnique({ where: { mongodbId: mongoIdStr } });
        if (existing) {
          report.orders.skipped++;
          continue;
        }

        // Check unique orderNumber constraint
        const byOrderNumber = await prisma.order.findUnique({ where: { orderNumber: o.orderNumber } });
        if (byOrderNumber) {
          if (byOrderNumber.mongodbId === mongoIdStr) {
            report.orders.skipped++;
            continue;
          } else {
            console.error(`Reconciliation Required: Order with number "${o.orderNumber}" exists in Postgres (id: "${byOrderNumber.id}") but has a different or missing mongodbId. Source has "${mongoIdStr}". Skipping.`);
            report.orders.reconciliationRequired++;
            exitCode = 1;
            continue;
          }
        }

        if (!isDryRun) {
          await assertWritePermission();
          await prisma.order.create({
            data: {
              mongodbId: mongoIdStr,
              orderNumber: o.orderNumber.trim(),
              userId: pgUserId || null,
              subtotalPaise: subtotal,
              totalPaise: total,
              status: o.status || 'PLACED',
              paymentStatus: o.paymentStatus || 'COMPLETED',
              shippingAddressStreet: o.shippingAddress?.street?.trim() || 'N/A',
              shippingAddressCity: o.shippingAddress?.city?.trim() || 'N/A',
              shippingAddressState: o.shippingAddress?.state?.trim() || 'N/A',
              shippingAddressPostalCode: o.shippingAddress?.postalCode?.trim() || 'N/A',
              shippingAddressCountry: o.shippingAddress?.country?.trim() || 'N/A',
              createdAt: o.createdAt || new Date(),
              updatedAt: o.updatedAt || new Date(),
              items: {
                create: orderItems,
              },
            },
          });
          report.orders.migrated++;
        } else {
          report.orders.migrated++;
        }
      } catch (err) {
        if (err instanceof FatalSafetyError) throw err;
        console.error(`Failed to migrate Order "${o.orderNumber}":`, describeError(err));
        report.orders.failed++;
        exitCode = 1;
      }
    }

    console.info('\n--- Data Migration Reconciliation Report ---');
    console.info(`Users:      Source = ${report.users.source} | Migrated = ${report.users.migrated} | Skipped = ${report.users.skipped} | Conflicts = ${report.users.reconciliationRequired} | Failures = ${report.users.failed}`);
    console.info(`Categories: Source = ${report.categories.source} | Migrated = ${report.categories.migrated} | Skipped = ${report.categories.skipped} | Conflicts = ${report.categories.reconciliationRequired} | Failures = ${report.categories.failed}`);
    console.info(`Authors:    Source = ${report.authors.source} | Migrated = ${report.authors.migrated} | Skipped = ${report.authors.skipped} | Conflicts = ${report.authors.reconciliationRequired} | Failures = ${report.authors.failed}`);
    console.info(`Books:      Source = ${report.books.source} | Migrated = ${report.books.migrated} | Skipped = ${report.books.skipped} | Conflicts = ${report.books.reconciliationRequired} | Failures = ${report.books.failed}`);
    console.info(`Orders:     Source = ${report.orders.source} | Migrated = ${report.orders.migrated} | Skipped = ${report.orders.skipped} | Conflicts = ${report.orders.reconciliationRequired} | Failures = ${report.orders.failed}`);
    console.info(`Total Warnings Reported: ${totalWarnings}`);
    
    if (exitCode !== 0) {
      console.warn('\nMigration completed with unresolved conflicts, failures, or validation errors.');
    } else {
      console.info('\nMigration completed successfully with zero unresolved conflicts or schema failures.');
    }

  } catch (err) {
    console.error('CRITICAL: Migration run aborted:', describeError(err));
    exitCode = 1;
  } finally {
    if (mongoClient) await mongoClient.close();
    await prisma.$disconnect();
    process.exitCode = exitCode;
  }
}

run();
