import pino from 'pino';
import { config } from '../config';
import { currentRequestId } from '../middleware/request-id';

/**
 * JSON logger (pino). Every line automatically carries the current request id.
 *
 *   log.info({ method: 'GET', status: 200 }, 'request')
 *   → {"level":"info","time":"…","requestId":"…","method":"GET","status":200,"msg":"request"}
 */
export const log = pino(
  {
    level: config.logLevel,
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin: () => ({ requestId: currentRequestId() }),
  },
  // Write through process.stdout (rather than pino's direct fd writer) so output can be captured in tests.
  process.stdout,
);
