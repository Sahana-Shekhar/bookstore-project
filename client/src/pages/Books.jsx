import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Button, InlineNotification, PaginationNav, Search, Select, SelectItem } from '@carbon/react';
import { getBooks, getCategories } from '../services/api.js';
import BookCard from '../components/catalogue/BookCard.jsx';
import BookGridSkeleton from '../components/catalogue/BookGridSkeleton.jsx';

const PAGE_SIZE = 12;
const SEARCH_DEBOUNCE_MS = 350;
const SORTS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'title-asc', label: 'Title: A to Z' },
  { value: 'title-desc', label: 'Title: Z to A' },
  { value: 'price-asc', label: 'Price: low to high' },
  { value: 'price-desc', label: 'Price: high to low' },
];
const SORT_VALUES = SORTS.map((s) => s.value);
const OBJECT_ID = /^([a-f\d]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Reads the URL defensively: anything invalid falls back to the default instead of breaking the page. */
function readParams(searchParams) {
  const page = Number.parseInt(searchParams.get('page') ?? '', 10);
  const sort = searchParams.get('sort');
  const category = searchParams.get('category') ?? '';
  return {
    q: (searchParams.get('q') ?? '').trim().slice(0, 100),
    category: OBJECT_ID.test(category) ? category : '',
    sort: SORT_VALUES.includes(sort) ? sort : 'newest',
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

export default function Books() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { q, category, sort, page } = readParams(searchParams);

  const [categories, setCategories] = useState([]);
  const [result, setResult] = useState(null); // last successful response
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const requestId = useRef(0);

  // ---- URL updates. Changing search, category or sort always returns to page 1. ----
  const update = useCallback(
    (changes, { replace = false } = {}) => {
      const next = { q, category, sort, page, ...changes };
      const params = new URLSearchParams();
      if (next.q) params.set('q', next.q);
      if (next.category) params.set('category', next.category);
      if (next.sort !== 'newest') params.set('sort', next.sort);
      if (next.page > 1) params.set('page', String(next.page));
      setSearchParams(params, { replace });
    },
    [q, category, sort, page, setSearchParams],
  );

  // ---- Search box: typing is debounced, Enter and the clear button apply immediately. ----
  const [text, setText] = useState(q);
  useEffect(() => {
    setText(q); // back/forward, "clear filters" and shared links update the box
  }, [q]);
  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed === q) return undefined;
    const timer = setTimeout(() => update({ q: trimmed, page: 1 }, { replace: true }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, q, update]);

  // ---- Categories (the page still works without them) ----
  useEffect(() => {
    getCategories()
      .then((data) => setCategories(data.items))
      .catch(() => setCategories([]));
  }, []);

  // ---- Books. Stale responses (a slower, older request finishing late) are ignored. ----
  useEffect(() => {
    const id = ++requestId.current;
    setLoading(true);
    setError(false);
    getBooks({ q, categoryId: category, sort, page, pageSize: PAGE_SIZE })
      .then((data) => {
        if (id !== requestId.current) return;
        setResult(data);
        setLoading(false);
      })
      .catch(() => {
        if (id !== requestId.current) return;
        setError(true);
        setLoading(false);
      });
  }, [q, category, sort, page, reloadKey]);

  // A page past the end (old bookmark, or books were removed) goes to the last real page.
  useEffect(() => {
    if (result && !loading && result.items.length === 0 && result.totalPages > 0 && page > result.totalPages) {
      update({ page: result.totalPages }, { replace: true });
    }
  }, [result, loading, page, update]);

  // Bring the top of the results into view when moving between pages.
  const topRef = useRef(null);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    topRef.current?.scrollIntoView({ block: 'start' });
  }, [page]);

  const hasFilters = Boolean(q || category);
  const clearFilters = () => {
    setText('');
    setSearchParams(sort === 'newest' ? {} : { sort });
  };
  const from = searchParams.toString();
  const selectedCategory = categories.find((c) => c.id === category);

  let summary = 'Loading books';
  if (result && !error) {
    const first = (result.page - 1) * result.pageSize + 1;
    const last = first + result.items.length - 1;
    summary =
      result.total === 0
        ? 'No books found'
        : `Showing ${first}\u2013${last} of ${result.total} ${result.total === 1 ? 'book' : 'books'}`;
  }

  return (
    <div className="bk-catalogue">
      <header className="bk-catalogue__header" ref={topRef}>
        <h1>Books</h1>
        <p className="bk-catalogue__lede">Browse the collection by title, author or category.</p>
      </header>

      <section className="bk-toolbar" aria-label="Search and filter books">
        <form
          className="bk-toolbar__search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            update({ q: text.trim(), page: 1 });
          }}
        >
          <Search
            id="catalogue-search"
            size="lg"
            labelText="Search books by title or author"
            placeholder="Search by title or author"
            closeButtonLabelText="Clear search"
            value={text}
            maxLength={100}
            onChange={(event) => setText(event.target.value)}
            onClear={() => {
              setText('');
              update({ q: '', page: 1 });
            }}
          />
        </form>
        <div className="bk-toolbar__sort">
          <Select
            id="catalogue-sort"
            labelText="Sort by"
            value={sort}
            onChange={(event) => update({ sort: event.target.value, page: 1 })}
          >
            {SORTS.map((s) => (
              <SelectItem key={s.value} value={s.value} text={s.label} />
            ))}
          </Select>
        </div>
      </section>

      {categories.length > 0 && (
        <div className="bk-chips" role="group" aria-label="Filter by category">
          <button
            type="button"
            className="bk-chip"
            aria-pressed={!category}
            onClick={() => update({ category: '', page: 1 })}
          >
            All categories
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              className="bk-chip"
              aria-pressed={category === c.id}
              onClick={() => update({ category: c.id, page: 1 })}
            >
              {c.name}
              <span className="bk-chip__count">{c.bookCount}</span>
            </button>
          ))}
        </div>
      )}

      <p className="bk-catalogue__summary" role="status" aria-live="polite">
        {summary}
        {selectedCategory && !error && result?.total > 0 ? ` in ${selectedCategory.name}` : ''}
        {q && !error && result?.total > 0 ? ` for \u201C${q}\u201D` : ''}
      </p>

      {error && (
        <div className="bk-state">
          <InlineNotification
            kind="error"
            title="Could not load books"
            subtitle="Check your connection and try again."
            hideCloseButton
            lowContrast
          />
          <Button kind="tertiary" onClick={() => setReloadKey((k) => k + 1)}>
            Try again
          </Button>
        </div>
      )}

      {!error && !result && loading && <BookGridSkeleton count={8} />}

      {!error && result && result.items.length > 0 && (
        <div className={loading ? 'bk-results bk-results--busy' : 'bk-results'} aria-busy={loading}>
          <ul className="bk-grid">
            {result.items.map((book) => (
              <li key={book.id}>
                <BookCard book={book} from={from} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {!error && result && !loading && result.total === 0 && (
        <div className="bk-state bk-state--empty">
          <h2>{hasFilters ? 'No books match your search' : 'No books yet'}</h2>
          <p>
            {hasFilters
              ? 'Try a different spelling, a shorter search, or remove a filter.'
              : 'The catalogue is empty right now. Please check back soon.'}
          </p>
          {hasFilters && (
            <Button kind="tertiary" onClick={clearFilters}>
              Clear search and filters
            </Button>
          )}
        </div>
      )}

      {!error && result && result.totalPages > 1 && (
        <nav className="bk-pagination" aria-label="Book pages">
          <PaginationNav
            page={Math.min(page, result.totalPages) - 1}
            totalItems={result.totalPages}
            itemsShown={5}
            onChange={(index) => update({ page: index + 1 })}
          />
        </nav>
      )}
    </div>
  );
}
