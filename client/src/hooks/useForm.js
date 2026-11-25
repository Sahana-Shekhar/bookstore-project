import { useMemo, useState } from 'react';
import { runValidators } from '../utils/validators.js';

/**
 * Generic form state + validation.
 * fields: [{ name, validate?: [fn] }]
 * Errors are derived from current values, and only shown for fields
 * that were touched (blurred) or after a submit attempt.
 */
export default function useForm({ fields, initialValues, onSubmit }) {
  const [values, setValues] = useState(initialValues);
  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const errors = useMemo(() => {
    const result = {};
    for (const field of fields) {
      const error = runValidators(field.validate, values[field.name], values);
      if (error) result[field.name] = error;
    }
    return result;
  }, [fields, values]);

  const visibleError = (name) => (touched[name] || submitted ? errors[name] : undefined);

  const handleChange = (name) => (event) => {
    setValues((prev) => ({ ...prev, [name]: event.target.value }));
  };

  const handleBlur = (name) => () => {
    setTouched((prev) => ({ ...prev, [name]: true }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSubmitted(true);
    setSubmitError('');
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    try {
      await onSubmit(values);
    } catch (err) {
      setSubmitError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return { values, visibleError, handleChange, handleBlur, handleSubmit, submitting, submitError };
}
