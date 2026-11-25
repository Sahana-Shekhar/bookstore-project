import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentUser, loginUser, logoutUser, setCsrfToken, setUnauthorizedHandler } from '../services/api.js';

const AuthContext = createContext(null);

// status: 'loading' (restoring session) | 'ready' | 'error' (could not reach server while restoring)
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('loading');
  const [notice, setNotice] = useState(null); // { kind: 'warning'|'error'|'info', message }
  const userRef = useRef(null);
  userRef.current = user;

  const restore = useCallback(async () => {
    try {
      setUser(await getCurrentUser());
      setStatus('ready');
    } catch {
      setUser(null);
      setStatus('error');
    }
  }, []);

  // Restore the session after a page refresh. The JWT is in an httpOnly cookie the browser sends
  // automatically; /auth/me tells us who it belongs to.
  useEffect(() => {
    restore();
  }, [restore]);

  const expireSession = useCallback(() => {
    if (!userRef.current) return;
    setCsrfToken(null);
    setUser(null);
    setNotice({ kind: 'warning', message: 'Your session has expired. Please log in again.' });
  }, []);

  // Any API call that comes back 401 while we think we are logged in means the session ended.
  useEffect(() => {
    setUnauthorizedHandler(expireSession);
    return () => setUnauthorizedHandler(null);
  }, [expireSession]);

  // Re-validate when the user returns to the tab, so an expired or revoked session is noticed
  // (and a login/logout in another tab is picked up) instead of showing stale "logged in" UI.
  useEffect(() => {
    const revalidate = async () => {
      if (document.visibilityState !== 'visible' || !userRef.current) return;
      try {
        const current = await getCurrentUser();
        if (!current) expireSession();
        else setUser(current);
      } catch {
        // Temporary network problem: keep the current state.
      }
    };
    document.addEventListener('visibilitychange', revalidate);
    window.addEventListener('focus', revalidate);
    return () => {
      document.removeEventListener('visibilitychange', revalidate);
      window.removeEventListener('focus', revalidate);
    };
  }, [expireSession]);

  const login = useCallback(async (credentials) => {
    const loggedIn = await loginUser(credentials);
    setNotice(null);
    setUser(loggedIn);
    return loggedIn;
  }, []);

  const logout = useCallback(async () => {
    try {
      await logoutUser();
      setNotice(null);
    } catch {
      setNotice({ kind: 'error', message: 'Could not log out. Please try again.' });
      return false;
    }
    setUser(null);
    return true;
  }, []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  const value = useMemo(
    () => ({
      user,
      status,
      isAuthenticated: Boolean(user),
      isAdmin: user?.role === 'ADMIN',
      notice,
      login,
      logout,
      retry: restore,
      dismissNotice,
    }),
    [user, status, notice, login, logout, restore, dismissNotice],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
