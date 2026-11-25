import { BookCardSkeleton } from './BookCard.jsx';

/** Placeholder grid shown while the first page of results loads. Hidden from screen readers; the page announces loading. */
export default function BookGridSkeleton({ count = 8 }) {
  return (
    <ul className="bk-grid" aria-hidden="true" data-testid="catalogue-skeleton">
      {Array.from({ length: count }, (_, i) => (
        <li key={i}>
          <BookCardSkeleton />
        </li>
      ))}
    </ul>
  );
}
