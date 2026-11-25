import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function notFound(_req, res) {
  res.status(404).json({ error: 'Not found' });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  if (err instanceof HttpError) {
    // Expected client errors (4xx) keep their intentional, client-facing message. A 5xx HttpError means something
    // internal failed, so its message is never sent to the client.
    if (err.status >= 500) {
      console.error(JSON.stringify({ level: 'error', msg: 'Server error', status: err.status, error: err.name }));
      return res.status(err.status).json({ error: 'Internal server error' });
    }
    return res.status(err.status).json({ error: err.message });
  }
  // Malformed or oversized JSON bodies (thrown by express.json()).
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid request' });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request too large' });
  }
  // MongoDB duplicate key. Not logged with its message, which would contain the duplicate value.
  if (err?.code === 11000) {
    return res.status(409).json({ error: 'Resource already exists' });
  }
  if (err?.name === 'ValidationError' || err?.name === 'CastError') {
    return res.status(400).json({ error: 'Invalid request' });
  }
  // Only the error class and code are logged: raw Prisma/driver messages can contain connection details,
  // query text or record values. Clients get a generic message.
  console.error(JSON.stringify({
    level: 'error',
    msg: 'Unhandled error',
    error: err?.name || 'Error',
    ...(err?.code ? { code: String(err.code) } : {}),
  }));
  res.status(500).json({ error: 'Internal server error' });
}
