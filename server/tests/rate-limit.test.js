// Rate limit is set low BEFORE the app is imported, because the limiter reads it at import time.
process.env.AUTH_RATE_LIMIT = '3';

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

const { createClient, startTestServer, validUser } = await import('./helpers.js');

let ctx;
before(async () => {
  ctx = await startTestServer();
});
after(async () => {
  await ctx.stop();
});

test('login is rate limited after repeated attempts', async () => {
  const client = createClient(ctx.baseUrl);
  const statuses = [];
  for (let i = 0; i < 5; i++) {
    const res = await client.post('/api/auth/login', { email: 'nobody@example.com', password: 'Wrong-Password-1' });
    statuses.push(res.status);
    if (res.status === 429) {
      assert.deepEqual(res.json, { error: 'Too many attempts. Please try again later.' });
    }
  }
  assert.deepEqual(statuses.slice(0, 3), [401, 401, 401]);
  assert.deepEqual(statuses.slice(3), [429, 429]);
});

test('register shares the limiter and is also blocked', async () => {
  const client = createClient(ctx.baseUrl);
  const res = await client.post('/api/auth/register', validUser({ email: 'limited@example.com' }));
  assert.equal(res.status, 429);
});

test('the general API (books) is not affected by the auth limiter', async () => {
  const client = createClient(ctx.baseUrl);
  assert.equal((await client.get('/api/books')).status, 200);
});
