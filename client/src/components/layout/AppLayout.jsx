import { SkipToContent } from '@carbon/react';
import AppHeader from './AppHeader.jsx';
import AppFooter from './AppFooter.jsx';
import SessionNotice from './SessionNotice.jsx';

/** App shell: skip link, header, main content area with a consistent width, and a footer that sticks to the bottom. */
export default function AppLayout({ children }) {
  return (
    <div className="bk-app">
      <SkipToContent href="#main-content" />
      <AppHeader />
      <main id="main-content" className="bk-main" tabIndex={-1}>
        <div className="bk-container">
          <SessionNotice />
          {children}
        </div>
      </main>
      <AppFooter />
    </div>
  );
}
