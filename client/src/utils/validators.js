// Each validator receives (value, allValues) and returns an error message or undefined.

export const required = (label) => (value) =>
  value.trim() ? undefined : `${label} is required`;

export const email = () => (value) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? undefined : 'Enter a valid email address';

export const minLength = (min) => (value) =>
  value.length >= min ? undefined : `Must be at least ${min} characters`;

export const maxLength = (max) => (value) =>
  value.length <= max ? undefined : `Must be at most ${max} characters`;

// bcrypt (used by the server) only reads the first 72 BYTES, so the server rejects longer passwords.
export const maxBytes = (max) => (value) =>
  new TextEncoder().encode(value).length <= max ? undefined : `Must be at most ${max} bytes`;

export const matches = (otherName, message) => (value, values) =>
  value === values[otherName] ? undefined : message;

// Runs validators in order and returns the first error.
export const runValidators = (validators = [], value, values) => {
  for (const validate of validators) {
    const error = validate(value, values);
    if (error) return error;
  }
  return undefined;
};
