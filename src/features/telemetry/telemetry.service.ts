import { Injectable, Logger } from '@nestjs/common';
import { ReportClientCrashDto } from './dto/report-client-crash.dto';

/**
 * TelemetryService — sinks client-side (Flutter) crash reports into the existing
 * observability pipe. It does NOT write to Postgres (no migration, no schema
 * surface, no DB load): it emits one structured `warn` line per crash, which PM2
 * already ships to promtail → Loki → Grafana. So client crashes become queryable
 * next to server logs with zero new infrastructure.
 *
 * A daily counter in memory bounds how loud a single misbehaving client can be in
 * the logs (a crash-looping app could otherwise spam). Past the cap we count
 * silently and log one periodic summary — the signal is preserved, the noise is
 * not. The counter is per-worker and resets on the date rollover; it is a log-
 * hygiene guard, not a security control (the throttler at the controller is that).
 */
@Injectable()
export class TelemetryService {
  private readonly logger = new Logger('ClientCrash');

  /** Per-worker, per-day log-line budget for crash reports. */
  private static readonly DAILY_LOG_CAP = 500;
  private day = TelemetryService.today();
  private logged = 0;
  private suppressed = 0;

  private static today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private rollIfNewDay(): void {
    const today = TelemetryService.today();
    if (today !== this.day) {
      if (this.suppressed > 0) {
        this.logger.warn(
          `client-crash log summary for ${this.day}: ${this.logged} logged, ${this.suppressed} suppressed (over daily cap)`,
        );
      }
      this.day = today;
      this.logged = 0;
      this.suppressed = 0;
    }
  }

  /**
   * Records one client crash. Returns immediately (fire-and-forget from the
   * controller's perspective) — the app never waits on our logging.
   */
  record(dto: ReportClientCrashDto, meta: { ip?: string; ua?: string }): void {
    this.rollIfNewDay();

    if (this.logged >= TelemetryService.DAILY_LOG_CAP) {
      this.suppressed += 1;
      return;
    }
    this.logged += 1;

    // One-line, structured (JSON payload) so Loki/Grafana can filter by
    // appVersion/platform/route. Stack is bounded by the DTO already; we log it
    // on its own line so the summary line stays greppable.
    const summary = {
      kind: dto.kind ?? 'unknown',
      severity: dto.severity ?? 'error',
      appVersion: dto.appVersion ?? 'unknown',
      platform: dto.platform ?? 'unknown',
      route: dto.route ?? 'unknown',
      occurredAt: dto.occurredAt ?? null,
      ip: meta.ip ?? null,
      error: dto.error,
    };
    this.logger.warn(`client-crash ${JSON.stringify(summary)}`);
    if (dto.stack) {
      this.logger.debug(`client-crash-stack ${dto.stack}`);
    }
  }
}
