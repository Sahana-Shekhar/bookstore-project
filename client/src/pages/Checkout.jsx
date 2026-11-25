import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button, Form, InlineNotification, Stack, TextInput } from '@carbon/react';
import { ArrowLeft } from '@carbon/icons-react';
import { useCart } from '../context/CartContext.jsx';
import useCartBooks from '../hooks/useCartBooks.js';
import { createOrder } from '../services/api.js';
import { limitFor, lineTotalCents } from '../cart/cartStorage.js';
import { formatPrice } from '../utils/format.js';

const FIELDS = [
  { name: 'street', label: 'Street address', autoComplete: 'street-address' },
  { name: 'city', label: 'City', autoComplete: 'address-level2' },
  { name: 'state', label: 'State', autoComplete: 'address-level1' },
  { name: 'postalCode', label: 'Postal code', autoComplete: 'postal-code' },
  { name: 'country', label: 'Country', autoComplete: 'country-name' },
];
const MAX = 100;

export default function Checkout() {
  const { items, clear } = useCart();
  const { results, loading } = useCartBooks(items);
  const navigate = useNavigate();

  const [values, setValues] = useState(() => Object.fromEntries(FIELDS.map((f) => [f.name, ''])));
  const [touched, setTouched] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [placed, setPlaced] = useState(false);

  // Only books the API confirmed and that are in stock are ordered. The server re-checks everything.
  const lines = items.flatMap((item) => {
    const result = results[item.bookId];
    if (result?.status !== 'ok') return [];
    const limit = limitFor(result.book.stock);
    if (limit < 1) return [];
    return [{ book: result.book, quantity: Math.min(item.quantity, limit) }];
  });
  const skipped = items.length - lines.length;
  const totalCents = lines.reduce((sum, l) => sum + lineTotalCents(l.book.priceCents, l.quantity), 0);

  const errors = {};
  for (const f of FIELDS) {
    const v = values[f.name].trim();
    if (!v) errors[f.name] = `${f.label} is required`;
    else if (v.length > MAX) errors[f.name] = `Must be at most ${MAX} characters`;
  }
  const show = (name) => (touched[name] ? errors[name] : undefined);

  if (items.length === 0 && !placed) {
    return (
      <>
        <h1>Checkout</h1>
        <div className="bk-state bk-state--empty" data-testid="checkout-empty">
          <p className="bk-state__title">Your cart is empty</p>
          <p>Add some books to your cart before checking out.</p>
          <Button as={Link} to="/books">Browse books</Button>
        </div>
      </>
    );
  }

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (submitting) return; // prevents duplicate orders
    setTouched(Object.fromEntries(FIELDS.map((f) => [f.name, true])));
    setError('');
    if (Object.keys(errors).length > 0 || lines.length === 0) return;

    setSubmitting(true);
    try {
      const order = await createOrder({
        items: lines.map((l) => ({ bookId: l.book.id, quantity: l.quantity })),
        shippingAddress: Object.fromEntries(FIELDS.map((f) => [f.name, values[f.name].trim()])),
      });
      setPlaced(true);
      clear();
      navigate(`/orders/${order.id}`, { replace: true, state: { justPlaced: true } });
    } catch (err) {
      setError(err.message || 'Could not place your order. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    <>
      <p>
        <Link to="/cart" className="bk-backlink">
          <ArrowLeft size={16} aria-hidden="true" /> Back to cart
        </Link>
      </p>
      <h1>Checkout</h1>

      <InlineNotification
        kind="info"
        className="bk-checkout__notice"
        lowContrast
        hideCloseButton
        title="Simulated payment."
        subtitle="This is a capstone demo. No real payment is taken and no card details are needed."
      />

      {loading ? (
        <p role="status">Loading your order summary…</p>
      ) : (
        <div className="bk-cart">
          <Form onSubmit={handleSubmit} noValidate aria-label="Shipping details" className="bk-checkout__form">
            <Stack gap={6}>
              <h2 className="bk-checkout__heading">Shipping address</h2>
              {FIELDS.map((f) => (
                <TextInput
                  key={f.name}
                  id={`checkout-${f.name}`}
                  name={f.name}
                  labelText={f.label}
                  autoComplete={f.autoComplete}
                  maxLength={MAX}
                  value={values[f.name]}
                  onChange={(e) => setValues((prev) => ({ ...prev, [f.name]: e.target.value }))}
                  onBlur={() => setTouched((prev) => ({ ...prev, [f.name]: true }))}
                  invalid={Boolean(show(f.name))}
                  invalidText={show(f.name)}
                />
              ))}

              {error && (
                <InlineNotification
                  kind="error"
                  title="Order not placed."
                  subtitle={error}
                  hideCloseButton
                  lowContrast
                />
              )}
              {error && (
                <p>
                  <Link to="/cart">Review your cart</Link> to adjust quantities, then try again.
                </p>
              )}

              <Button type="submit" disabled={submitting || lines.length === 0}>
                {submitting ? 'Placing order…' : 'Place order (simulated payment)'}
              </Button>
            </Stack>
          </Form>

          <aside className="bk-cart__summary" aria-labelledby="checkout-summary-heading">
            <h2 id="checkout-summary-heading">Order summary</h2>
            <ul className="bk-checkout__lines" aria-label="Books in this order">
              {lines.map((l) => (
                <li key={l.book.id} data-testid="checkout-line">
                  <span>
                    {l.book.title} <span className="bk-checkout__qty">× {l.quantity}</span>
                  </span>
                  <span>{formatPrice(lineTotalCents(l.book.priceCents, l.quantity))}</span>
                </li>
              ))}
            </ul>
            <dl className="bk-summary">
              <div className="bk-summary__total">
                <dt>Total</dt>
                <dd data-testid="checkout-total">{formatPrice(totalCents)}</dd>
              </div>
            </dl>
            <p className="bk-summary__note">
              Payment is simulated. Prices in Indian rupees; the final total is confirmed by the server when you place
              the order.
              {skipped > 0 && ' Unavailable or unchecked books are not included.'}
            </p>
          </aside>
        </div>
      )}
    </>
  );
}
