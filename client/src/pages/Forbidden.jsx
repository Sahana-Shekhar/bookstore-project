import { Link } from 'react-router';
import { Button, InlineNotification, Stack } from '@carbon/react';

export default function Forbidden() {
  return (
    <Stack gap={5}>
      <h1>Access denied</h1>
      <InlineNotification
        kind="error"
        title="Not allowed"
        subtitle="You do not have permission to view this page."
        hideCloseButton
        lowContrast
      />
      <div>
        <Button as={Link} to="/" kind="tertiary">Back to home</Button>
      </div>
    </Stack>
  );
}
