import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';
import crypto from 'node:crypto';

function formatOrder(order) {
  if (!order) return null;
  const formatted = {
    id: order.id,
    orderNumber: order.orderNumber,
    userId: order.userId,
    subtotalPaise: order.subtotalPaise,
    totalPaise: order.totalPaise,
    status: order.status,
    paymentStatus: order.paymentStatus,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    shippingAddress: {
      street: order.shippingAddressStreet,
      city: order.shippingAddressCity,
      state: order.shippingAddressState,
      postalCode: order.shippingAddressPostalCode,
      country: order.shippingAddressCountry,
    },
  };
  if (order.items) {
    formatted.items = order.items.map((item) => ({
      bookId: item.bookId,
      title: item.title,
      quantity: item.quantity,
      unitPricePaise: item.unitPricePaise,
      lineTotalPaise: item.lineTotalPaise,
    }));
  }
  return formatted;
}

export async function createOrder(userId, { items, shippingAddress }) {
  // Validate shippingAddress object and fields early to preserve database resources
  if (!shippingAddress || typeof shippingAddress !== 'object') {
    throw new HttpError(400, 'Invalid shipping address');
  }
  const requiredAddressFields = ['street', 'city', 'state', 'postalCode', 'country'];
  const cleanedAddress = {};
  for (const field of requiredAddressFields) {
    const val = shippingAddress[field];
    if (typeof val !== 'string' || val.trim().length === 0) {
      throw new HttpError(400, `Shipping address field "${field}" is required and must be a non-empty string`);
    }
    cleanedAddress[field] = val.trim();
  }

  // Validate items parameter structure
  if (!items || !Array.isArray(items) || items.length === 0) {
    throw new HttpError(400, 'Order must contain at least one item');
  }

  // 1. Validate, parse and group duplicate book IDs
  const itemMap = new Map();
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  for (const item of items) {
    if (!item || typeof item !== 'object') {
      throw new HttpError(400, 'Invalid order item payload');
    }
    const bookId = item.bookId;
    if (!bookId || typeof bookId !== 'string') {
      throw new HttpError(400, 'Invalid book identifier');
    }
    if (!uuidRegex.test(bookId)) {
      throw new HttpError(400, 'Invalid book identifier format');
    }
    const quantity = item.quantity;
    if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new HttpError(400, 'Quantity must be a positive safe integer');
    }
    if (quantity > 100000) {
      throw new HttpError(400, 'Excessive quantity requested per item');
    }
    itemMap.set(bookId, (itemMap.get(bookId) || 0) + quantity);
  }

  // Validate that the combined/grouped quantities are within safe limit boundaries
  for (const [bookId, combinedQuantity] of itemMap.entries()) {
    if (typeof combinedQuantity !== 'number' || !Number.isSafeInteger(combinedQuantity) || combinedQuantity <= 0) {
      throw new HttpError(400, 'Combined quantity must be a positive safe integer');
    }
    if (combinedQuantity > 100000) {
      throw new HttpError(400, 'Combined quantity per book cannot exceed 100,000');
    }
  }

  const result = await prisma.$transaction(async (tx) => {
    const orderItems = [];
    let subtotalPaise = 0;

    // 2. Lock book rows in a consistent ascending order to prevent deadlocks
    const sortedBookIds = Array.from(itemMap.keys()).sort();

    for (const bookId of sortedBookIds) {
      const quantity = itemMap.get(bookId);

      // Raw SQL SELECT ... FOR UPDATE to acquire pessimistic row-level lock
      const books = await tx.$queryRaw`
        SELECT id, title, stock, "priceCents" FROM books WHERE id = ${bookId}::uuid FOR UPDATE
      `;
      const book = books[0];

      if (!book) {
        throw new HttpError(400, 'Book not found');
      }

      if (book.stock < quantity) {
        throw new HttpError(400, `Insufficient stock for book "${book.title}"`);
      }

      // Ensure stock never becomes negative
      const newStock = book.stock - quantity;
      if (newStock < 0) {
        throw new HttpError(400, `Insufficient stock for book "${book.title}"`);
      }

      // Decrement stock atomically
      await tx.book.update({
        where: { id: bookId },
        data: { stock: newStock },
      });

      const lineTotalPaise = book.priceCents * quantity;
      if (lineTotalPaise > 2147483647) {
        throw new HttpError(400, 'Order line total exceeds maximum allowed amount');
      }

      subtotalPaise += lineTotalPaise;
      if (subtotalPaise > 2147483647) {
        throw new HttpError(400, 'Order subtotal exceeds maximum allowed amount');
      }

      orderItems.push({
        bookId: book.id,
        title: book.title,
        quantity,
        unitPricePaise: book.priceCents,
        lineTotalPaise,
      });
    }

    const orderNumber = `ORD-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    // 3. Save order and snapshots
    const order = await tx.order.create({
      data: {
        orderNumber,
        userId,
        subtotalPaise,
        totalPaise: subtotalPaise,
        status: 'PLACED',
        paymentStatus: 'COMPLETED',
        shippingAddressStreet: cleanedAddress.street,
        shippingAddressCity: cleanedAddress.city,
        shippingAddressState: cleanedAddress.state,
        shippingAddressPostalCode: cleanedAddress.postalCode,
        shippingAddressCountry: cleanedAddress.country,
        items: {
          create: orderItems,
        },
      },
      include: {
        items: true,
      },
    });

    return order;
  });

  return formatOrder(result);
}

export async function getOrders(userId, { page, pageSize }) {
  const [items, total] = await Promise.all([
    prisma.order.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { items: true },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.order.count({ where: { userId } }),
  ]);

  const totalPages = Math.ceil(total / pageSize);
  return {
    items: items.map(formatOrder),
    total,
    page,
    pageSize,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1 && totalPages > 0,
  };
}

export async function getOrderById(userId, orderId) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  });

  if (!order || order.userId !== userId) {
    throw new HttpError(404, 'Order not found');
  }

  return formatOrder(order);
}

export async function cancelOrder(userId, orderId) {
  const result = await prisma.$transaction(async (tx) => {
    // Acquire a row-level lock on the order
    const orders = await tx.$queryRaw`
      SELECT id, status, "userId" FROM orders WHERE id = ${orderId}::uuid FOR UPDATE
    `;
    const order = orders[0];

    if (!order || order.userId !== userId) {
      throw new HttpError(404, 'Order not found');
    }

    if (order.status !== 'PLACED') {
      throw new HttpError(400, 'Only PLACED orders can be cancelled');
    }

    // Update the status to CANCELLED inside the transaction
    const updatedOrder = await tx.order.update({
      where: { id: orderId },
      data: { status: 'CANCELLED' },
      include: { items: true },
    });

    // Group and sum quantities by bookId for non-null bookIds to ensure determinism
    const bookQtyMap = new Map();
    for (const item of updatedOrder.items) {
      if (item.bookId) {
        bookQtyMap.set(item.bookId, (bookQtyMap.get(item.bookId) || 0) + item.quantity);
      }
    }

    // Sort the non-null book IDs in ascending order to prevent deadlocks
    const sortedCancelBookIds = Array.from(bookQtyMap.keys()).sort();

    // Restore stock atomically exactly once in sorted order
    for (const bookId of sortedCancelBookIds) {
      const quantity = bookQtyMap.get(bookId);

      // Acquire pessimistic row-level lock on the book to prevent concurrent updates and race conditions
      const books = await tx.$queryRaw`
        SELECT id, title, stock FROM books WHERE id = ${bookId}::uuid FOR UPDATE
      `;
      const book = books[0];

      if (book) {
        const restoredStock = book.stock + quantity;
        if (restoredStock > 2147483647) {
          throw new HttpError(400, `Stock restoration for book "${book.title}" would cause integer overflow`);
        }

        await tx.book.update({
          where: { id: bookId },
          data: { stock: restoredStock },
        });
      }
    }

    return updatedOrder;
  });

  return formatOrder(result);
}
