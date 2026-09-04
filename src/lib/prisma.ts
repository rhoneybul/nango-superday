import { PrismaPg } from '@prisma/adapter-pg';
import { config } from '../config';
import { PrismaClient } from '../generated/prisma/client';

const adapter = new PrismaPg({ connectionString: config.databaseUrl });

export const prisma = new PrismaClient({
  adapter,
  log: config.logLevel === 'debug' ? ['query', 'warn', 'error'] : ['warn', 'error'],
});
