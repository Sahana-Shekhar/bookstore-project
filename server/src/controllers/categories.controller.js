import * as categoriesService from '../services/categories.service.js';

export async function listCategories(_req, res) {
  res.json({ items: await categoriesService.listWithCounts() });
}
