import { Button, Form, InlineNotification, Stack } from '@carbon/react';
import useForm from '../../hooks/useForm.js';
import FormField from './FormField.jsx';

/**
 * Config-driven form.
 * fields: [{ name, label, type?, autoComplete?, placeholder?, maxLength?, validate?: [fn] }]
 */
export default function FormBuilder({ fields, submitLabel, onSubmit, footer }) {
  const initialValues = Object.fromEntries(fields.map((f) => [f.name, '']));
  const { values, visibleError, handleChange, handleBlur, handleSubmit, submitting, submitError } =
    useForm({ fields, initialValues, onSubmit });

  return (
    <Form onSubmit={handleSubmit} noValidate aria-label={submitLabel}>
      <Stack gap={6}>
        {fields.map((field) => (
          <FormField
            key={field.name}
            field={field}
            value={values[field.name]}
            error={visibleError(field.name)}
            onChange={handleChange(field.name)}
            onBlur={handleBlur(field.name)}
          />
        ))}

        {submitError && (
          <InlineNotification
            kind="error"
            title="Error"
            subtitle={submitError}
            hideCloseButton
            lowContrast
          />
        )}

        <Button type="submit" disabled={submitting}>
          {submitting ? 'Please wait…' : submitLabel}
        </Button>

        {footer}
      </Stack>
    </Form>
  );
}
