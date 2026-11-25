import { Link } from 'react-router';
import { SkeletonPlaceholder, SkeletonText } from '@carbon/react';
import BookCover from './BookCover.jsx';
import StockTag from './StockTag.jsx';
import { formatPrice } from '../../utils/format.js';

/**
 * One catalogue entry. The title link is stretched over the whole card (see .bk-card__link::after),
 * so the card is one tap target but exposes a single link to assistive technology.
 * `from` is the catalogue query string, so the details page can link back to the same results.
 */
export default function BookCard({ book, from }) {
  return (
    <article className="bk-card">
      <BookCover book={book} />
      <div className="bk-card__body">
        <p className="bk-card__category">{book.category.name}</p>
        <h2 className="bk-card__title">
          <Link className="bk-card__link" to={`/books/${book.id}`} state={{ from }}>
            {book.title}
          </Link>
        </h2>
        <p className="bk-card__author">{book.author.name}</p>
        <div className="bk-card__meta">
          <span className="bk-card__price">{formatPrice(book.priceCents)}</span>
          <StockTag stock={book.stock} />
        </div>
      </div>
    </article>
  );
}

export function BookCardSkeleton() {
  return (
    <div className="bk-card bk-card--skeleton">
      <SkeletonPlaceholder className="bk-card__cover-skeleton" />
      <div className="bk-card__body">
        <SkeletonText width="40%" />
        <SkeletonText heading width="90%" />
        <SkeletonText width="60%" />
        <SkeletonText width="50%" />
      </div>
    </div>
  );
}
