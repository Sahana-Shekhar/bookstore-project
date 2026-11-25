import { useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@carbon/react';
import { ShoppingCart } from '@carbon/icons-react';
import { useCart } from '../../context/CartContext.jsx';
import { limitFor } from '../../cart/cartStorage.js';

/** Add to Cart for the book details page. `book` comes from the API, so price and stock are current. */
export default function AddToCart({ book }) {
  const cart = useCart();
  const [message, setMessage] = useState('');

  const limit = limitFor(book.stock);
  const inCart = cart.quantityOf(book.id);
  const soldOut = limit === 0;
  const atLimit = !soldOut && inCart >= limit;

  const handleAdd = () => {
    const result = cart.add(book.id, book.stock, 1);
    if (result.status === 'added') {
      setMessage(
        result.capped
          ? `Added to your cart. You have all ${result.quantity} available copies.`
          : `Added to your cart. You now have ${result.quantity}.`,
      );
    } else if (result.status === 'at-limit') {
      setMessage(`Maximum reached: only ${limit} ${limit === 1 ? 'copy is' : 'copies are'} in stock.`);
    } else if (result.status === 'cart-full') {
      setMessage('Your cart is full. Remove a book before adding another.');
    } else if (result.status === 'out-of-stock') {
      setMessage('This book is out of stock.');
    }
  };

  if (soldOut) {
    return (
      <div className="bk-detail__actions" data-slot="add-to-cart">
        <Button renderIcon={ShoppingCart} disabled>Out of stock</Button>
        {inCart > 0 && (
          <p className="bk-detail__cart-note">
            This book is in your cart but no longer in stock. <Link to="/cart">Review your cart</Link>.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="bk-detail__actions" data-slot="add-to-cart">
      <div className="bk-detail__action-row">
        <Button renderIcon={ShoppingCart} onClick={handleAdd} disabled={atLimit}>
          Add to cart
        </Button>
        {inCart > 0 && (
          <Button as={Link} to="/cart" kind="tertiary">
            View cart
          </Button>
        )}
      </div>
      {inCart > 0 && (
        <p className="bk-detail__cart-note" data-testid="in-cart-note">
          {inCart} in your cart{atLimit ? ` (maximum available: ${limit})` : ''}
        </p>
      )}
      {/* Announced politely to screen readers; also visible so everyone gets the same feedback. */}
      <p className="bk-detail__cart-note bk-detail__cart-message" role="status" aria-live="polite">
        {message}
      </p>
    </div>
  );
}
