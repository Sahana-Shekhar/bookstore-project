import { Navigate, Outlet, useLocation } from 'react-router';
import { useAuth } from '../../context/AuthContext.jsx';
import { AuthLoading } from './ProtectedRoute.jsx';

/** Login/Register are for guests only. Logged-in users go back where they were heading, or home. */
export default function GuestRoute() {
  const { isAuthenticated, status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <AuthLoading />;
  if (isAuthenticated) {
    const from = location.state?.from;
    // Only follow in-app, path-only redirects.
    const target = typeof from?.pathname === 'string' && from.pathname.startsWith('/') ? from.pathname : '/';
    return <Navigate to={target} replace />;
  }
  return <Outlet />;
}
