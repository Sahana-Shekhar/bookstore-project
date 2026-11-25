import { prisma } from '../lib/prisma.js';
import { HttpError } from './errorHandler.js';
import { SESSION_COOKIE } from '../utils/cookies.js';
import { verifySession } from '../utils/jwt.js';

/** Requires a valid session cookie and loads the user fresh from the database. */
export async function requireAuth(req, _res, next) {
  const session = verifySession(req.cookies?.[SESSION_COOKIE]);
  if (!session) throw new HttpError(401, 'Authentication required');

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      role: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!user) throw new HttpError(401, 'Authentication required');

  req.user = user;
  req.session = session;
  next();
}

/** Use after requireAuth. The role comes from the database, so changes apply immediately. */
export const requireRole =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      throw new HttpError(403, 'Forbidden');
    }
    next();
  };
