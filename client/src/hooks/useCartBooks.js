import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, getBook } from '../services/api.js';

// Looks up the current price, title and stock of every book in the cart from the API.
// Result per book id: { status: 'ok', book } | { status: 'missing' } | { status: 'error' }.
// 'missing' means the API said the book does not exist; 'error' means we could not find out.

async function lookUp(id) {
  try {
    return [id, { status: 'ok', book: await getBook(id) }];
  } catch (err) {
    const gone = err instanceof ApiError && (err.status === 404 || err.status === 400);
    return [id, { status: gone ? 'missing' : 'error' }];
  }
}

export default function useCartBooks(items) {
  const [results, setResults] = useState({});
  const [retryKey, setRetryKey] = useState(0);
  const resultsRef = useRef({});
  const idsKey = items.map((item) => item.bookId).join(',');

  useEffect(() => {
    let current = true;
    const wanted = idsKey.split(',').filter(Boolean).filter((id) => !resultsRef.current[id]);
    if (wanted.length === 0) return undefined;

    Promise.all(wanted.map(lookUp)).then((entries) => {
      if (!current) return;
      resultsRef.current = { ...resultsRef.current, ...Object.fromEntries(entries) };
      setResults(resultsRef.current);
    });
    return () => {
      current = false;
    };
  }, [idsKey, retryKey]);

  /** Looks again at the books that could not be checked. */
  const retry = useCallback(() => {
    resultsRef.current = Object.fromEntries(
      Object.entries(resultsRef.current).filter(([, result]) => result.status !== 'error'),
    );
    setResults(resultsRef.current);
    setRetryKey((key) => key + 1);
  }, []);

  const loading = items.some((item) => !results[item.bookId]);
  return { results, loading, retry };
}
