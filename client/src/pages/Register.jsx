import { Link, useNavigate } from 'react-router';
import FormBuilder from '../components/form/FormBuilder.jsx';
import FormPage from '../components/layout/FormPage.jsx';
import { registerUser } from '../services/api.js';
import { email, matches, maxBytes, maxLength, minLength, required } from '../utils/validators.js';

const fields = [
  {
    name: 'firstName',
    label: 'First name',
    autoComplete: 'given-name',
    maxLength: 50,
    validate: [required('First name'), maxLength(50)],
  },
  {
    name: 'lastName',
    label: 'Last name',
    autoComplete: 'family-name',
    maxLength: 50,
    validate: [required('Last name'), maxLength(50)],
  },
  {
    name: 'email',
    label: 'Email',
    type: 'email',
    autoComplete: 'email',
    maxLength: 254,
    validate: [required('Email'), email()],
  },
  {
    name: 'password',
    label: 'Password',
    type: 'password',
    autoComplete: 'new-password',
    maxLength: 72,
    validate: [required('Password'), minLength(8), maxBytes(72)],
  },
  {
    name: 'confirmPassword',
    label: 'Confirm password',
    type: 'password',
    autoComplete: 'new-password',
    maxLength: 72,
    validate: [required('Confirm password'), matches('password', 'Passwords do not match')],
  },
];

export default function Register() {
  const navigate = useNavigate();

  // confirmPassword is only for client-side validation and is never sent.
  // The server always creates a CUSTOMER account; no role is sent.
  const handleSubmit = async ({ firstName, lastName, email, password }) => {
    await registerUser({ firstName, lastName, email, password });
    navigate('/login', { replace: true, state: { registered: true } });
  };

  return (
    <FormPage title="Create an account">
      <FormBuilder
        fields={fields}
        submitLabel="Register"
        onSubmit={handleSubmit}
        footer={
          <p>
            Already have an account? <Link to="/login">Log in</Link>
          </p>
        }
      />
    </FormPage>
  );
}
