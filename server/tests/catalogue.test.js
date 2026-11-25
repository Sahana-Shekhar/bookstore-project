import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, startTestServer, prisma } from './helpers.js';

const { seedCatalogue, CATEGORIES } = await import('../src/seed/catalogue.js');

let ctx;
let client;
let cat; // slug -> id

const titles = (res) => res.json.items.map((b) => b.title);

before(async () => {
  ctx = await startTestServer();
  client = createClient(ctx.baseUrl);
  await seedCatalogue();
  cat = Object.fromEntries((await prisma.category.findMany()).map((c) => [c.slug, c.id]));
});

after(async () => {
  await ctx.stop();
});

describe('GET /api/categories', () => {
  test('returns every category A-Z with id, name, slug and bookCount', async () => {
    const res = await client.get('/api/categories');
    assert.equal(res.status, 200);
    const names = res.json.items.map((c) => c.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
    assert.equal(res.json.items.length, CATEGORIES.length);
    const fiction = res.json.items.find((c) => c.slug === 'fiction');
    assert.equal(fiction.id, cat.fiction);
    assert.equal(fiction.bookCount, 4);
    assert.equal(typeof fiction.id, 'string');
    assert.deepEqual(Object.keys(fiction).sort(), ['bookCount', 'id', 'name', 'slug']);
  });

  test('a category with no books has bookCount 0', async () => {
    const empty = await prisma.category.create({ data: { name: 'Poetry', slug: 'poetry' } });
    const res = await client.get('/api/categories');
    assert.equal(res.json.items.find((c) => c.id === empty.id).bookCount, 0);
    await prisma.category.delete({ where: { id: empty.id } });
  });

  test('is public (no login needed) and read-only', async () => {
    assert.equal((await client.get('/api/categories')).status, 200);
    const post = await client.post('/api/categories', { name: 'X' }, { headers: { Origin: 'http://127.0.0.1:5173' } });
    assert.ok([403, 404].includes(post.status), `unexpected ${post.status}`);
  });
});

describe('seed', () => {
  test('creates 15-20 books across at least 5 categories, with valid data', async () => {
    const books = await prisma.book.findMany({
      include: { author: true, category: true },
    });
    assert.ok(books.length >= 15 && books.length <= 20, `books: ${books.length}`);
    assert.ok(new Set(books.map((b) => b.category.slug)).size >= 5);
    for (const b of books) {
      assert.ok(Number.isInteger(b.priceCents) && b.priceCents > 0);
      assert.ok(b.stock >= 0 && b.description.length > 20 && b.author.name);
      assert.match(b.isbn, /^\d{13}$/);
    }
    assert.ok(books.some((b) => b.stock === 0), 'at least one out-of-stock book to exercise that state');
  });

  test('is idempotent: re-running adds nothing and does not reset stock, price or text', async () => {
    const beforeCount = await prisma.book.count();
    const target = await prisma.book.findFirst({ where: { title: 'Meditations' } });
    
    await prisma.book.update({
      where: { id: target.id },
      data: { stock: 3, priceCents: 12345, description: 'Edited by admin' },
    });
    
    const authorsBefore = await prisma.author.count();
    const catsBefore = await prisma.category.count();

    const result = await seedCatalogue();
    await seedCatalogue();

    assert.equal(result.inserted, 0);
    assert.equal(await prisma.book.count(), beforeCount);
    assert.equal(await prisma.author.count(), authorsBefore);
    assert.equal(await prisma.category.count(), catsBefore);
    
    const afterObj = await prisma.book.findUnique({ where: { id: target.id } });
    assert.equal(afterObj.stock, 3);
    assert.equal(afterObj.priceCents, 12345);
    assert.equal(afterObj.description, 'Edited by admin');
  });

  test('re-seeding restores a deleted book but leaves the others alone', async () => {
    const victim = await prisma.book.findFirst({ where: { title: 'The Art of War' } });
    const other = await prisma.book.findFirst({ where: { title: 'The Republic' } });
    
    await prisma.book.update({
      where: { id: other.id },
      data: { stock: 1 },
    });
    await prisma.book.delete({
      where: { id: victim.id },
    });
    
    const result = await seedCatalogue();
    assert.equal(result.inserted, 1);
    assert.equal((await prisma.book.findUnique({ where: { id: other.id } })).stock, 1);
    assert.equal(await prisma.book.count({ where: { title: 'The Art of War' } }), 1);
  });
});

describe('GET /api/books: search', () => {
  test('finds by title, case-insensitively, as a substring', async () => {
    const res = await client.get('/api/books?q=SHERLOCK');
    assert.deepEqual(titles(res), ['The Adventures of Sherlock Holmes']);
    assert.equal(res.json.total, 1);
  });

  test('finds by author name (all that author\'s books)', async () => {
    const res = await client.get('/api/books?q=wells&sort=title-asc');
    assert.deepEqual(titles(res), ['The Time Machine', 'The War of the Worlds']);
  });

  test('matches title OR author in the same query', async () => {
    const res = await client.get('/api/books?q=darwin');
    assert.equal(res.json.total, 2);
    const res2 = await client.get('/api/books?q=conan');
    assert.equal(res2.json.total, 2);
  });

  test('no matches -> 200 with an empty list and zeroed metadata', async () => {
    const res = await client.get('/api/books?q=zzzznotabook');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.items, []);
    assert.equal(res.json.total, 0);
    assert.equal(res.json.totalPages, 0);
    assert.equal(res.json.hasNextPage, false);
    assert.equal(res.json.hasPreviousPage, false);
  });

  test('blank or whitespace-only q is ignored (returns everything)', async () => {
    const all = (await client.get('/api/books')).json.total;
    assert.equal((await client.get('/api/books?q=')).json.total, all);
    assert.equal((await client.get('/api/books?q=%20%20')).json.total, all);
  });

  test('search text is literal, never a regex or an operator', async () => {
    const all = (await client.get('/api/books')).json.total;
    for (const q of ['.*', '^', '(', '[a-z]+', '\\', '$ne', '{"$ne":""}', 'a|b']) {
      const res = await client.get(`/api/books?q=${encodeURIComponent(q)}`);
      assert.equal(res.status, 200, `q=${q}`);
      assert.ok(res.json.total < all, `q=${q} must not match everything (${res.json.total})`);
    }
    assert.equal((await client.get(`/api/books?q=${encodeURIComponent('Moby-Dick')}`)).json.total, 1);
    assert.equal((await client.get(`/api/books?q=${encodeURIComponent('Relativity: The')}`)).json.total, 1);
  });

  test('operator-style keys on q are not interpreted; too-long q is rejected', async () => {
    const all = (await client.get('/api/books')).json.total;
    assert.equal((await client.get('/api/books?q[$ne]=x')).json.total, all);
    assert.equal((await client.get(`/api/books?q=${'a'.repeat(101)}`)).status, 400);
    assert.equal((await client.get(`/api/books?q=${'a'.repeat(100)}`)).status, 200);
  });

  test('unicode titles and authors can be found', async () => {
    assert.equal((await client.get(`/api/books?q=${encodeURIComponent('Brontë')}`)).json.total, 1);
    assert.equal((await client.get(`/api/books?q=${encodeURIComponent('Galápagos')}`)).json.total, 0);
  });
});

