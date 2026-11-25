import { StructuredListBody, StructuredListCell, StructuredListRow, StructuredListWrapper, Tag } from '@carbon/react';
import { useAuth } from '../context/AuthContext.jsx';

// Read-only profile. It exists so the protected-route flow has a real page to guard.
export default function Account() {
  const { user } = useAuth();
  const rows = [
    ['First name', user.firstName],
    ['Last name', user.lastName],
    ['Email', user.email],
  ];

  return (
    <>
      <h1>My account</h1>
      <div style={{ margin: '1rem 0', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <span>Role:</span>
        <Tag type={user.role === 'ADMIN' ? 'purple' : 'blue'}>{user.role}</Tag>
      </div>
      <StructuredListWrapper isCondensed aria-label="Account details">
        <StructuredListBody>
          {rows.map(([label, value]) => (
            <StructuredListRow key={label}>
              <StructuredListCell noWrap>{label}</StructuredListCell>
              <StructuredListCell>{value}</StructuredListCell>
            </StructuredListRow>
          ))}
        </StructuredListBody>
      </StructuredListWrapper>
    </>
  );
}
