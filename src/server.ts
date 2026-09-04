import { app } from './app';
import { config } from './config';
import { log } from './lib/logger';
import { prisma } from './lib/prisma';

const server = app.listen(config.port, () => {
  log.info({ port: config.port, env: config.env }, 'listening');
});

function shutdown(signal: string) {
  log.info({ signal }, 'shutting down');
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