describe('GET /api/books: category filter', () => {
  test('returns only books in that category', async () => {
    const res = await client.get(`/api/books?categoryId=${cat['science-fiction']}&pageSize=50`);
    assert.equal(res.json.total, 4);
    assert.ok(res.json.items.every((b) => b.category.slug === 'science-fiction'));
  });

  test('a valid but unknown category id -> 200 with no books', async () => {
    const res = await client.get('/api/books?categoryId=00000000-0000-0000-0000-000000000000');
    assert.equal(res.status, 200);
    assert.equal(res.json.total, 0);
  });

  test('malformed category id -> 400', async () => {
    for (const bad of ['abc', '123', 'zzzzzzzzzzzzzzzzzzzzzzzz', '%7B%22%24ne%22%3A1%7D']) {
      assert.equal((await client.get(`/api/books?categoryId=${bad}`)).status, 400, bad);
    }
  });
});

describe('GET /api/books: sorting', () => {
  const all = '/api/books?pageSize=50';

  test('title-asc / title-desc', async () => {
    const asc = titles(await client.get(`${all}&sort=title-asc`));
    assert.deepEqual(asc, [...asc].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'accent' })));
    const desc = titles(await client.get(`${all}&sort=title-desc`));
    assert.deepEqual(desc, [...asc].reverse());
  });

  test('price-asc / price-desc', async () => {
    const asc = (await client.get(`${all}&sort=price-asc`)).json.items.map((b) => b.priceCents);
    assert.deepEqual(asc, [...asc].sort((a, b) => a - b));
    const desc = (await client.get(`${all}&sort=price-desc`)).json.items.map((b) => b.priceCents);
    assert.deepEqual(desc, [...asc].reverse());
  });

  test('newest is the default and puts the most recently created first', async () => {
    const def = await client.get(all);
    const explicit = await client.get(`${all}&sort=newest`);
    assert.deepEqual(titles(def), titles(explicit));
    const created = def.json.items.map((b) => Date.parse(b.createdAt));
    assert.deepEqual(created, [...created].sort((a, b) => b - a));
  });

  test('unknown sort -> 400', async () => {
    assert.equal((await client.get('/api/books?sort=random')).status, 400);
    assert.equal((await client.get('/api/books?sort=%24where')).status, 400);
  });

  test('ties are ordered deterministically so pages never repeat or skip a book', async () => {
    const a = (await prisma.author.findFirst()).id;
    const c = (await prisma.category.findFirst()).id;
    
    await prisma.book.createMany({
      data: [
        { title: 'Twin', isbn: '9781111111111', priceCents: 100, stock: 1, authorId: a, categoryId: c, description: 'Twin book description.' },
        { title: 'Twin', isbn: '9781111111112', priceCents: 100, stock: 1, authorId: a, categoryId: c, description: 'Twin book description.' },
        { title: 'Twin', isbn: '9781111111113', priceCents: 100, stock: 1, authorId: a, categoryId: c, description: 'Twin book description.' },
      ]
    });
    
    const seen = [];
    for (let page = 1; page <= 3; page += 1) {
      const res = await client.get(`/api/books?q=twin&pageSize=1&page=${page}&sort=price-asc`);
      seen.push(res.json.items[0].id);
    }
    assert.equal(new Set(seen).size, 3);
    await prisma.book.deleteMany({ where: { title: 'Twin' } });
  });
});

