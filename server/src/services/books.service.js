import { prisma } from '../lib/prisma.js';

const SORTS = {
  newest: [{ createdAt: 'desc' }, { id: 'desc' }],
  'title-asc': [{ title: 'asc' }, { id: 'asc' }],
  'title-desc': [{ title: 'desc' }, { id: 'desc' }],
  'price-asc': [{ priceCents: 'asc' }, { title: 'asc' }, { id: 'asc' }],
  'price-desc': [{ priceCents: 'desc' }, { title: 'asc' }, { id: 'asc' }],
};

export const SORT_OPTIONS = Object.keys(SORTS);

export async function list({ page, pageSize, categoryId, q, sort }) {
  const where = {};
  if (categoryId) {
    where.categoryId = categoryId;
  }
  if (q) {
    where.OR = [
      { title: { contains: q, mode: 'insensitive' } },
      { author: { name: { contains: q, mode: 'insensitive' } } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.book.findMany({
      where,
      include: {
        author: true,
        category: true,
      },
      orderBy: SORTS[sort] || SORTS.newest,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.book.count({ where }),
  ]);

  const totalPages = Math.ceil(total / pageSize);
  return {
    items,
    total,
    page,
    pageSize,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1 && totalPages > 0,
  };
}

export function getById(id) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const where = isUuid ? { id } : { mongodbId: id };

  return prisma.book.findUnique({
    where,
    include: {
      author: true,
      category: true,
    },
  });
}
