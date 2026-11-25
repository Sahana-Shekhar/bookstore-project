import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Button, InlineNotification, SkeletonText } from '@carbon/react';
import { Add, Subtract, TrashCan } from '@carbon/icons-react';
import { useCart } from '../context/CartContext.jsx';
import useCartBooks from '../hooks/useCartBooks.js';
import BookCover from '../components/catalogue/BookCover.jsx';
import StockTag from '../components/catalogue/StockTag.jsx';
import { limitFor, lineTotalCents } from '../cart/cartStorage.js';
import { formatPrice } from '../utils/format.js';

function CartSkeleton() {
  return (
    <div className="bk-cart__skeleton" aria-hidden="true" data-testid="cart-skeleton">
      {[0, 1].map((n) => (
        <div className="bk-cart-line" key={n}>
          <SkeletonText heading width="60%" />
          <SkeletonText width="40%" />
        </div>
      ))}
    </div>
  );
}

function CartLine({ item, result, onAnnounce, onRetry }) {
  const { setQuantity, remove } = useCart();

  if (result.status === 'error') {
    return (
      <li className="bk-cart-line bk-cart-line--unverified" data-testid="cart-line">
        <div className="bk-cart-line__info">
          <p className="bk-cart-line__title">A book in your cart</p>
          <p className="bk-cart-line__meta">
            We could not check its current price and stock, so it is not included in the total.
          </p>
        </div>
        <div className="bk-cart-line__actions">
          <Button kind="tertiary" size="sm" onClick={onRetry}>Try again</Button>
          <Button kind="ghost" size="sm" onClick={() => remove(item.bookId)}>Remove</Button>
        </div>
      </li>
    );
  }

  const { book } = result;
  const limit = limitFor(book.stock);
  const soldOut = limit === 0;
  const quantity = item.quantity;
  const atLimit = !soldOut && quantity >= limit;

  const change = (next) => {
    const outcome = setQuantity(item.bookId, next, book.stock);
    onAnnounce(
      outcome.status === 'limited'
        ? `Only ${limit} available. Quantity of ${book.title} is ${outcome.quantity}.`
        : `Quantity of ${book.title} is ${outcome.quantity}.`,
    );
  };

  return (
    <li className={`bk-cart-line${soldOut ? ' bk-cart-line--soldout' : ''}`} data-testid="cart-line">
      <Link to={`/books/${book.id}`} className="bk-cart-line__cover" tabIndex={-1} aria-hidden="true">
        <BookCover book={book} />
      </Link>

      <div className="bk-cart-line__info">
        <p className="bk-cart-line__title">
          <Link to={`/books/${book.id}`}>{book.title}</Link>
        </p>
        <p className="bk-cart-line__meta">by {book.author.name}</p>
        <p className="bk-cart-line__meta">
          {formatPrice(book.priceCents)} each
        </p>
        <StockTag stock={book.stock} />
        <p className="bk-cart-line__meta" data-testid="line-stock">
          {soldOut ? 'Out of stock: not included in the total.' : `${book.stock} in stock`}
        </p>
      </div>

      <div className="bk-cart-line__actions">
        {!soldOut && (
          <div className="bk-qty" role="group" aria-label={`Quantity of ${book.title}`}>
            <Button
              kind="tertiary"
              size="md"
              hasIconOnly
              renderIcon={Subtract}
              iconDescription={`Decrease quantity of ${book.title}`}
              tooltipPosition="top"
              disabled={quantity <= 1}
              onClick={() => change(quantity - 1)}
            />
            <span className="bk-qty__value" data-testid="line-qty">{quantity}</span>
            <Button
              kind="tertiary"
              size="md"
              hasIconOnly
              renderIcon={Add}
              iconDescription={`Increase quantity of ${book.title}`}
              tooltipPosition="top"
              disabled={atLimit}
              onClick={() => change(quantity + 1)}
            />
          </div>
        )}
        {atLimit && (
          <p className="bk-cart-line__limit" data-testid="line-limit">
            Maximum available ({limit})
          </p>
        )}
        <Button
          kind="ghost"
          size="sm"
          renderIcon={TrashCan}
          onClick={() => {
            remove(item.bookId);
            onAnnounce(`${book.title} removed from your cart.`);
          }}
        >
          Remove<span className="cds--visually-hidden">: {book.title}</span>
        </Button>
      </div>

      <p className="bk-cart-line__total" data-testid="line-total">
        {soldOut ? (
          <span className="bk-cart-line__muted">Unavailable</span>
        ) : (
          <>
            <span className="cds--visually-hidden">Line total: </span>
            {formatPrice(lineTotalCents(book.priceCents, quantity))}
          </>
        )}
      </p>
    </li>
  );
}

