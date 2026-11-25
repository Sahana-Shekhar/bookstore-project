import { PasswordInput, TextInput } from '@carbon/react';

/** Renders the right Carbon input for a field config. */
export default function FormField({ field, value, error, onChange, onBlur }) {
  const Input = field.type === 'password' ? PasswordInput : TextInput;

  return (
    <Input
      id={field.name}
      name={field.name}
      type={field.type === 'password' ? undefined : field.type ?? 'text'}
      labelText={field.label}
      placeholder={field.placeholder}
      autoComplete={field.autoComplete}
      maxLength={field.maxLength}
      value={value}
      onChange={onChange}
      onBlur={onBlur}
      invalid={Boolean(error)}
      invalidText={error}
    />
  );
}