describe('GET /api/books: pagination', () => {
  test('metadata is complete and consistent', async () => {
    const total = await prisma.book.count();
    const res = await client.get('/api/books?pageSize=8&page=1');
    assert.deepEqual(
      { total: res.json.total, page: res.json.page, pageSize: res.json.pageSize, totalPages: res.json.totalPages },
      { total, page: 1, pageSize: 8, totalPages: Math.ceil(total / 8) },
    );
    assert.equal(res.json.items.length, 8);
    assert.equal(res.json.hasNextPage, true);
    assert.equal(res.json.hasPreviousPage, false);
  });

  test('last page holds the remainder; middle and last flags are right', async () => {
    const total = await prisma.book.count();
    const pages = Math.ceil(total / 8);
    const last = await client.get(`/api/books?pageSize=8&page=${pages}`);
    assert.equal(last.json.items.length, total - 8 * (pages - 1));
    assert.equal(last.json.hasNextPage, false);
    assert.equal(last.json.hasPreviousPage, true);
    const mid = await client.get('/api/books?pageSize=8&page=2');
    assert.equal(mid.json.hasNextPage, pages > 2);
    assert.equal(mid.json.hasPreviousPage, true);
  });

  test('walking every page returns each book exactly once', async () => {
    const seen = [];
    for (let page = 1; page <= 4; page += 1) {
      const res = await client.get(`/api/books?pageSize=6&page=${page}&sort=title-asc`);
      seen.push(...res.json.items.map((b) => b.id));
    }
    assert.equal(new Set(seen).size, seen.length);
    assert.equal(seen.length, await prisma.book.count());
  });

  test('a page beyond the end -> 200, empty items, correct totals (not an error)', async () => {
    const res = await client.get('/api/books?page=99');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.items, []);
    assert.equal(res.json.page, 99);
    assert.equal(res.json.hasNextPage, false);
    assert.equal(res.json.total, await prisma.book.count());
  });

  test('invalid page / pageSize -> 400', async () => {
    for (const qs of ['page=0', 'page=-1', 'page=1.5', 'page=abc', 'page=', 'page=1e3', 'page=999999999', 'pageSize=0', 'pageSize=51', 'pageSize=x', 'pageSize=-5']) {
      const res = await client.get(`/api/books?${qs}`);
      assert.equal(res.status, 400, qs);
      assert.deepEqual(res.json, { error: 'Invalid request' }, qs);
    }
  });

  test('pageSize 50 (the maximum) is accepted', async () => {
    const res = await client.get('/api/books?pageSize=50');
    assert.equal(res.status, 200);
    assert.equal(res.json.pageSize, 50);
  });

  test('unknown query parameters are ignored', async () => {
    const all = (await client.get('/api/books')).json.total;
    assert.equal((await client.get('/api/books?foo=bar&$where=1')).json.total, all);
  });
});

