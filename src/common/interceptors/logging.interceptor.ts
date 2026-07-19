import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

/**
 * Per-request HTTP log line.
 *
 * Perf (2026-07-19, log-pipe backpressure): in PM2 cluster mode every line
 * written here travels worker-stdout → 64KB pipe → the SINGLE PM2 God
 * daemon → ~/.pm2/logs → promtail → loki. Under request floods (audits,
 * benchmarks, traffic spikes) that chain saturates: the daemon falls behind
 * draining 6 processes' pipes, the pipe fills, and the worker's stdout
 * write BLOCKS THE EVENT LOOP mid-request — measured as rotating 100ms-3s
 * p95/max spikes on whatever endpoint is in flight (members max=3144ms
 * during back-to-back benchmarks, same endpoint 82ms warm), while promtail/
 * loki burn double-digit CPU% ingesting the very lines that caused it.
 *
 * HTTP_LOG_MODE:
 *   'all'  (default) — legacy behavior: one line per request.
 *   'slow'           — log ONLY non-2xx/3xx responses and requests slower
 *                      than HTTP_LOG_SLOW_MS (default 500ms). Routine fast
 *                      2xx lines are dropped AT THE APP — nginx's access
 *                      log already records every request (method, path,
 *                      status, timing), so no request becomes invisible;
 *                      errors and slow requests keep full app-side context
 *                      (requestId).
 *
 * Set in ecosystem.config.js (web tier: HTTP_LOG_MODE=slow). Flip back to
 * 'all' (or unset) to restore the legacy firehose instantly.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');
  private static readonly MODE = process.env.HTTP_LOG_MODE ?? 'all';
  private static readonly SLOW_MS = parseInt(
    process.env.HTTP_LOG_SLOW_MS ?? '500',
    10,
  );

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const { method, url, requestId } = req;

    return next.handle().pipe(
      tap(() => {
        const res = context.switchToHttp().getResponse();
        const duration = Date.now() - req.startTime;
        if (
          LoggingInterceptor.MODE === 'slow' &&
          res.statusCode < 400 &&
          duration < LoggingInterceptor.SLOW_MS
        ) {
          return; // routine fast success — nginx access log has it
        }
        this.logger.log(
          `${method} ${url} ${res.statusCode} — ${duration}ms [${requestId}]`,
        );
      }),
    );
  }
}
