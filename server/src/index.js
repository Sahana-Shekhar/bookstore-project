import app from './app.js';
import { env } from './config/env.js';
import { prisma } from './lib/prisma.js';

try {
  await prisma.$connect();
} catch (err) {
  console.error(JSON.stringify({ level: 'error', msg: 'Database connection failed', error: err.name }));
  process.exit(1);
}

const server = app.listen(env.PORT, env.HOST, () => {
  console.info(JSON.stringify({ level: 'info', msg: 'Server started', host: env.HOST, port: env.PORT }));
});

function shutdown() {
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
