import { IsOptional, Matches } from 'class-validator';

/**
 * Query DTO for GET /dashboard/admin/overview.
 *
 * `date` is the CLIENT's local calendar date (YYYY-MM-DD). The admin dashboard
 * aggregates "today" as seen on the admin's phone — passing it explicitly keeps
 * the aggregate byte-identical with the legacy per-endpoint calls the Flutter
 * app made (each of which sent the phone-local date). Optional: when absent,
 * the server's UTC date is used.
 */
export class QueryOverviewDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}
