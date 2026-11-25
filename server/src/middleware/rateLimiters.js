import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

/** Strict limiter for login/register (brute-force protection). */
export const createAuthLimiter = (limit = env.AUTH_RATE_LIMIT) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please try again later.' },
  });
