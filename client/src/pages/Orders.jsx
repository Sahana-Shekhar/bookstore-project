import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Button, InlineNotification, PaginationNav, SkeletonText, Tag } from '@carbon/react';
import { getOrders } from '../services/api.js';
import { ORDER_STATUS_TAG as STATUS_TAG, formatDate, formatPrice } from '../utils/format.js';

const PAGE_SIZE = 10;

export default function Orders() {
  const [page, setPage] = useState(1);
  const [state, setState] = useState({ loading: true, error: false, data: null });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let current = true;
    setState((s) => ({ ...s, loading: true, error: false }));
    getOrders({ page, pageSize: PAGE_SIZE })
      .then((data) => current && setState({ loading: false, error: false, data }))
      .catch(() => current && setState((s) => ({ ...s, loading: false, error: true })));
    return () => {
      current = false;
    };
  }, [page, reloadKey]);

  const { loading, error, data } = state;

  return (
    <>
      <h1>My orders</h1>

      {error && (
        <div className="bk-state">
          <InlineNotification
            kind="error"
            title="Could not load your orders"
            subtitle="Check your connection and try again."
            hideCloseButton
            lowContrast
          />
          <Button kind="tertiary" onClick={() => setReloadKey((k) => k + 1)}>Try again</Button>
        </div>
      )}

      {!error && loading && !data && (
        <div aria-hidden="true">
          <SkeletonText heading width="40%" />
          <SkeletonText paragraph lineCount={3} />
        </div>
      )}

      {!error && data && data.total === 0 && (
        <div className="bk-state bk-state--empty" data-testid="orders-empty">
          <p className="bk-state__title">No orders yet</p>
          <p>When you place an order it will appear here.</p>
          <Button as={Link} to="/books">Browse books</Button>
        </div>
      )}

      {!error && data && data.total > 0 && (
        <>
          <ul className="bk-orders" aria-label="Your orders" aria-busy={loading}>
            {data.items.map((order) => {
              const tag = STATUS_TAG[order.status] ?? { type: 'gray', label: order.status };
              const units = order.items?.reduce((sum, i) => sum + i.quantity, 0) ?? 0;
              return (
                <li key={order.id} className="bk-order-row" data-testid="order-row">
                  <div className="bk-order-row__main">
                    <Link to={`/orders/${order.id}`} className="bk-order-row__number">
                      {order.orderNumber}
                    </Link>
                    <span className="bk-order-row__meta">
                      {formatDate(order.createdAt)} · {units} {units === 1 ? 'item' : 'items'}
                    </span>
                  </div>
                  <Tag type={tag.type} size="md">{tag.label}</Tag>
                  <span className="bk-order-row__total">{formatPrice(order.totalPaise)}</span>
                  <Button as={Link} to={`/orders/${order.id}`} kind="tertiary" size="sm">
                    View details
                  </Button>
                </li>
              );
            })}
          </ul>
          {data.totalPages > 1 && (
            <nav className="bk-pagination" aria-label="Order pages">
              <PaginationNav
                page={Math.min(page, data.totalPages) - 1}
                totalItems={data.totalPages}
                itemsShown={5}
                onChange={(index) => setPage(index + 1)}
              />
            </nav>
          )}
        </>
      )}
    </>
  );
}
