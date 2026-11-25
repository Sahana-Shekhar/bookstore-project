import { z } from 'zod';

// Comma-separated list of allowed browser origins, e.g. "http://127.0.0.1:5173,http://localhost:5173".
const originList = z
  .string()
  .min(1)
  .transform((value, ctx) => {
    const origins = [];
    for (const raw of value.split(',').map((s) => s.trim()).filter(Boolean)) {
      try {
        origins.push(new URL(raw).origin);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'CLIENT_ORIGIN must be a comma-separated list of URLs' });
        return z.NEVER;
      }
    }
    return origins;
  });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(4000),
  CLIENT_ORIGIN: originList,
  DATABASE_URL: z.string().min(1),
  MONGODB_URI: z.string().min(1).optional(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  // Max login/register attempts per IP per 15 minutes.
  AUTH_RATE_LIMIT: z.coerce.number().int().min(1).default(10),
  // Max requests of any kind per IP per 15 minutes (a broad abuse guard, separate from the login limit above).
  API_RATE_LIMIT: z.coerce.number().int().min(1).default(300),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Report only which variables are invalid, never their values.
  console.error('Invalid environment configuration:', Object.keys(parsed.error.flatten().fieldErrors));
  process.exit(1);
}

export const env = parsed.data;
