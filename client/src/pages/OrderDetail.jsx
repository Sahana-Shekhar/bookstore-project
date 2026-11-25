import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { Button, InlineNotification, SkeletonText, Tag } from '@carbon/react';
import { ArrowLeft } from '@carbon/icons-react';
import { ApiError, cancelOrder, getOrder } from '../services/api.js';
import { ORDER_STATUS_TAG as STATUS_TAG, formatDate, formatPrice } from '../utils/format.js';

const PAYMENT_LABEL = { COMPLETED: 'Completed (simulated)', PENDING: 'Pending (simulated)', FAILED: 'Failed (simulated)' };

export default function OrderDetail() {
  const { id } = useParams();
  const location = useLocation();
  const justPlaced = Boolean(location.state?.justPlaced);

  const [state, setState] = useState({ id: null, order: null, error: null });
  const [reloadKey, setReloadKey] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [cancelError, setCancelError] = useState('');
  const [cancelled, setCancelled] = useState(false);
  const inFlight = useRef(false); // synchronous guard against double clicks

  useEffect(() => {
    let current = true;
    getOrder(id)
      .then((order) => current && setState({ id, order, error: null }))
      .catch((err) => {
        if (!current) return;
        const notFound = err instanceof ApiError && (err.status === 404 || err.status === 400);
        setState({ id, order: null, error: notFound ? 'not-found' : 'failed' });
      });
    return () => {
      current = false;
    };
  }, [id, reloadKey]);

  const backLink = (
    <p>
      <Link to="/orders" className="bk-backlink">
        <ArrowLeft size={16} aria-hidden="true" /> Back to my orders
      </Link>
    </p>
  );

  if (state.id !== id) {
    return (
      <>
        {backLink}
        <div aria-hidden="true">
          <SkeletonText heading width="50%" />
          <SkeletonText paragraph lineCount={4} />
        </div>
      </>
    );
  }

  if (state.error === 'not-found') {
    return (
      <>
        {backLink}
        <div className="bk-state bk-state--empty">
          <h1>Order not found</h1>
          <p>This order does not exist or does not belong to your account.</p>
          <Button as={Link} to="/orders" kind="tertiary">View my orders</Button>
        </div>
      </>
    );
  }

  if (state.error) {
    return (
      <>
        {backLink}
        <div className="bk-state">
          <InlineNotification
            kind="error"
            title="Could not load this order"
            subtitle="Check your connection and try again."
            hideCloseButton
            lowContrast
          />
          <Button
            kind="tertiary"
            onClick={() => {
              setState({ id: null, order: null, error: null });
              setReloadKey((k) => k + 1);
            }}
          >
            Try again
          </Button>
        </div>
      </>
    );
  }

  const { order } = state;
  const tag = STATUS_TAG[order.status] ?? { type: 'gray', label: order.status };
  const canCancel = order.status === 'PLACED'; // the server enforces the same rule
  const addr = order.shippingAddress;

  const handleCancel = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setCancelling(true);
    setCancelError('');
    try {
      await cancelOrder(order.id);
      const fresh = await getOrder(order.id); // refresh what is displayed
      setState({ id, order: fresh, error: null });
      setCancelled(true);
      setConfirming(false);
    } catch (err) {
      setCancelError(err.message || 'Could not cancel this order. Please try again.');
      // The order may have changed elsewhere; show its real status.
      try {
        setState({ id, order: await getOrder(order.id), error: null });
      } catch {
        /* keep what we have */
      }
    } finally {
      inFlight.current = false;
      setCancelling(false);
    }
  };

  return (
    <>
      {backLink}
      <h1>Order {order.orderNumber}</h1>

      {justPlaced && !cancelled && order.status === 'PLACED' && (
        <InlineNotification
          kind="success"
          lowContrast
          hideCloseButton
          title="Order placed."
          subtitle="Thank you! Payment was simulated, so no money was taken."
        />
      )}
      {cancelled && (
        <InlineNotification
          kind="success"
          lowContrast
          hideCloseButton
          title="Order cancelled."
          subtitle="The books have been returned to stock."
        />
      )}
      {cancelError && (
        <InlineNotification kind="error" lowContrast hideCloseButton title="Could not cancel." subtitle={cancelError} />
      )}

      <div className="bk-order-meta">
        <div>
          <span className="bk-order-meta__label">Placed on</span>
          <span data-testid="order-date">{formatDate(order.createdAt)}</span>
        </div>
        <div>
          <span className="bk-order-meta__label">Status</span>
          <Tag type={tag.type} size="md" data-testid="order-status">{tag.label}</Tag>
        </div>
        <div>
          <span className="bk-order-meta__label">Payment</span>
          <span data-testid="order-payment">{PAYMENT_LABEL[order.paymentStatus] ?? order.paymentStatus}</span>
        </div>
      </div>

      <div className="bk-cart">
        <section aria-labelledby="order-items-heading">
          <h2 id="order-items-heading" className="bk-checkout__heading">Books ordered</h2>
          <ul className="bk-checkout__lines bk-checkout__lines--table" aria-label="Books in this order">
            {order.items.map((item) => (
              <li key={`${item.bookId}-${item.title}`} data-testid="order-line">
                <span>
                  {item.bookId ? <Link to={`/books/${item.bookId}`}>{item.title}</Link> : item.title}
                  <span className="bk-order-line__meta">
                    {item.quantity} × {formatPrice(item.unitPricePaise)}
                  </span>
                </span>
                <span>{formatPrice(item.lineTotalPaise)}</span>
              </li>
            ))}
          </ul>
        </section>

        <aside className="bk-cart__summary" aria-labelledby="order-summary-heading">
          <h2 id="order-summary-heading">Summary</h2>
          <dl className="bk-summary">
            <div>
              <dt>Subtotal</dt>
              <dd>{formatPrice(order.subtotalPaise)}</dd>
            </div>
            <div className="bk-summary__total">
              <dt>Total</dt>
              <dd data-testid="order-total">{formatPrice(order.totalPaise)}</dd>
            </div>
          </dl>

          <h3 className="bk-checkout__heading">Shipping address</h3>
          <address className="bk-order-address" data-testid="order-address">
            {addr.street}
            <br />
            {addr.city}, {addr.state} {addr.postalCode}
            <br />
            {addr.country}
          </address>

          {canCancel &&
            (confirming ? (
              <div className="bk-summary__confirm" role="group" aria-label="Confirm cancelling this order">
                <p>Cancel this order? The books will go back into stock.</p>
                <div className="bk-summary__buttons">
                  <Button kind="danger" size="md" disabled={cancelling} onClick={handleCancel}>
                    {cancelling ? 'Cancelling…' : 'Yes, cancel order'}
                  </Button>
                  <Button kind="secondary" size="md" disabled={cancelling} onClick={() => setConfirming(false)}>
                    Keep order
                  </Button>
                </div>
              </div>
            ) : (
              <Button kind="danger--tertiary" size="md" onClick={() => setConfirming(true)}>
                Cancel order
              </Button>
            ))}
        </aside>
      </div>
    </>
  );
}