export default function Cart() {
  const { items, reconcile, clear, migrateId } = useCart();
  const { results, loading, retry } = useCartBooks(items);
  const [notices, setNotices] = useState([]);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  // The API is the source of truth: drop books that no longer exist and lower quantities to the stock.
  useEffect(() => {
    const remove = [];
    const clamp = {};
    const found = [];
    for (const item of items) {
      const result = results[item.bookId];
      if (!result) continue;
      if (result.status === 'ok' && result.book.id !== item.bookId) {
        migrateId(item.bookId, result.book.id);
        return;
      }
      if (result.status === 'missing') {
        remove.push(item.bookId);
        found.push({
          key: `gone:${item.bookId}`,
          text: 'A book in your cart is no longer available and was removed.',
        });
      } else if (result.status === 'ok') {
        const limit = limitFor(result.book.stock);
        if (limit >= 1 && item.quantity > limit) {
          clamp[item.bookId] = limit;
          found.push({
            key: `less:${item.bookId}:${limit}`,
            text: `Only ${limit} ${limit === 1 ? 'copy' : 'copies'} of "${result.book.title}" ${
              limit === 1 ? 'is' : 'are'
            } in stock, so the quantity was lowered to ${limit}.`,
          });
        }
      }
    }
    if (found.length === 0) return;
    reconcile({ remove, clamp });
    setNotices((previous) => [
      ...previous,
      ...found.filter((entry) => !previous.some((old) => old.key === entry.key)),
    ]);
  }, [items, results, reconcile]);

  // Only verified, in-stock lines are priced. Everything else is shown but left out of the total.
  const priced = items.flatMap((item) => {
    const result = results[item.bookId];
    return result?.status === 'ok' && limitFor(result.book.stock) > 0
      ? [{ quantity: item.quantity, priceCents: result.book.priceCents }]
      : [];
  });
  const units = priced.reduce((sum, line) => sum + line.quantity, 0);
  const totalCents = priced.reduce((sum, line) => sum + lineTotalCents(line.priceCents, line.quantity), 0);
  const hasExcluded = priced.length < items.length;

  const visibleItems = items.filter((item) => results[item.bookId]?.status !== 'missing');

  return (
    <>
      <h1>Cart</h1>

      <div className="cds--visually-hidden" role="status" aria-live="polite">{announcement}</div>

      {notices.map((notice) => (
        <InlineNotification
          key={notice.key}
          kind="warning"
          lowContrast
          title="Cart updated."
          subtitle={notice.text}
          onCloseButtonClick={() => setNotices((all) => all.filter((n) => n.key !== notice.key))}
        />
      ))}

      {items.length === 0 ? (
        <div className="bk-state bk-state--empty" data-testid="cart-empty">
          <p className="bk-state__title">Your cart is empty</p>
          <p>Books you add will wait here until you are ready, even if you close the browser.</p>
          <Button as={Link} to="/books">Browse books</Button>
        </div>
      ) : loading ? (
        <CartSkeleton />
      ) : (
        <div className="bk-cart">
          <ul className="bk-cart__lines" aria-label="Items in your cart">
            {visibleItems.map((item) => (
              <CartLine
                key={item.bookId}
                item={item}
                result={results[item.bookId]}
                onAnnounce={setAnnouncement}
                onRetry={retry}
              />
            ))}
          </ul>

          <aside className="bk-cart__summary" aria-labelledby="summary-heading">
            <h2 id="summary-heading">Order summary</h2>
            <dl className="bk-summary">
              <div>
                <dt>Items</dt>
                <dd data-testid="summary-units">{units}</dd>
              </div>
              <div>
                <dt>Subtotal</dt>
                <dd data-testid="summary-subtotal">{formatPrice(totalCents)}</dd>
              </div>
              <div className="bk-summary__total">
                <dt>Total</dt>
                <dd data-testid="summary-total">{formatPrice(totalCents)}</dd>
              </div>
            </dl>
            <p className="bk-summary__note">
              Prices are in Indian rupees. Shipping and taxes are not added yet.
              {hasExcluded && ' Unavailable or unchecked books are not included.'}
            </p>

            {units > 0 ? (
              <Button as={Link} to="/checkout" className="bk-cart__checkout">
                Checkout
              </Button>
            ) : (
              <Button className="bk-cart__checkout" disabled>
                Checkout
              </Button>
            )}

            {confirmingClear ? (
              <div className="bk-summary__confirm" role="group" aria-label="Confirm clearing the cart">
                <p>Remove every book from your cart?</p>
                <div className="bk-summary__buttons">
                  <Button
                    kind="danger"
                    size="md"
                    onClick={() => {
                      clear();
                      setConfirmingClear(false);
                      setAnnouncement('Your cart is now empty.');
                    }}
                  >
                    Yes, clear cart
                  </Button>
                  <Button kind="secondary" size="md" onClick={() => setConfirmingClear(false)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <Button kind="tertiary" size="md" renderIcon={TrashCan} onClick={() => setConfirmingClear(true)}>
                Clear cart
              </Button>
            )}
          </aside>
        </div>
      )}
    </>
  );
}
