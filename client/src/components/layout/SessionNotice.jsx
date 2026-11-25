import { InlineNotification } from '@carbon/react';
import { useAuth } from '../../context/AuthContext.jsx';

/** App-wide banner for session events (expired session, failed logout). */
export default function SessionNotice() {
  const { notice, dismissNotice } = useAuth();
  if (!notice) return null;

  return (
    <InlineNotification
      kind={notice.kind}
      title={notice.kind === 'error' ? 'Error' : 'Notice'}
      subtitle={notice.message}
      onCloseButtonClick={dismissNotice}
      lowContrast
      style={{ maxWidth: '100%' }}
    />
  );
}
