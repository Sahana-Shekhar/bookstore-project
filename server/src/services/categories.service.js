import { prisma } from '../lib/prisma.js';

/** All categories, A-Z, each with the number of books in it. */
export async function listWithCounts() {
  const categories = await prisma.category.findMany({
    orderBy: { name: 'asc' },
    include: {
      _count: {
        select: { books: true },
      },
    },
  });

  return categories.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    bookCount: c._count.books,
  }));
}
