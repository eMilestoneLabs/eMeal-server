import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { TelemetryService } from './telemetry.service';
import { ReportClientCrashDto } from './dto/report-client-crash.dto';

/**
 * TelemetryController — receives client-side (Flutter) crash reports.
 *
 *   POST /api/v1/telemetry/client-crashes   — public, tightly throttled
 *
 * Why @Public: a crash can happen on the splash/login screen before any token
 * exists, so requiring auth would drop exactly the reports we most want. The
 * route is otherwise fully hardened:
 *   • @Throttle 30/min per IP — far below normal, so a crash-looping or hostile
 *     client cannot use it as a write-amplification / log-flood vector. It sits
 *     UNDER the global 1000/min so it can only ever be stricter, never looser.
 *   • Bounded, whitelisted DTO (ReportClientCrashDto) → 422 on anything oversized
 *     or unexpected, identical to every other write route (SEC-E).
 *   • No DB write, no auth context read, no side effects beyond a structured log
 *     line — nothing to exploit even if flooded past the throttle.
 *
 * Returns 204 (accepted, no body): the app fire-and-forgets and never blocks a
 * user on telemetry.
 */
@Controller('telemetry')
export class TelemetryController {
  constructor(private readonly telemetry: TelemetryService) {}

  @Public()
  @Post('client-crashes')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  reportClientCrash(
    @Body() dto: ReportClientCrashDto,
    @Req() req: Request,
  ): void {
    this.telemetry.record(dto, {
      ip: req.ip,
      ua: req.headers['user-agent'],
    });
  }
}
