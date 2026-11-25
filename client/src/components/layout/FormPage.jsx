import { Stack } from '@carbon/react';

/** Centred, width-limited layout for Login/Register: full width on phones, a comfortable column on larger screens. */
export default function FormPage({ title, children }) {
  return (
    <div className="bk-form-page">
      <Stack gap={6}>
        <h1>{title}</h1>
        {children}
      </Stack>
    </div>
  );
}
