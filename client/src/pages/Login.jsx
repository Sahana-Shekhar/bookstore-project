import { Link, useLocation, useNavigate } from 'react-router';
import { InlineNotification } from '@carbon/react';
import FormBuilder from '../components/form/FormBuilder.jsx';
import FormPage from '../components/layout/FormPage.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { email, required } from '../utils/validators.js';

// No length/strength rules on login: the server decides, and the error is deliberately generic.
const fields = [
  {
    name: 'email',
    label: 'Email',
    type: 'email',
    autoComplete: 'username',
    maxLength: 254,
    validate: [required('Email'), email()],
  },
  {
    name: 'password',
    label: 'Password',
    type: 'password',
    autoComplete: 'current-password',
    maxLength: 128,
    validate: [required('Password')],
  },
];

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const justRegistered = location.state?.registered;
  const from = location.state?.from?.pathname;

  const handleSubmit = async ({ email, password }) => {
    await login({ email, password });
    navigate(from?.startsWith('/') ? from : '/', { replace: true });
  };

  return (
    <FormPage title="Log in">
      {justRegistered && (
        <InlineNotification
          kind="success"
          title="Account created"
          subtitle="You can now log in."
          hideCloseButton
          lowContrast
        />
      )}
      <FormBuilder
        fields={fields}
        submitLabel="Log in"
        onSubmit={handleSubmit}
        footer={
          <p>
            New here? <Link to="/register">Create an account</Link>
          </p>
        }
      />
    </FormPage>
  );
}
