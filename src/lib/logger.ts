import pino from 'pino';
import { loadEnv } from '../types/env.ts';

const env = process.env.NODE_ENV === 'test' ? null : tryLoadEnv();

function tryLoadEnv() {
  try {
    return loadEnv();
  } catch {
    return null;
  }
}

export const logger = pino({
  level: env?.LOG_LEVEL ?? process.env.LOG_LEVEL ?? 'info',
  base: { service: 'mcp-knowledge2' },
  // Never log credentials, body content, search queries, or PII
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-service-token"]',
      'req.headers.cookie',
      '*.password',
      '*.token',
      '*.secret',
      '*.body',
      'query',
      'embedding',
      'dek',
    ],
    censor: '[redacted]',
  },
  timestamp: pino.stdTimeFunctions.epochTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
});

export type Logger = typeof logger;
