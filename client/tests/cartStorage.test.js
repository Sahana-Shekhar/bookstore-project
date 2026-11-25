import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CART_KEY,
  MAX_LINES,
  MAX_QUANTITY,
  addToCart,
  cartCount,
  limitFor,
  lineTotalCents,
  loadCart,
  parseCart,
  quantityOf,
  reconcileItems,
  removeFromCart,
  saveCart,
  sanitizeItems,
  serializeCart,
  setQuantity,
} from '../src/cart/cartStorage.js';

const A = 'a'.repeat(24);
const B = 'b'.repeat(24);
const C = 'c'.repeat(24);

// A minimal in-memory stand-in for window.localStorage.
function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
  };
}

describe('persistence', () => {
  it('saves and restores the same items', () => {
    const storage = fakeStorage();
    const items = [{ bookId: A, quantity: 2 }, { bookId: B, quantity: 1 }];
    assert.equal(saveCart(storage, items), true);
    assert.deepEqual(loadCart(storage), items);
  });

  it('stores only book ids and quantities, under one versioned key', () => {
    const storage = fakeStorage();
    saveCart(storage, [{ bookId: A, quantity: 3, priceCents: 1, title: 'x', stock: 9 }]);
    assert.deepEqual([...storage.data.keys()], [CART_KEY]);
    assert.deepEqual(JSON.parse(storage.data.get(CART_KEY)), { v: 1, items: [{ bookId: A, quantity: 3 }] });
  });

  it('writes nothing for an empty cart and removes the key when it becomes empty', () => {
    const storage = fakeStorage();
    saveCart(storage, []);
    assert.equal(storage.data.size, 0);
    saveCart(storage, [{ bookId: A, quantity: 1 }]);
    assert.equal(storage.data.size, 1);
    saveCart(storage, []);
    assert.equal(storage.data.size, 0);
  });

  it('does not touch other keys (the theme)', () => {
    const storage = fakeStorage({ bookstore_theme: 'dark' });
    saveCart(storage, [{ bookId: A, quantity: 1 }]);
    saveCart(storage, []);
    assert.equal(storage.getItem('bookstore_theme'), 'dark');
  });

  it('survives unavailable storage', () => {
    const blocked = {
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('quota'); },
      removeItem() { throw new Error('blocked'); },
    };
    assert.deepEqual(loadCart(blocked), []);
    assert.equal(saveCart(blocked, [{ bookId: A, quantity: 1 }]), false);
    assert.deepEqual(loadCart(null), []);
    assert.equal(saveCart(null, [{ bookId: A, quantity: 1 }]), false);
  });
});

describe('corrupted storage', () => {
  const bad = [
    'not json at all',
    '{"v":1,"items":',
    'null',
    '123',
    '"text"',
    '[]',
    '{"v":2,"items":[]}',
    '{"items":[]}',
    '{"v":1,"items":"nope"}',
    '{"v":1,"items":{"0":{}}}',
    `{"v":1,"items":[]}${' '.repeat(9000)}`,
  ];

  for (const raw of bad) {
    it(`discards ${JSON.stringify(raw.slice(0, 30))} and clears the key`, () => {
      const storage = fakeStorage({ [CART_KEY]: raw });
      assert.deepEqual(loadCart(storage), []);
      assert.equal(storage.data.has(CART_KEY), false);
    });
  }

  it('keeps good lines and drops bad ones', () => {
    const items = [
      { bookId: A, quantity: 2 },
      { bookId: 'short', quantity: 1 },
      { bookId: B, quantity: 0 },
      { bookId: B, quantity: -3 },
      { bookId: B, quantity: 1.5 },
      { bookId: B, quantity: '2' },
      { bookId: { $gt: '' }, quantity: 1 },
      { bookId: `${C}zz`, quantity: 1 },
      null,
      'x',
      7,
      { quantity: 1 },
      { bookId: C, quantity: 1 },
    ];
    assert.deepEqual(sanitizeItems(items), [{ bookId: A, quantity: 2 }, { bookId: C, quantity: 1 }]);
  });

  it('merges duplicate lines, lower-cases ids and caps the quantity', () => {
    const upper = A.toUpperCase().replaceAll('A', 'A');
    assert.deepEqual(
      sanitizeItems([{ bookId: A, quantity: 2 }, { bookId: upper, quantity: 3 }, { bookId: B, quantity: 500 }]),
      [{ bookId: A, quantity: 5 }, { bookId: B, quantity: MAX_QUANTITY }],
    );
  });

  it('limits the number of lines', () => {
    const many = Array.from({ length: MAX_LINES + 10 }, (_, i) => ({
      bookId: i.toString(16).padStart(24, '0'),
      quantity: 1,
    }));
    assert.equal(sanitizeItems(many).length, MAX_LINES);
  });

  it('parseCart reports whether the text was usable', () => {
    assert.deepEqual(parseCart(null), { items: [], valid: true });
    assert.equal(parseCart('{').valid, false);
    assert.equal(parseCart(serializeCart([{ bookId: A, quantity: 1 }])).valid, true);
  });
});

