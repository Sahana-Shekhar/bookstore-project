// Pure cart logic: no React, no DOM. The cart lives in the browser only (localStorage) and holds
// nothing but book ids and quantities. Prices, titles and stock are NEVER stored: the cart page
// re-reads them from the API, so a tampered or stale value in localStorage cannot change a price.

export const CART_KEY = 'bookstore_cart';
export const CART_VERSION = 1;
export const MAX_LINES = 20; // different books in one cart
export const MAX_QUANTITY = 99; // per book, even when stock is higher
const MAX_RAW_LENGTH = 8000; // anything bigger than a full cart is not ours

const ID_PATTERN = /^(^[a-f\d]{24}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$)$/i;

const isQuantity = (value) => Number.isInteger(value) && value >= 1;

/** The most copies of a book the cart may hold, given its stock (0 when it cannot be bought). */
export const limitFor = (stock) =>
  Number.isFinite(stock) ? Math.min(MAX_QUANTITY, Math.max(0, Math.floor(stock))) : 0;

/** Turns untrusted data into a clean list of { bookId, quantity }. Bad lines are dropped. */
export function sanitizeItems(value) {
  if (!Array.isArray(value)) return [];
  const byId = new Map();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const { bookId, quantity } = entry;
    if (typeof bookId !== 'string' || !ID_PATTERN.test(bookId) || !isQuantity(quantity)) continue;
    const id = bookId.toLowerCase();
    if (!byId.has(id) && byId.size >= MAX_LINES) continue;
    byId.set(id, Math.min(MAX_QUANTITY, (byId.get(id) ?? 0) + quantity)); // duplicate lines are merged
  }
  return [...byId].map(([bookId, quantity]) => ({ bookId, quantity }));
}

/** Reads the stored text. `valid` is false when text was present but unusable (corrupted). */
export function parseCart(raw) {
  if (raw === null || raw === undefined) return { items: [], valid: true };
  if (typeof raw !== 'string' || raw.length > MAX_RAW_LENGTH) return { items: [], valid: false };
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || data.v !== CART_VERSION || !Array.isArray(data.items)) {
      return { items: [], valid: false };
    }
    return { items: sanitizeItems(data.items), valid: true };
  } catch {
    return { items: [], valid: false };
  }
}

export const serializeCart = (items) => JSON.stringify({ v: CART_VERSION, items: sanitizeItems(items) });

/** Loads the cart from a Storage-like object. Never throws; corrupted data is discarded. */
export function loadCart(storage) {
  if (!storage) return [];
  try {
    const { items, valid } = parseCart(storage.getItem(CART_KEY));
    if (!valid) storage.removeItem(CART_KEY);
    return items;
  } catch {
    return []; // storage blocked (privacy mode, disabled cookies, ...)
  }
}

/** Saves the cart. An empty cart removes the key. Returns false when the browser refuses. */
export function saveCart(storage, items) {
  if (!storage) return false;
  try {
    if (items.length === 0) storage.removeItem(CART_KEY);
    else storage.setItem(CART_KEY, serializeCart(items));
    return true;
  } catch {
    return false;
  }
}

// ---- Changes. Each returns { items, status, quantity }; `items` is a new array, never mutated. ----

const unchanged = (items, status) => ({ items, status, quantity: 0 });

/**
 * Adds `quantity` copies (default 1). Statuses: 'added', 'at-limit' (nothing more fits),
 * 'out-of-stock', 'cart-full', 'invalid'. `capped` is true when the stock limit was reached.
 */
export function addToCart(items, bookId, stock, quantity = 1) {
  if (typeof bookId !== 'string' || !ID_PATTERN.test(bookId) || !isQuantity(quantity)) {
    return unchanged(items, 'invalid');
  }
  const id = bookId.toLowerCase();
  const limit = limitFor(stock);
  if (limit === 0) return unchanged(items, 'out-of-stock');

  const existing = items.find((item) => item.bookId === id);
  if (!existing && items.length >= MAX_LINES) return unchanged(items, 'cart-full');

  const current = existing?.quantity ?? 0;
  if (current >= limit) return { ...unchanged(items, 'at-limit'), quantity: current, capped: true };

  const next = Math.min(limit, current + quantity);
  const updated = existing
    ? items.map((item) => (item.bookId === id ? { bookId: id, quantity: next } : item))
    : [...items, { bookId: id, quantity: next }];
  return { items: updated, status: 'added', quantity: next, capped: next >= limit };
}

/**
 * Sets an exact quantity for a book already in the cart. The quantity is kept between 1 and the
 * stock limit; use removeFromCart to take a book out. Statuses: 'updated', 'limited' (clamped
 * down to stock), 'out-of-stock', 'invalid'.
 */
export function setQuantity(items, bookId, quantity, stock) {
  const id = typeof bookId === 'string' ? bookId.toLowerCase() : '';
  if (!items.some((item) => item.bookId === id) || !Number.isFinite(quantity)) {
    return unchanged(items, 'invalid');
  }
  const limit = limitFor(stock);
  if (limit === 0) return unchanged(items, 'out-of-stock');

  const wanted = Math.max(1, Math.floor(quantity));
  const next = Math.min(limit, wanted);
  return {
    items: items.map((item) => (item.bookId === id ? { bookId: id, quantity: next } : item)),
    status: next < wanted ? 'limited' : 'updated',
    quantity: next,
  };
}

export const removeFromCart = (items, bookId) => items.filter((item) => item.bookId !== bookId);

/**
 * Applies what the API said about the books: `remove` lists ids that no longer exist,
 * `clamp` maps id -> the largest quantity now allowed (stock went down).
 */
export function reconcileItems(items, { remove = [], clamp = {} } = {}) {
  return items
    .filter((item) => !remove.includes(item.bookId))
    .map((item) => {
      const max = clamp[item.bookId];
      return Number.isInteger(max) && max >= 1 && item.quantity > max
        ? { bookId: item.bookId, quantity: max }
        : item;
    });
}

export const cartCount = (items) => items.reduce((sum, item) => sum + item.quantity, 0);

export const quantityOf = (items, bookId) => items.find((item) => item.bookId === bookId)?.quantity ?? 0;

/** Money is whole paise (integers), so sums are exact. */
export const lineTotalCents = (priceCents, quantity) => priceCents * quantity;
