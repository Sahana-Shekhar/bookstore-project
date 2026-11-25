import mongoose from 'mongoose';
import { env } from '../config/env.js';

// Treat query operators ($ne, $gt, ...) inside filter values as plain data, to block NoSQL injection.
mongoose.set('sanitizeFilter', true);

// Expose `id` (string) instead of `_id` / `__v` in JSON responses.
mongoose.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    delete ret._id;
    return ret;
  },
});

export function connectDb() {
  return mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
}

export function disconnectDb() {
  return mongoose.disconnect();
}
