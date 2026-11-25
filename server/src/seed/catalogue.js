// Sample catalogue: public-domain classics with short original descriptions.
// Prices are in paise (1/100 of a rupee), stored in the `priceCents` field: 29900 = Rs 299.00.
// ISBNs are placeholders in the 978-000 range with valid check digits; they are not real ISBNs.
import { prisma } from '../lib/prisma.js';

export const CATEGORIES = [
  { name: 'Fiction', slug: 'fiction' },
  { name: 'Science Fiction', slug: 'science-fiction' },
  { name: 'Mystery', slug: 'mystery' },
  { name: 'Science', slug: 'science' },
  { name: 'History', slug: 'history' },
  { name: 'Philosophy', slug: 'philosophy' },
];

// [title, author, category slug, price in rupees, stock, description]
const BOOKS = [
  ['Pride and Prejudice', 'Jane Austen', 'fiction', 299, 24, 'Elizabeth Bennet and Mr Darcy navigate pride, class and first impressions in Regency England.'],
  ['Great Expectations', 'Charles Dickens', 'fiction', 349, 18, 'The orphan Pip rises from a village forge to London society and learns what his ambition really cost.'],
  ['Jane Eyre', 'Charlotte Brontë', 'fiction', 329, 12, 'A governess with a fierce sense of independence finds love and a dark secret at Thornfield Hall.'],
  ['Moby-Dick', 'Herman Melville', 'fiction', 449, 3, "Captain Ahab's obsessive hunt for the white whale is part adventure, part meditation on fate."],
  ['Frankenstein', 'Mary Shelley', 'science-fiction', 279, 20, 'A young scientist brings a creature to life and must face the consequences of his creation.'],
  ['The Time Machine', 'H. G. Wells', 'science-fiction', 199, 30, 'A Victorian inventor travels to the year 802,701 and finds a future that is not what he hoped.'],
  ['The War of the Worlds', 'H. G. Wells', 'science-fiction', 229, 15, 'Martian machines land in southern England in the original story of an alien invasion.'],
  ['Twenty Thousand Leagues Under the Seas', 'Jules Verne', 'science-fiction', 399, 0, "Professor Aronnax joins Captain Nemo aboard the submarine Nautilus for a voyage beneath the oceans."],
  ['The Adventures of Sherlock Holmes', 'Arthur Conan Doyle', 'mystery', 349, 40, 'Twelve short cases in which Holmes and Watson solve crimes by observation and deduction.'],
  ['The Hound of the Baskervilles', 'Arthur Conan Doyle', 'mystery', 299, 22, 'A legendary spectral hound haunts the Devon moors, and Holmes is called to investigate.'],
  ['The Moonstone', 'Wilkie Collins', 'mystery', 379, 7, 'A cursed Indian diamond disappears from an English country house in an early detective novel.'],
  ['On the Origin of Species', 'Charles Darwin', 'science', 499, 14, "Darwin's landmark argument for evolution by natural selection, grounded in years of observation."],
  ['The Voyage of the Beagle', 'Charles Darwin', 'science', 459, 9, "The naturalist's account of five years at sea, from the Galápagos to South America."],
  ['Relativity: The Special and General Theory', 'Albert Einstein', 'science', 249, 11, 'Einstein explains his theories of relativity for the general reader, without heavy mathematics.'],
  ['The Histories', 'Herodotus', 'history', 549, 8, 'The first great work of history, covering the Greco-Persian Wars and the world around them.'],
  ['History of the Peloponnesian War', 'Thucydides', 'history', 529, 5, 'An Athenian general analyses the long war between Athens and Sparta with unusual rigour.'],
  ['Narrative of the Life of Frederick Douglass', 'Frederick Douglass', 'history', 199, 26, 'Douglass recounts his life in slavery and his escape to freedom in a powerful first-hand account.'],
  ['Meditations', 'Marcus Aurelius', 'philosophy', 249, 35, "The Roman emperor's private notes on duty, discipline and equanimity."],
  ['The Republic', 'Plato', 'philosophy', 399, 10, 'Socrates and his friends ask what justice is and how an ideal city should be governed.'],
  ['The Art of War', 'Sun Tzu', 'philosophy', 179, 28, 'Short, enduring chapters on strategy, preparation and the avoidance of unnecessary conflict.'],
];

function isbn13(index) {
  const body = `978000000${String(index).padStart(3, '0')}`; // 12 digits
  const sum = [...body].reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return body + String((10 - (sum % 10)) % 10);
}

/**
 * Inserts the sample catalogue. Safe to run repeatedly.
 */
export async function seedCatalogue() {
  const categoryBySlug = new Map();
  for (const c of CATEGORIES) {
    const doc = await prisma.category.upsert({
      where: { slug: c.slug },
      update: {},
      create: { name: c.name, slug: c.slug },
    });
    categoryBySlug.set(c.slug, doc);
  }

  const authorByName = new Map();
  const uniqueAuthorNames = new Set(BOOKS.map((b) => b[1]));
  for (const name of uniqueAuthorNames) {
    const doc = await prisma.author.upsert({
      where: { name },
      update: {},
      create: { name },
    });
    authorByName.set(name, doc);
  }

  let inserted = 0;
  const now = new Date();
  for (const [i, [title, authorName, slug, rupees, stock, description]] of BOOKS.entries()) {
    const isbn = isbn13(i + 10);
    const existing = await prisma.book.findUnique({ where: { isbn } });
    if (!existing) {
      await prisma.book.create({
        data: {
          title,
          isbn,
          description,
          stock,
          priceCents: rupees * 100,
          authorId: authorByName.get(authorName).id,
          categoryId: categoryBySlug.get(slug).id,
          createdAt: new Date(now.getTime() - (BOOKS.length - i) * 60_000),
          updatedAt: now,
        },
      });
      inserted += 1;
    }
  }
  return { books: BOOKS.length, inserted };
}
