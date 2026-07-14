import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

interface ErrorResponse {
  message: string;
  errors: Record<string, string | string[]>;
  statusCode: number;
  [extra: string]: unknown;
}

/**
 * Keys owned by the flat contract (or injected by Nest itself) that must
 * never be overwritten by passthrough. `error` is Nest's auto-added class
 * name (e.g. "Locked") — dropping it preserves the pre-existing body shape.
 */
const RESERVED_ERROR_KEYS = new Set(['message', 'errors', 'statusCode', 'error']);

/**
 * Global exception filter — produces FLAT error shape required by Flutter.
 * Flutter reads: data['message'] and data['errors'] at ROOT level.
 *
 * Contract (M-03 fix):
 * { "message": "...", "errors": { "field": "msg" }, "statusCode": 422 }
 *
 * NEVER nest under "error.message" or "error.details"
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let errors: Record<string, string | string[]> = {};
    const extras: Record<string, unknown> = {};

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const resp = exceptionResponse as any;

        // Handle NestJS class-validator validation errors
        if (Array.isArray(resp.message)) {
          message = 'Validation failed';
          // Convert NestJS array of "field message" strings to { field: message } map
          errors = this.parseValidationErrors(resp.message);
        } else {
          message = resp.message ?? message;
          if (resp.errors && typeof resp.errors === 'object') {
            errors = resp.errors;
          }
          // SRS FR-TIME-012: additive machine-readable fields (code,
          // windowState, closeTime, serverTime, ...) ride at the root of the
          // flat contract instead of being stripped.
          for (const [key, value] of Object.entries(resp)) {
            if (!RESERVED_ERROR_KEYS.has(key) && value !== undefined) {
              extras[key] = value;
            }
          }
        }
      }
    } else if (GlobalExceptionFilter.isPrismaUniqueViolation(exception)) {
      // Uniqueness audit (UNI rules): a database unique-constraint violation
      // that escaped a service-level pre-check (concurrent request race) must
      // surface as a proper 409 in the flat contract — never a raw 500.
      // Duck-typed on code/meta so this file stays decoupled from @prisma/client.
      status = HttpStatus.CONFLICT;
      message = 'Validation failed';
      errors = GlobalExceptionFilter.uniqueViolationErrors(exception);
      this.logger.warn(
        `Duplicate rejected (unique constraint) on ${request.method} ${request.url}`,
        {
          requestId: request.requestId,
          constraint: (exception as any)?.meta?.target ?? null,
        } as any,
      );
    } else if (exception instanceof Error) {
      message = exception.message;
      this.logger.error(
        `Unhandled exception on ${request.method} ${request.url}`,
        exception.stack,
        { requestId: request.requestId },
      );
    }

    const errorBody: ErrorResponse = { ...extras, message, errors, statusCode: status };

    this.logger.warn(
      `HTTP ${status} on ${request.method} ${request.url}`,
      {
        requestId: request.requestId,
        statusCode: status,
        message,
      } as any,
    );

    response.status(status).json(errorBody);
  }

  /**
   * Prisma P2002 = unique constraint violated. Matched structurally (name +
   * code) so the filter never imports the Prisma runtime.
   */
  private static isPrismaUniqueViolation(exception: unknown): boolean {
    return (
      exception instanceof Error &&
      exception.constructor?.name === 'PrismaClientKnownRequestError' &&
      (exception as any).code === 'P2002'
    );
  }

  /** Field map for the flat contract from the violated constraint's columns. */
  private static uniqueViolationErrors(
    exception: unknown,
  ): Record<string, string> {
    const target = (exception as any)?.meta?.target;
    const fields: string[] = Array.isArray(target)
      ? target.filter((t: unknown) => typeof t === 'string')
      : typeof target === 'string'
        ? [target]
        : [];
    if (fields.length === 0) return { general: 'Already exists' };
    const errors: Record<string, string> = {};
    for (const f of fields) errors[f] = 'Already exists';
    return errors;
  }

  /**
   * Parse NestJS class-validator message array into field → message map.
   * Input:  ["email must be an email", "password must be longer than 8"]
   * Output: { email: "must be an email", password: "must be longer than 8" }
   */
  private parseValidationErrors(messages: string[]): Record<string, string> {
    const errors: Record<string, string> = {};
    for (const msg of messages) {
      const parts = msg.split(' ');
      if (parts.length > 1) {
        const field = parts[0];
        const rest = parts.slice(1).join(' ');
        errors[field] = rest;
      } else {
        errors['general'] = msg;
      }
    }
    return errors;
  }
}
