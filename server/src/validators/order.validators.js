import { z } from 'zod';

const objectIdSchema = z.string().uuid('Invalid Book ID');

const addressString = (label) =>
  z
    .string({ required_error: `${label} is required` })
    .trim()
    .min(1, `${label} is required`)
    .max(100, `${label} is too long`);

export const createOrderSchema = z.object({
  items: z
    .array(
      z.object({
        bookId: objectIdSchema,
        quantity: z.number().int().positive('Quantity must be a positive integer'),
      }),
    )
    .min(1, 'Order must contain at least one item'),
  shippingAddress: z.object({
    street: addressString('Street'),
    city: addressString('City'),
    state: addressString('State'),
    postalCode: addressString('Postal code'),
    country: addressString('Country'),
  }),
});
