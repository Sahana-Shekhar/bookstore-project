import { Link } from 'react-router';
import { Button } from '@carbon/react';

export default function NotFound() {
  return (
    <>
      <h1>Page not found</h1>
      <p style={{ marginBlockEnd: '1.5rem' }}>The page you are looking for does not exist or has moved.</p>
      <Button as={Link} to="/" kind="tertiary">Back to home</Button>
    </>
  );
}
