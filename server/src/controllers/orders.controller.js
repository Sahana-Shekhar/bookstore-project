import { createOrderSchema } from '../validators/order.validators.js';
import * as ordersService from '../services/orders.service.js';
import { z } from 'zod';

const objectId = z.string().uuid('Invalid id');

const intQuery = (min, max, fallback) =>
  z
    .string()
    .regex(/^\d{1,6}$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .default(fallback);

const listQuery = z.object({
  page: intQuery(1, 100000, 1),
  pageSize: intQuery(1, 50, 10),
});

const idParam = z.object({ id: objectId });

export async function create(req, res) {
  const input = createOrderSchema.parse(req.body);
  const order = await ordersService.createOrder(req.user.id, input);
  res.status(201).json(order);
}

export async function list(req, res) {
  const query = listQuery.parse(req.query);
  const result = await ordersService.getOrders(req.user.id, query);
  res.json(result);
}

export async function get(req, res) {
  const { id } = idParam.parse(req.params);
  const order = await ordersService.getOrderById(req.user.id, id);
  res.json(order);
}

export async function cancel(req, res) {
  const { id } = idParam.parse(req.params);
  const order = await ordersService.cancelOrder(req.user.id, id);
  res.json(order);
}
