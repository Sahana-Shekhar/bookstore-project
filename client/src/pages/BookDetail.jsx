import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import {
  Button,
  InlineNotification,
  SkeletonPlaceholder,
  SkeletonText,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  StructuredListWrapper,
} from '@carbon/react';
import { ArrowLeft } from '@carbon/icons-react';
import { ApiError, getBook } from '../services/api.js';
import BookCover from '../components/catalogue/BookCover.jsx';
import StockTag from '../components/catalogue/StockTag.jsx';
import AddToCart from '../components/cart/AddToCart.jsx';
import { formatPrice, stockStatus } from '../utils/format.js';

function BookDetailSkeleton() {
  return (
    <div className="bk-detail" aria-hidden="true" data-testid="detail-skeleton">
      <SkeletonPlaceholder className="bk-detail__cover-skeleton" />
      <div className="bk-detail__info">
        <SkeletonText width="30%" />
        <SkeletonText heading width="80%" />
        <SkeletonText width="40%" />
        <SkeletonText paragraph lineCount={4} />
      </div>
    </div>
  );
}

export default function BookDetail() {
  const { id } = useParams();
  const location = useLocation();
  const [state, setState] = useState({ id: null, book: null, error: null });
  const [reloadKey, setReloadKey] = useState(0);

  // Returns to the exact search, filter, sort and page the visitor came from.
  const from = typeof location.state?.from === 'string' ? location.state.from : '';
  const backTo = `/books${from ? `?${from}` : ''}`;

  useEffect(() => {
    let current = true;
    getBook(id)
      .then((book) => {
        if (current) setState({ id, book, error: null });
      })
      .catch((err) => {
        if (!current) return;
        const notFound = err instanceof ApiError && (err.status === 404 || err.status === 400);
        setState({ id, book: null, error: notFound ? 'not-found' : 'failed' });
      });
    return () => {
      current = false;
    };
  }, [id, reloadKey]);

  const loading = state.id !== id;
  const { book, error } = state;

  const backLink = (
    <p>
      <Link to={backTo} className="bk-backlink">
        <ArrowLeft size={16} aria-hidden="true" /> Back to books
      </Link>
    </p>
  );

  if (loading) {
    return (
      <>
        {backLink}
        <BookDetailSkeleton />
      </>
    );
  }

  if (error === 'not-found') {
    return (
      <>
        {backLink}
        <div className="bk-state bk-state--empty">
          <h1>Book not found</h1>
          <p>This book does not exist or is no longer available.</p>
          <Button as={Link} to="/books" kind="tertiary">Browse all books</Button>
        </div>
      </>
    );
  }

  if (error) {
    return (
      <>
        {backLink}
        <div className="bk-state">
          <InlineNotification
            kind="error"
            title="Could not load this book"
            subtitle="Check your connection and try again."
            hideCloseButton
            lowContrast
          />
          <Button
            kind="tertiary"
            onClick={() => {
              setState({ id: null, book: null, error: null });
              setReloadKey((k) => k + 1);
            }}
          >
            Try again
          </Button>
        </div>
      </>
    );
  }

  const soldOut = book.stock <= 0;

  return (
    <>
      {backLink}
      <article className="bk-detail">
        <BookCover book={book} />
        <div className="bk-detail__info">
          <p className="bk-detail__category">{book.category.name}</p>
          <h1>{book.title}</h1>
          <p className="bk-detail__author">by {book.author.name}</p>

          <div className="bk-detail__buy">
            <p className="bk-detail__price">{formatPrice(book.priceCents)}</p>
            <StockTag stock={book.stock} size="md" />
          </div>

          {soldOut && (
            <InlineNotification
              kind="warning"
              title="Currently out of stock."
              subtitle="This book is not available to order right now. Please check back later."
              hideCloseButton
              lowContrast
            />
          )}

          <AddToCart book={book} />

          {book.description && (
            <section aria-labelledby="about-heading">
              <h2 id="about-heading">About this book</h2>
              <p className="bk-detail__description">{book.description}</p>
            </section>
          )}

          <section aria-labelledby="details-heading">
            <h2 id="details-heading">Details</h2>
            <StructuredListWrapper isCondensed aria-label="Book details">
              <StructuredListBody>
                <StructuredListRow>
                  <StructuredListCell noWrap>Author</StructuredListCell>
                  <StructuredListCell>{book.author.name}</StructuredListCell>
                </StructuredListRow>
                <StructuredListRow>
                  <StructuredListCell noWrap>Category</StructuredListCell>
                  <StructuredListCell>{book.category.name}</StructuredListCell>
                </StructuredListRow>
                <StructuredListRow>
                  <StructuredListCell noWrap>ISBN</StructuredListCell>
                  <StructuredListCell>{book.isbn}</StructuredListCell>
                </StructuredListRow>
                <StructuredListRow>
                  <StructuredListCell noWrap>Availability</StructuredListCell>
                  <StructuredListCell>{stockStatus(book.stock).label}</StructuredListCell>
                </StructuredListRow>
              </StructuredListBody>
            </StructuredListWrapper>
          </section>
        </div>
      </article>
    </>
  );
}
