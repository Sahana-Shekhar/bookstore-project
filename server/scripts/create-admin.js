// Creates (or promotes) an ADMIN account. Credentials come from the environment, never from source code:
//   ADMIN_EMAIL, ADMIN_PASSWORD, and optionally ADMIN_FIRST_NAME / ADMIN_LAST_NAME.
// Run:  $env:ADMIN_EMAIL='you@example.com'; $env:ADMIN_PASSWORD='<strong password>'; npm run create-admin
import '../src/config/env.js';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword } from '../src/services/auth.service.js';
import { loginSchema, passwordSchema } from '../src/validators/auth.validators.js';

try {
  const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_FIRST_NAME = 'Admin', ADMIN_LAST_NAME = 'User' } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD in the environment first.');
  }
  const { email } = loginSchema.pick({ email: true }).parse({ email: ADMIN_EMAIL });
  passwordSchema.parse(ADMIN_PASSWORD);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    // Never changes an existing password; only promotes the role.
    await prisma.user.update({
      where: { email },
      data: { role: 'ADMIN' },
    });
    console.info('Existing user promoted to ADMIN.');
  } else {
    await prisma.user.create({
      data: {
        firstName: ADMIN_FIRST_NAME,
        lastName: ADMIN_LAST_NAME,
        email,
        passwordHash: await hashPassword(ADMIN_PASSWORD),
        role: 'ADMIN',
      },
    });
    console.info('Admin account created.');
  }
} catch (err) {
  // Never print err.message for non-validation errors: Prisma/driver messages can echo connection details or
  // record values. Show only the error class (and Prisma/driver code, if any).
  const safe = err.name === 'ZodError'
    ? 'invalid email or password format'
    : err.message === 'Set ADMIN_EMAIL and ADMIN_PASSWORD in the environment first.'
      ? err.message
      : `${err.name || 'Error'}${err.code ? ` (${err.code})` : ''}`;
  console.error('create-admin failed:', safe);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
