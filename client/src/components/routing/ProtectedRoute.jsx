import { Navigate, Outlet, useLocation } from 'react-router';
import { Button, InlineNotification, Loading, Stack } from '@carbon/react';
import { useAuth } from '../../context/AuthContext.jsx';
import Forbidden from '../../pages/Forbidden.jsx';

/** Shown while the session is being restored, so the UI never flashes "logged out" on refresh. */
export function AuthLoading() {
  return <Loading description="Checking your session" withOverlay={false} />;
}

/** Shown when the session could not be checked because the server is unreachable. */
function AuthUnavailable() {
  const { retry } = useAuth();
  return (
    <Stack gap={5}>
      <InlineNotification
        kind="error"
        title="Cannot reach the server"
        subtitle="We could not check your session. Please try again."
        hideCloseButton
        lowContrast
      />
      <div>
        <Button onClick={retry}>Retry</Button>
      </div>
    </Stack>
  );
}

/**
 * Route guard. Use as a layout route:
 *   <Route element={<ProtectedRoute />}> ... </Route>
 *   <Route element={<ProtectedRoute roles={['ADMIN']} />}> ... </Route>
 * Authorization is also enforced by the API; this only controls what the UI shows.
 */
export default function ProtectedRoute({ roles }) {
  const { user, status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <AuthLoading />;
  if (status === 'error') return <AuthUnavailable />;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  if (roles && !roles.includes(user.role)) return <Forbidden />;
  return <Outlet />;
}
