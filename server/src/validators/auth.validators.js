import { z } from 'zod';

// bcrypt only uses the first 72 BYTES of a password, so longer ones are rejected rather than silently truncated.
const MAX_PASSWORD_BYTES = 72;
const withinBcryptLimit = (value) => Buffer.byteLength(value, 'utf8') <= MAX_PASSWORD_BYTES;

const name = (label) =>
  z
    .string({ error: `${label} is required` })
    .trim()
    .min(1, `${label} is required`)
    .max(50, `${label} must be at most 50 characters`);

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email('Enter a valid email address'));

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .refine(withinBcryptLimit, `Password must be at most ${MAX_PASSWORD_BYTES} bytes`);

// Unknown keys (including any "role") are stripped by zod, so registration can only ever create a CUSTOMER.
export const registerSchema = z.object({
  firstName: name('First name'),
  lastName: name('Last name'),
  email,
  password: passwordSchema,
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1).max(254),
  password: z.string().min(1).refine(withinBcryptLimit),
});