describe('add to cart and stock limits', () => {
  it('adds a new book with quantity 1', () => {
    const r = addToCart([], A, 5);
    assert.equal(r.status, 'added');
    assert.deepEqual(r.items, [{ bookId: A, quantity: 1 }]);
  });

  it('increases the quantity of a book already in the cart without mutating the input', () => {
    const before = [{ bookId: A, quantity: 1 }];
    const r = addToCart(before, A, 5);
    assert.deepEqual(r.items, [{ bookId: A, quantity: 2 }]);
    assert.deepEqual(before, [{ bookId: A, quantity: 1 }]);
  });

  it('never exceeds stock', () => {
    let items = [];
    for (let i = 0; i < 6; i += 1) items = addToCart(items, A, 3).items;
    assert.equal(quantityOf(items, A), 3);
    const r = addToCart(items, A, 3);
    assert.equal(r.status, 'at-limit');
    assert.equal(r.items, items);
  });

  it('reports when the last available copy was just added', () => {
    assert.equal(addToCart([], A, 1).capped, true);
    assert.equal(addToCart([], A, 2).capped, false);
  });

  it('caps a multi-copy add at stock', () => {
    const r = addToCart([{ bookId: A, quantity: 2 }], A, 4, 10);
    assert.equal(r.quantity, 4);
  });

  it('refuses out-of-stock, negative, fractional and non-numeric stock', () => {
    for (const stock of [0, -1, NaN, undefined, null, '5']) {
      assert.equal(addToCart([], A, stock).status, 'out-of-stock', String(stock));
    }
    assert.equal(limitFor(2.9), 2);
    assert.equal(limitFor(1000), MAX_QUANTITY);
  });

  it('refuses invalid ids and quantities', () => {
    for (const id of ['', 'xyz', undefined, null, 42, {}]) assert.equal(addToCart([], id, 5).status, 'invalid');
    for (const q of [0, -1, 1.5, NaN]) assert.equal(addToCart([], A, 5, q).status, 'invalid');
  });

  it('refuses a new book when the cart is full but allows more of an existing one', () => {
    const full = Array.from({ length: MAX_LINES }, (_, i) => ({ bookId: i.toString(16).padStart(24, '0'), quantity: 1 }));
    assert.equal(addToCart(full, A, 5).status, 'cart-full');
    assert.equal(addToCart(full, full[0].bookId, 5).status, 'added');
  });
});

describe('quantity changes', () => {
  const items = [{ bookId: A, quantity: 2 }, { bookId: B, quantity: 1 }];

  it('increases and decreases', () => {
    assert.equal(quantityOf(setQuantity(items, A, 3, 10).items, A), 3);
    assert.equal(quantityOf(setQuantity(items, A, 1, 10).items, A), 1);
  });

  it('never goes below 1', () => {
    for (const q of [0, -5]) {
      const r = setQuantity(items, A, q, 10);
      assert.equal(quantityOf(r.items, A), 1);
    }
  });

  it('never goes above stock and says so', () => {
    const r = setQuantity(items, A, 50, 4);
    assert.equal(r.status, 'limited');
    assert.equal(quantityOf(r.items, A), 4);
  });

  it('rejects unknown books, bad numbers and out-of-stock books', () => {
    assert.equal(setQuantity(items, C, 2, 10).status, 'invalid');
    assert.equal(setQuantity(items, A, NaN, 10).status, 'invalid');
    assert.equal(setQuantity(items, A, 2, 0).status, 'out-of-stock');
  });

  it('leaves other lines alone', () => {
    const r = setQuantity(items, A, 5, 10);
    assert.equal(quantityOf(r.items, B), 1);
  });
});

describe('remove, clear, count and totals', () => {
  const items = [{ bookId: A, quantity: 2 }, { bookId: B, quantity: 3 }];

  it('removes one book', () => {
    assert.deepEqual(removeFromCart(items, A), [{ bookId: B, quantity: 3 }]);
    assert.deepEqual(removeFromCart(items, C), items);
  });

  it('clearing persists as an empty cart', () => {
    const storage = fakeStorage();
    saveCart(storage, items);
    saveCart(storage, []);
    assert.deepEqual(loadCart(storage), []);
  });

  it('counts copies, not lines', () => {
    assert.equal(cartCount(items), 5);
    assert.equal(cartCount([]), 0);
  });

  it('line totals are exact integer paise', () => {
    assert.equal(lineTotalCents(29999, 3), 89997);
    assert.equal(lineTotalCents(1999, 7) + lineTotalCents(1, 1), 13994);
  });
});

describe('unavailable books and reduced stock', () => {
  const items = [{ bookId: A, quantity: 5 }, { bookId: B, quantity: 2 }, { bookId: C, quantity: 1 }];

  it('drops books the API says no longer exist', () => {
    assert.deepEqual(reconcileItems(items, { remove: [B] }).map((i) => i.bookId), [A, C]);
  });

  it('lowers quantities to the new stock but never raises them', () => {
    const r = reconcileItems(items, { clamp: { [A]: 3, [B]: 9 } });
    assert.equal(quantityOf(r, A), 3);
    assert.equal(quantityOf(r, B), 2);
  });

  it('ignores nonsense clamp values and returns the same lines when nothing changes', () => {
    const r = reconcileItems(items, { clamp: { [A]: 0, [B]: -1, [C]: 1.5 } });
    assert.deepEqual(r, items);
    assert.deepEqual(reconcileItems(items), items);
  });
});
