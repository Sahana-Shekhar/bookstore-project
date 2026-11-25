import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  CART_KEY,
  addToCart,
  cartCount,
  loadCart,
  quantityOf,
  reconcileItems,
  removeFromCart,
  saveCart,
  setQuantity,
} from '../cart/cartStorage.js';

const CartContext = createContext(null);

function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null; // access itself can throw when storage is blocked
  }
}

export function CartProvider({ children }) {
  const [items, setItems] = useState(() => loadCart(browserStorage()));
  // The ref always holds the latest cart so actions can return their result straight away.
  const itemsRef = useRef(items);

  const commit = useCallback((next) => {
    itemsRef.current = next;
    setItems(next);
    saveCart(browserStorage(), next);
  }, []);

  // Keeps several tabs in step: another tab changing the cart updates this one.
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key !== null && event.key !== CART_KEY) return;
      const next = loadCart(browserStorage());
      itemsRef.current = next;
      setItems(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const value = useMemo(() => {
    const run = (change) => {
      const result = change(itemsRef.current);
      if (result.items !== itemsRef.current) commit(result.items);
      return result;
    };
    return {
      items,
      count: cartCount(items),
      quantityOf: (bookId) => quantityOf(items, bookId),
      /** stock comes from the API response the caller just showed the visitor. */
      add: (bookId, stock, quantity = 1) => run((current) => addToCart(current, bookId, stock, quantity)),
      setQuantity: (bookId, quantity, stock) => run((current) => setQuantity(current, bookId, quantity, stock)),
      remove: (bookId) => commit(removeFromCart(itemsRef.current, bookId)),
      clear: () => commit([]),
      migrateId: (oldId, newId) => {
        const next = itemsRef.current.map((item) =>
          item.bookId === oldId ? { ...item, bookId: newId } : item
        );
        commit(next);
      },
      /** Applies API findings: { remove: [ids], clamp: { id: maxQuantity } }. */
      reconcile: (verdicts) => {
        const next = reconcileItems(itemsRef.current, verdicts);
        if (next.length !== itemsRef.current.length || next.some((item, i) => item !== itemsRef.current[i])) {
          commit(next);
        }
      },
    };
  }, [items, commit]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const context = useContext(CartContext);
  if (!context) throw new Error('useCart must be used inside <CartProvider>');
  return context;
}
