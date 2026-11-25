import { Link } from 'react-router';
import { Button } from '@carbon/react';

export default function Home() {
  return (
    <section className="bk-hero" aria-labelledby="home-title">
      <h1 id="home-title">Welcome to the Bookstore</h1>
      <p>Discover your next read. Browse our collection of books, from timeless classics to new releases.</p>
      <Button as={Link} to="/books">Browse books</Button>
    </section>
  );
}
