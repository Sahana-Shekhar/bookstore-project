import { Tag } from '@carbon/react';
import { stockStatus } from '../../utils/format.js';

/** Colour-coded stock label. The text always says the state, so colour is never the only signal. */
export default function StockTag({ stock, size = 'sm' }) {
  const status = stockStatus(stock);
  return (
    <Tag type={status.tag} size={size} className="bk-stock-tag">
      {status.label}
    </Tag>
  );
}
