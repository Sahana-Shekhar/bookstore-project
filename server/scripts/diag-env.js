// Diagnostic: checks that DATABASE_URL is present and well-formed WITHOUT revealing any credential-related detail.
// Run:  node --env-file=.env scripts/diag-env.js
// Prints only: scheme, host, port, database name and non-sensitive query keys. Never prints the user, password,
// password length, or the full URL. For a full connectivity check use scripts/verify-postgres-connection.js.
try {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log('DATABASE_URL is not set in process.env!');
  } else {
    const parsed = new URL(dbUrl);
    console.log('--- Active Process Env DATABASE_URL (credentials hidden) ---');
    console.log('Protocol:', parsed.protocol);
    console.log('Host:', parsed.hostname);
    console.log('Port:', parsed.port || '5432');
    console.log('Database:', parsed.pathname.replace(/^\//, ''));
    console.log('Query keys:', [...parsed.searchParams.keys()].join(', ') || '(none)');
  }
} catch {
  // Never echo the parser message: it can include part of the URL.
  console.error('Diagnostic error: DATABASE_URL is not a valid URL.');
  process.exitCode = 1;
}