describe('GET /api/books: search + category + sort + pagination together', () => {
  test('category narrows a search', async () => {
    const res = await client.get(`/api/books?q=the&categoryId=${cat.mystery}&pageSize=50&sort=title-asc`);
    assert.ok(res.json.total >= 2);
    assert.ok(res.json.items.every((b) => b.category.slug === 'mystery' && /the/i.test(b.title + b.author.name)));
    const none = await client.get(`/api/books?q=sherlock&categoryId=${cat.science}`);
    assert.equal(none.json.total, 0);
  });

  test('author search + category + sort + pagination agree with each other', async () => {
    const url = (page) => `/api/books?q=an&categoryId=${cat.fiction}&sort=price-desc&pageSize=2&page=${page}`;
    const p1 = await client.get(url(1));
    const p2 = await client.get(url(2));
    const total = p1.json.total;
    assert.ok(total >= 3);
    assert.equal(p1.json.totalPages, Math.ceil(total / 2));
    assert.equal(p1.json.items.length, 2);
    const prices = [...p1.json.items, ...p2.json.items].map((b) => b.priceCents);
    assert.deepEqual(prices, [...prices].sort((a, b) => b - a));
    assert.ok(p1.json.items.every((b) => b.category.slug === 'fiction'));
  });

  test('total reflects filters, not the whole catalogue', async () => {
    const res = await client.get(`/api/books?categoryId=${cat.philosophy}&pageSize=1`);
    assert.equal(res.json.total, 3);
    assert.equal(res.json.totalPages, 3);
    assert.equal(res.json.items.length, 1);
  });

  test('a filter that matches nothing on page 1 reports zero pages', async () => {
    const res = await client.get(`/api/books?q=wells&categoryId=${cat.history}`);
    assert.equal(res.json.totalPages, 0);
    assert.equal(res.json.hasNextPage, false);
  });
});

describe('book shape and details', () => {
  test('list items carry the fields the catalogue needs', async () => {
    const res = await client.get('/api/books?q=moby');
    const b = res.json.items[0];
    for (const key of ['id', 'title', 'isbn', 'description', 'priceCents', 'stock', 'author', 'category', 'createdAt']) {
      assert.ok(key in b, `missing ${key}`);
    }
    assert.equal(b.author.name, 'Herman Melville');
    assert.equal(b.category.name, 'Fiction');
    assert.equal(b.priceCents, 44900);
  });

  test('GET /api/books/:id returns the full book, including an out-of-stock one', async () => {
    const out = await prisma.book.findFirst({ where: { stock: 0 } });
    const res = await client.get(`/api/books/${out.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.json.id, out.id);
    assert.equal(res.json.stock, 0);
    assert.ok(res.json.author.name && res.json.category.name && res.json.isbn);
  });

  test('invalid ids -> 400, unknown id -> 404, with generic messages only', async () => {
    for (const bad of ['abc', '123', 'zzzzzzzzzzzzzzzzzzzzzzzz', '%7B%22%24ne%22%3A1%7D', '1'.repeat(25)]) {
      const res = await client.get(`/api/books/${bad}`);
      assert.equal(res.status, 400, bad);
      assert.deepEqual(res.json, { error: 'Invalid request' });
    }
    const missing = await client.get('/api/books/00000000-0000-0000-0000-000000000000');
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.json, { error: 'Book not found' });
  });

  test('error bodies never leak internals', async () => {
    const res = await client.get('/api/books?page=abc');
    assert.ok(!/zod|stack|mongo|cast/i.test(res.text));
  });
});
