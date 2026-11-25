import * as authService from '../services/auth.service.js';
import { loginSchema, registerSchema } from '../validators/auth.validators.js';
import { clearSessionCookie, setSessionCookie } from '../utils/cookies.js';
import { createSession, csrfTokenFor } from '../utils/jwt.js';

// The JWT travels only in the httpOnly cookie. Responses never contain it or the password hash.
// "csrfToken" is a separate value the client sends back in the X-CSRF-Token header.

export async function register(req, res) {
  const input = registerSchema.parse(req.body);
  const user = await authService.registerUser(input);
  res.status(201).json({ user });
}

export async function login(req, res) {
  const input = loginSchema.parse(req.body);
  const user = await authService.authenticate(input);
  const { token, csrfToken } = createSession(user.id);
  setSessionCookie(res, token);
  res.json({ user, csrfToken });
}

export function logout(_req, res) {
  clearSessionCookie(res);
  res.status(204).end();
}

export function me(req, res) {
  res.json({ user: req.user, csrfToken: csrfTokenFor(req.session.jti) });
}
