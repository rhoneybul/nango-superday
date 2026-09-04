import { createApp } from './app';
import { config } from './config';
import { prisma } from './lib/prisma';

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`[nango-events] listening on :${config.port} (${config.env})`);
});

async function shutdown(signal: string) {
  console.log(`[nango-events] ${signal} received, shutting down`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
