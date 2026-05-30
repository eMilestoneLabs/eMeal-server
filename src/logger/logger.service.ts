import { Injectable, LoggerService } from '@nestjs/common';
import pino from 'pino';

@Injectable()
export class AppLogger implements LoggerService {
  private readonly pino: pino.Logger;

  constructor() {
    this.pino = pino({
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      transport:
        process.env.NODE_ENV !== 'production'
          ? { target: 'pino-pretty', options: { colorize: true, singleLine: false } }
          : undefined,
      formatters: {
        level: (label) => ({ level: label }),
      },
      base: { service: process.env.APP_NAME ?? 'emeal-server' },
    });
  }

  log(message: string, context?: string) {
    this.pino.info({ context }, message);
  }

  error(message: string, trace?: string, context?: string) {
    this.pino.error({ context, trace }, message);
  }

  warn(message: string, context?: string) {
    this.pino.warn({ context }, message);
  }

  debug(message: string, context?: string) {
    this.pino.debug({ context }, message);
  }

  verbose(message: string, context?: string) {
    this.pino.trace({ context }, message);
  }

  // Structured log with extra fields (used for audit/request correlation)
  logStructured(level: 'info' | 'warn' | 'error', data: Record<string, unknown>) {
    this.pino[level](data);
  }
}
