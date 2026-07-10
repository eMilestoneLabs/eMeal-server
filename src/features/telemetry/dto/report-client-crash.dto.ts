import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  IsIn,
  MaxLength,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * ReportClientCrashDto — a single Flutter-side uncaught error, posted by the app
 * to `POST /api/v1/telemetry/client-crashes` (public, unauthenticated so a crash
 * during login/splash still reports).
 *
 * Every field is bounded (MaxLength / Min-Max) and the global ValidationPipe runs
 * `whitelist + forbidNonWhitelisted`, so an oversized or mass-assignment payload
 * is rejected with 422 before it ever reaches the service — the same hardening
 * the SEC-E probes already verify on every other write route. No PII is expected;
 * the app sends only a redacted error/stack + coarse device/app context.
 */
export class ReportClientCrashDto {
  /** Redacted error string (app truncates; server double-bounds). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  error: string;

  /** Redacted stack trace (optional; bounded to keep log lines sane). */
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  stack?: string;

  /**
   * Source of the error:
   *   'flutter'  — framework build/layout/paint (FlutterError.onError)
   *   'platform' — uncaught async error (PlatformDispatcher.onError)
   *   'zone' / 'isolate' — reserved for future capture surfaces
   *   'manual'   — app called recordError() for a caught error worth tracking
   * Must stay in sync with CrashReporterService's emitted `kind` values, or the
   * client report would 422 and be retried forever from its offline buffer.
   */
  @IsOptional()
  @IsString()
  @IsIn(['flutter', 'zone', 'platform', 'isolate', 'manual', 'unknown'])
  kind?: string;

  /** Was the error flagged fatal by the app. */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  severity?: string;

  /** App semantic version, e.g. "1.0.0+1". */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  appVersion?: string;

  /** Coarse platform label, e.g. "android 13 / SM-G990". */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  platform?: string;

  /** Route/screen the user was on, e.g. "/admin/attendance". */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  route?: string;

  /** Client-side epoch millis of the crash (server also stamps its own time). */
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  @Min(0)
  @Max(4102444800000) // year 2100 ceiling — rejects absurd values
  occurredAt?: number;
}
