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
}

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
        }
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      this.logger.error(
        `Unhandled exception on ${request.method} ${request.url}`,
        exception.stack,
        { requestId: request.requestId },
      );
    }

    const errorBody: ErrorResponse = { message, errors, statusCode: status };

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
