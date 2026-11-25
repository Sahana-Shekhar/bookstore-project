import { Link } from 'react-router';

export default function Help() {
  return (
    <div className="bk-prose">
      <h1>Help</h1>
      <h2>Creating an account</h2>
      <p>
        You can browse without an account. To place orders later you will need to <Link to="/register">register</Link>{' '}
        or <Link to="/login">log in</Link>.
      </p>
      <h2>Your cart</h2>
      <p>
        Your <Link to="/cart">cart</Link> is stored in this browser. It stays on this device and is not shared
        with other devices.
      </p>
      <h2>Payments</h2>
      <p>Payment is simulated. No real payment details are requested or stored.</p>
    </div>
  );
}
