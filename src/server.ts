import { app } from './app';
import { config } from './config';
import { log } from './lib/logger';
import { prisma } from './lib/prisma';
import { redis } from './lib/redis';
import { startPublisher } from './queue/publisher';

// Connects in the background (retried until the broker is up); POST /ingest fails until then.
startPublisher().catch((err) => log.error({ err }, 'publisher failed to start'));

const server = app.listen(config.port, () => {
  log.info({ port: config.port, env: config.env }, 'listening');
});

function shutdown(signal: string) {
  log.info({ signal }, 'shutting down');
  server.close(async () => {
    await Promise.all([prisma.$disconnect(), redis?.quit()]);
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
