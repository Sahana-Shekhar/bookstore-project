import { env } from '../config/env.js';

export const SESSION_COOKIE = 'bookstore_session';

export function sessionCookieOptions(secure = env.NODE_ENV === 'production') {
  return {
    httpOnly: true, // not readable from JavaScript
    secure, // HTTPS only in production
    sameSite: 'strict',
    path: '/',
  };
}

export function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    ...sessionCookieOptions(),
    maxAge: env.JWT_EXPIRES_MINUTES * 60 * 1000,
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
}
