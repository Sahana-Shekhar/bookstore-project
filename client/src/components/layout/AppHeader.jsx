import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router';
import {
  Header,
  HeaderGlobalAction,
  HeaderGlobalBar,
  HeaderMenuButton,
  HeaderMenuItem,
  HeaderName,
  HeaderNavigation,
  HeaderSideNavItems,
  SideNav,
  SideNavItems,
} from '@carbon/react';
import { Asleep, Light, Login, Logout, User, UserFollow } from '@carbon/icons-react';
import { useAuth } from '../../context/AuthContext.jsx';
import { useCart } from '../../context/CartContext.jsx';
import { useColorTheme } from '../../context/ThemeContext.jsx';
import useMediaQuery from '../../hooks/useMediaQuery.js';

// Carbon switches between the hamburger menu and the inline header navigation at its `lg` breakpoint.
const DESKTOP_QUERY = '(min-width: 66rem)';

export default function AppHeader() {
  const { user, status, isAuthenticated, isAdmin, logout } = useAuth();
  const { count } = useCart();
  const { theme, toggleTheme } = useColorTheme();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const [menuOpen, setMenuOpen] = useState(false);

  // The hamburger menu only exists on small screens: close it on navigation and when the screen widens.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname, isDesktop]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);

  const handleLogout = async () => {
    setMenuOpen(false);
    if (await logout()) navigate('/', { replace: true });
  };

  const navItems = (
    <>
      <HeaderMenuItem as={NavLink} to="/" end>Home</HeaderMenuItem>
      <HeaderMenuItem as={NavLink} to="/books">Books</HeaderMenuItem>
      <HeaderMenuItem
        as={NavLink}
        to="/cart"
        aria-label={count > 0 ? `Cart, ${count} ${count === 1 ? 'item' : 'items'}` : undefined}
      >
        Cart
        {count > 0 && (
          <span className="bk-cart-badge" data-testid="cart-count" aria-hidden="true">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </HeaderMenuItem>
      {isAuthenticated && !isAdmin && <HeaderMenuItem as={NavLink} to="/orders">Orders</HeaderMenuItem>}
      {isAdmin && <HeaderMenuItem as={NavLink} to="/admin">Admin</HeaderMenuItem>}
    </>
  );

  return (
    <Header aria-label="Online Bookstore">
      <HeaderMenuButton
        aria-label={menuOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={menuOpen}
        isActive={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      />
      <HeaderName as={Link} to="/" prefix="" className="bk-brand">
        Bookstore
      </HeaderName>
      <HeaderNavigation aria-label="Main">{navItems}</HeaderNavigation>

      {/* Hamburger menu for small screens, where HeaderNavigation is hidden by Carbon. */}
      <SideNav
        aria-label="Main menu"
        expanded={menuOpen && !isDesktop}
        isPersistent={false}
        onOverlayClick={() => setMenuOpen(false)}
        onSideNavBlur={() => setMenuOpen(false)}
      >
        <SideNavItems>
          <HeaderSideNavItems>{navItems}</HeaderSideNavItems>
        </SideNavItems>
      </SideNav>

      <HeaderGlobalBar>
        <HeaderGlobalAction
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          tooltipAlignment="end"
          onClick={toggleTheme}
        >
          {theme === 'dark' ? <Light size={20} /> : <Asleep size={20} />}
        </HeaderGlobalAction>
        {status === 'ready' && isAuthenticated && (
          <>
            <HeaderGlobalAction
              aria-label={`Account: ${user.firstName}`}
              tooltipAlignment="end"
              onClick={() => navigate('/account')}
            >
              <User size={20} />
            </HeaderGlobalAction>
            <HeaderGlobalAction aria-label="Log out" tooltipAlignment="end" onClick={handleLogout}>
              <Logout size={20} />
            </HeaderGlobalAction>
          </>
        )}
        {status !== 'loading' && !isAuthenticated && (
          <>
            <HeaderGlobalAction aria-label="Register" tooltipAlignment="end" onClick={() => navigate('/register')}>
              <UserFollow size={20} />
            </HeaderGlobalAction>
            <HeaderGlobalAction aria-label="Log in" tooltipAlignment="end" onClick={() => navigate('/login')}>
              <Login size={20} />
            </HeaderGlobalAction>
          </>
        )}
      </HeaderGlobalBar>
    </Header>
  );
}
