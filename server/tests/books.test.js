import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, startTestServer, prisma } from './helpers.js';

let ctx;
let client;
let book;
let category;

before(async () => {
  ctx = await startTestServer();
  client = createClient(ctx.baseUrl);
  
  const author = await prisma.author.create({
    data: { name: 'Sample Author' },
  });
  category = await prisma.category.create({
    data: { name: 'Fiction', slug: 'fiction' },
  });
  const other = await prisma.category.create({
    data: { name: 'Science', slug: 'science' },
  });
  
  book = await prisma.book.create({
    data: {
      title: 'Sample Book',
      isbn: '9780000000001',
      description: 'A seeded sample book.',
      priceCents: 999,
      stock: 10,
      authorId: author.id,
      categoryId: category.id,
    },
  });
  
  await prisma.book.create({
    data: {
      title: 'Other Book',
      isbn: '9780000000002',
      description: 'Other sample book.',
      priceCents: 1999,
      stock: 5,
      authorId: author.id,
      categoryId: other.id,
    },
  });
});

after(async () => {
  await ctx.stop();
});

describe('Books API (regression)', () => {
  test('GET /api/health', async () => {
    const res = await client.get('/api/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { status: 'ok' });
  });

  test('GET /api/books lists books with author and category and string ids', async () => {
    const res = await client.get('/api/books');
    assert.equal(res.status, 200);
    assert.equal(res.json.total, 2);
    assert.equal(res.json.page, 1);
    assert.equal(res.json.pageSize, 12);
    const item = res.json.items.find((b) => b.isbn === '9780000000001');
    assert.equal(item.title, 'Sample Book');
    assert.equal(item.priceCents, 999);
    assert.equal(item.author.name, 'Sample Author');
    assert.equal(item.category.slug, 'fiction');
    assert.equal(typeof item.id, 'string');
    assert.equal('_id' in item, false);
  });

  test('pagination and category filter work', async () => {
    const page = await client.get('/api/books?page=1&pageSize=1');
    assert.equal(page.json.items.length, 1);
    assert.equal(page.json.total, 2);
    const filtered = await client.get(`/api/books?categoryId=${category.id}`);
    assert.equal(filtered.json.total, 1);
    assert.equal(filtered.json.items[0].title, 'Sample Book');
  });

  test('GET /api/books/:id returns one book', async () => {
    const res = await client.get(`/api/books/${book.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.json.title, 'Sample Book');
  });

  test('invalid id -> 400, unknown id -> 404, unknown route -> 404', async () => {
    assert.equal((await client.get('/api/books/not-an-id')).status, 400);
    assert.equal((await client.get('/api/books/00000000-0000-0000-0000-000000000000')).status, 404);
    assert.equal((await client.get('/api/nope')).status, 404);
    assert.equal((await client.get('/api/books?page=0')).status, 400);
    assert.equal((await client.get('/api/books?pageSize=500')).status, 400);
  });

  test('NoSQL operators in query params are never interpreted', async () => {
    const res = await client.get('/api/books?categoryId[$eq]=00000000-0000-0000-0000-000000000000');
    assert.equal(res.status, 200);
    assert.equal(res.json.total, 2);
    assert.equal((await client.get('/api/books?categoryId=%7B%22%24ne%22%3A%22%22%7D')).status, 400);
  });

  test('security headers are present', async () => {
    const res = await client.get('/api/health');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null);
  });
});
