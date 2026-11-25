import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, startTestServer, validUser, prisma } from './helpers.js';

let ctx;
let client;
let customerClient;
let csrfToken;
let book1;
let book2;

before(async () => {
  ctx = await startTestServer();
  client = createClient(ctx.baseUrl);

  // Set up data
  const author = await prisma.author.create({
    data: { name: 'Test Author' },
  });
  const category = await prisma.category.create({
    data: { name: 'Fiction', slug: 'fiction' },
  });

  book1 = await prisma.book.create({
    data: {
      title: 'Book One',
      isbn: '1111111111111',
      description: 'Test book one.',
      priceCents: 1000,
      stock: 5,
      authorId: author.id,
      categoryId: category.id,
    },
  });

  book2 = await prisma.book.create({
    data: {
      title: 'Book Two',
      isbn: '2222222222222',
      description: 'Test book two.',
      priceCents: 2500,
      stock: 10,
      authorId: author.id,
      categoryId: category.id,
    },
  });

  // Register and login a customer
  const userPayload = validUser({ email: 'customer@example.com' });
  await client.post('/api/auth/register', userPayload);
  const loginRes = await client.post('/api/auth/login', {
    email: userPayload.email,
    password: userPayload.password,
  });
  customerClient = client;
  csrfToken = loginRes.json.csrfToken;
});

after(async () => {
  await ctx.stop();
});

describe('Orders API', () => {
  const csrfHeader = () => ({ headers: { 'X-CSRF-Token': csrfToken } });

  test('POST /api/orders creates an order and decrements stock', async () => {
    const orderPayload = {
      items: [
        { bookId: book1.id, quantity: 2 },
        { bookId: book2.id, quantity: 1 },
      ],
      shippingAddress: {
        street: '123 Book St',
        city: 'Read City',
        state: 'Pages',
        postalCode: '12345',
        country: 'Libland',
      },
    };

    const res = await customerClient.post('/api/orders', orderPayload, csrfHeader());
    assert.equal(res.status, 201);
    assert.ok(res.json.orderNumber);
    assert.equal(res.json.items.length, 2);
    assert.equal(res.json.subtotalPaise, 4500);
    assert.equal(res.json.totalPaise, 4500);
    assert.equal(res.json.status, 'PLACED');

    // Check stock was decremented
    const updatedBook1 = await prisma.book.findUnique({ where: { id: book1.id } });
    const updatedBook2 = await prisma.book.findUnique({ where: { id: book2.id } });
    assert.equal(updatedBook1.stock, 3);
    assert.equal(updatedBook2.stock, 9);

    // Reset stock for next tests
    await prisma.book.update({ where: { id: book1.id }, data: { stock: 5 } });
    await prisma.book.update({ where: { id: book2.id }, data: { stock: 10 } });
  });

  test('POST /api/orders handles duplicate books in request', async () => {
    const orderPayload = {
      items: [
        { bookId: book1.id, quantity: 1 },
        { bookId: book1.id, quantity: 2 },
      ],
      shippingAddress: {
        street: '123 Book St',
        city: 'Read City',
        state: 'Pages',
        postalCode: '12345',
        country: 'Libland',
      },
    };

    const res = await customerClient.post('/api/orders', orderPayload, csrfHeader());
    assert.equal(res.status, 201);
    assert.equal(res.json.items.length, 1);
    assert.equal(res.json.items[0].quantity, 3);
    assert.equal(res.json.subtotalPaise, 3000);

    const updatedBook1 = await prisma.book.findUnique({ where: { id: book1.id } });
    assert.equal(updatedBook1.stock, 2);

    // Reset stock
    await prisma.book.update({ where: { id: book1.id }, data: { stock: 5 } });
  });

  test('POST /api/orders rejects if insufficient stock', async () => {
    const orderPayload = {
      items: [{ bookId: book1.id, quantity: 10 }],
      shippingAddress: {
        street: '123 Book St',
        city: 'Read City',
        state: 'Pages',
        postalCode: '12345',
        country: 'Libland',
      },
    };

    const res = await customerClient.post('/api/orders', orderPayload, csrfHeader());
    assert.equal(res.status, 400);

    // Verify stock was not decremented
    const updatedBook1 = await prisma.book.findUnique({ where: { id: book1.id } });
    assert.equal(updatedBook1.stock, 5);
  });

  test('POST /api/orders rejects invalid payload', async () => {
    const orderPayload = {
      items: [{ bookId: book1.id, quantity: 0 }],
      shippingAddress: {
        street: '123 Book St',
        city: 'Read City',
        state: 'Pages',
        postalCode: '12345',
        country: 'Libland',
      },
    };

    const res = await customerClient.post('/api/orders', orderPayload, csrfHeader());
    assert.equal(res.status, 400);
  });

  test('GET /api/orders returns user orders', async () => {
    const res = await customerClient.get('/api/orders');
    assert.equal(res.status, 200);
    assert.ok(res.json.items.length >= 1);
    assert.ok(res.json.total >= 1);
    assert.equal(res.json.page, 1);
  });

  test('GET /api/orders/:id and POST /api/orders/:id/cancel work as expected', async () => {
    // 1. Create an order
    const orderPayload = {
      items: [{ bookId: book1.id, quantity: 1 }],
      shippingAddress: {
        street: '123 Book St',
        city: 'Read City',
        state: 'Pages',
        postalCode: '12345',
        country: 'Libland',
      },
    };

    const createRes = await customerClient.post('/api/orders', orderPayload, csrfHeader());
    assert.equal(createRes.status, 201);
    const orderId = createRes.json.id;

    // 2. Fetch the order
    const getRes = await customerClient.get(`/api/orders/${orderId}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.json.id, orderId);

    // Check stock was decremented
    let book = await prisma.book.findUnique({ where: { id: book1.id } });
    assert.equal(book.stock, 4);

    // 3. Cancel the order
    const cancelRes = await customerClient.post(`/api/orders/${orderId}/cancel`, undefined, csrfHeader());
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.json.status, 'CANCELLED');

    // Check stock was restored
    book = await prisma.book.findUnique({ where: { id: book1.id } });
    assert.equal(book.stock, 5);

    // 4. Try to cancel again
    const cancelAgainRes = await customerClient.post(`/api/orders/${orderId}/cancel`, undefined, csrfHeader());
    assert.equal(cancelAgainRes.status, 400);
  });

  test('GET /api/orders/:id prevents access to another customer order', async () => {
    // Create an order for Customer A
    const orderPayload = {
      items: [{ bookId: book1.id, quantity: 1 }],
      shippingAddress: {
        street: '123 Book St',
        city: 'Read City',
        state: 'Pages',
        postalCode: '12345',
        country: 'Libland',
      },
    };

    const createRes = await customerClient.post('/api/orders', orderPayload, csrfHeader());
    const orderId = createRes.json.id;

    // Register and login Customer B
    const clientB = createClient(ctx.baseUrl);
    const userPayloadB = validUser({ email: 'customer_b@example.com' });
    await clientB.post('/api/auth/register', userPayloadB);
    const loginResB = await clientB.post('/api/auth/login', {
      email: userPayloadB.email,
      password: userPayloadB.password,
    });
    const csrfB = loginResB.json.csrfToken;

    // Fetch order as Customer B -> should be 404
    const getRes = await clientB.get(`/api/orders/${orderId}`);
    assert.equal(getRes.status, 404);

    // Cancel order as Customer B -> should be 404
    const cancelRes = await clientB.post(`/api/orders/${orderId}/cancel`, undefined, {
      headers: { 'X-CSRF-Token': csrfB },
    });
    assert.equal(cancelRes.status, 404);
  });
});
