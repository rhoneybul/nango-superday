import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      RABBITMQ_URL: 'amqp://test:test@localhost:5672',
      EVENTS_DEFAULT_LIMIT: '50',
      EVENTS_MAX_LIMIT: '500',
      EVENTS_MAX_BUCKETS: '10000',
      INGEST_BATCH_RATE_LIMIT_PER_MINUTE: '10',
      LOG_LEVEL: 'silent',
    },
  },
});
