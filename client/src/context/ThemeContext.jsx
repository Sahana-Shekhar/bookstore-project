import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { GlobalTheme } from '@carbon/react';

const STORAGE_KEY = 'bookstore_theme'; // holds only "light" or "dark"
const ThemeContext = createContext(null);

function systemTheme() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readInitialTheme() {
  const applied = document.documentElement.dataset.theme; // set by public/theme-init.js
  if (applied === 'light' || applied === 'dark') return applied;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* storage unavailable */
  }
  return systemTheme();
}

function applyTheme(theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.remove('cds--white', 'cds--g100');
  root.classList.add(theme === 'dark' ? 'cds--g100' : 'cds--white');
}

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(readInitialTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* the theme still changes for this visit */
    }
  }, [theme]);

  const value = useMemo(() => ({ theme, toggleTheme }), [theme, toggleTheme]);
  return (
    <ThemeContext.Provider value={value}>
      <GlobalTheme theme={theme === 'dark' ? 'g100' : 'white'}>{children}</GlobalTheme>
    </ThemeContext.Provider>
  );
}

export function useColorTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useColorTheme must be used inside <ThemeProvider>');
  return ctx;
}
