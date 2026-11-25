import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

const ISSUER = 'bookstore-api';
const AUDIENCE = 'bookstore-web';

/** CSRF token bound to one session: HMAC of the token id. Not stored anywhere. */
export function csrfTokenFor(jti) {
  return crypto.createHmac('sha256', env.JWT_SECRET).update(`csrf:${jti}`).digest('base64url');
}

export function isValidCsrfToken(jti, provided) {
  if (typeof provided !== 'string') return false;
  const expected = Buffer.from(csrfTokenFor(jti));
  const actual = Buffer.from(provided);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** Creates a signed session token. The payload only carries the user id (sub) and a token id (jti). */
export function createSession(userId) {
  const jti = crypto.randomUUID();
  const token = jwt.sign({}, env.JWT_SECRET, {
    algorithm: 'HS256',
    subject: String(userId),
    jwtid: jti,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: env.JWT_EXPIRES_MINUTES * 60,
  });
  return { token, csrfToken: csrfTokenFor(jti) };
}

/** Returns { userId, jti } for a valid token, or null for anything invalid/expired/tampered. */
export function verifySession(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (!payload.sub || !payload.jti) return null;
    return { userId: payload.sub, jti: payload.jti };
  } catch {
    return null;
  }
}
