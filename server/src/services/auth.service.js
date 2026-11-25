import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { Prisma } from '@prisma/client';
import { HttpError } from '../middleware/errorHandler.js';

const BCRYPT_COST = 12;

export const hashPassword = (password) => bcrypt.hash(password, BCRYPT_COST);

// Used to spend the same time on a bcrypt comparison when the email is unknown,
// so response time does not reveal which emails are registered.
let dummyHashPromise;
const getDummyHash = () => (dummyHashPromise ??= bcrypt.hash('timing-equalisation-only', BCRYPT_COST));

/** Registration always creates a CUSTOMER, whatever the caller sends. */
export async function registerUser({ firstName, lastName, email, password }) {
  const passwordHash = await hashPassword(password);
  try {
    const user = await prisma.user.create({
      data: { firstName, lastName, email, passwordHash, role: 'CUSTOMER' },
    });
    delete user.passwordHash;
    return user;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new HttpError(409, 'An account with this email already exists');
    }
    throw err;
  }
}

/** Returns the user, or throws the same 401 for an unknown email and a wrong password. */
export async function authenticate({ email, password }) {
  const user = await prisma.user.findUnique({ where: { email } });
  const passwordMatches = await bcrypt.compare(password, user?.passwordHash ?? (await getDummyHash()));
  if (!user || !passwordMatches) {
    throw new HttpError(401, 'Invalid email or password');
  }
  delete user.passwordHash;
  return user;
}
