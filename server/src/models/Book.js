import mongoose from 'mongoose';

const bookSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    isbn: { type: String, required: true, unique: true, trim: true },
    description: { type: String },
    // Stored in cents to avoid floating-point rounding errors.
    priceCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    stock: { type: Number, default: 0, min: 0, validate: Number.isInteger },
    coverUrl: { type: String },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'Author', required: true, index: true },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true, index: true },
  },
  { timestamps: true },
);

export const Book = mongoose.model('Book', bookSchema);
