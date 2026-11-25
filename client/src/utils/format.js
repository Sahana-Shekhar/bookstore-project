const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });

/** Prices are stored as integer paise in `priceCents`; this is the only place they become rupees. */
export const formatPrice = (cents) => inr.format(cents / 100);

export const LOW_STOCK_THRESHOLD = 5;

/** kind: 'out' | 'low' | 'in'. `tag` is the Carbon Tag colour. */
export function stockStatus(stock) {
  if (stock <= 0) return { kind: 'out', label: 'Out of stock', tag: 'red' };
  if (stock <= LOW_STOCK_THRESHOLD) return { kind: 'low', label: `Only ${stock} left`, tag: 'magenta' };
  return { kind: 'in', label: 'In stock', tag: 'green' };
}

/** Carbon Tag colour and label for each order status returned by the API. */
export const ORDER_STATUS_TAG = {
  PLACED: { type: 'blue', label: 'Placed' },
  PROCESSING: { type: 'cyan', label: 'Processing' },
  SHIPPED: { type: 'purple', label: 'Shipped' },
  DELIVERED: { type: 'green', label: 'Delivered' },
  CANCELLED: { type: 'gray', label: 'Cancelled' },
};

export const formatDate = (value) =>
  new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
