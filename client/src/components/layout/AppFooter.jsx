import { Link } from 'react-router';
import { useAuth } from '../../context/AuthContext.jsx';

/** Site footer. Internal links only; nothing here claims contact details that do not exist. */
export default function AppFooter() {
  const { status, isAuthenticated, isAdmin } = useAuth();

  return (
    <footer className="bk-footer">
      <div className="bk-footer__grid">
        <div>
          <p className="bk-footer__brand">Bookstore</p>
          <p className="bk-footer__blurb">
            An online bookstore built as a capstone project. Browse the catalogue, build a cart and place orders.
          </p>
        </div>

        <nav aria-label="Shopping">
          <h2 className="bk-footer__heading">Shopping</h2>
          <ul className="bk-footer__list">
            <li><Link to="/books">Books</Link></li>
            <li><Link to="/cart">Cart</Link></li>
          </ul>
        </nav>

        <nav aria-label="Company and help">
          <h2 className="bk-footer__heading">Company</h2>
          <ul className="bk-footer__list">
            <li><Link to="/about">About Us</Link></li>
            <li><Link to="/contact">Contact</Link></li>
            <li><Link to="/help">Help</Link></li>
          </ul>
        </nav>

        <nav aria-label="Your account">
          <h2 className="bk-footer__heading">Your account</h2>
          <ul className="bk-footer__list">
            {status === 'ready' && isAuthenticated ? (
              <>
                <li><Link to="/account">My account</Link></li>
                {isAdmin && <li><Link to="/admin">Admin</Link></li>}
              </>
            ) : (
              <>
                <li><Link to="/login">Log in</Link></li>
                <li><Link to="/register">Register</Link></li>
              </>
            )}
          </ul>
        </nav>
      </div>
      <div className="bk-footer__bottom">&copy; {new Date().getFullYear()} Bookstore. All rights reserved.</div>
    </footer>
  );
}
