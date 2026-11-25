import { env } from '../config/env.js';
import { HttpError } from './errorHandler.js';
import { SESSION_COOKIE } from '../utils/cookies.js';
import { isValidCsrfToken, verifySession } from '../utils/jwt.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Pre-login endpoints have no session to protect, so only the Origin check applies to them.
const TOKEN_EXEMPT_PATHS = new Set(['/auth/login', '/auth/register']);

/**
 * CSRF protection for cookie-based auth. Mounted on /api, so it is on by default
 * for every state-changing route:
 *  1. If the browser sends an Origin header, it must be an allowed client origin.
 *  2. If the request carries a valid session, it must send a matching X-CSRF-Token header.
 */
export function csrfProtection(req, _res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.get('origin');
  if (origin && !env.CLIENT_ORIGIN.includes(origin)) {
    throw new HttpError(403, 'Forbidden');
  }

  if (TOKEN_EXEMPT_PATHS.has(req.path)) return next();

  const session = verifySession(req.cookies?.[SESSION_COOKIE]);
  if (!session) return next(); // no valid session: nothing to protect; auth middleware will reject if needed

  if (!isValidCsrfToken(session.jti, req.get('x-csrf-token'))) {
    throw new HttpError(403, 'Invalid CSRF token');
  }
  next();
}
