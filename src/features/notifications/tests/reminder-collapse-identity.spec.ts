/**
 * reminder-collapse-identity.spec.ts — Live-Test-16 ISSUE-2.
 *
 * The withdrawn 1-hour minimum gap was silently protecting the push collapse
 * key. `NotificationSendService.collapseTag` derives the Android
 * `collapseKey`/`tag` and the iOS `apns-collapse-id` from
 *   (dedupeId ?? tag) ?? `type:(noticeId ?? date ?? groupId ?? route)`  +  title
 * and the attendance-reminder payload carried NONE of those while its title is
 * the constant 'Attendance Reminder' — so every meal produced the SAME key.
 *
 * With the gap rule in force reminders were always far apart, so a replace was
 * harmless. Now that CONCURRENT windows are allowed, several meals remind at
 * the same instant and the OS would REPLACE rather than stack — the member
 * would see only ONE reminder and silently lose the rest.
 *
 * These tests call the REAL `collapseTag` (via bracket access on the private
 * method) against the REAL payloads — no re-implementation of the rule here, or
 * the test would pass even with the production fix reverted.
 */
import { ConfigService } from '@nestjs/config';
import { NotificationPayloadService } from '../services/notification-payload.service';
import { NotificationSendService } from '../services/notification-send.service';
import type { NotificationPayload } from '../services/notification-payload.service';

describe('attendance-reminder collapse identity (Live-Test-16 ISSUE-2)', () => {
  const payloads = new NotificationPayloadService();
  // ConfigService is only read in onModuleInit (never called here); collapseTag
  // is pure, so a bare instance is enough and no FCM credentials are touched.
  const sender = new NotificationSendService(new ConfigService());
  const tagOf = (p: NotificationPayload): string =>
    (sender as unknown as { collapseTag(p: NotificationPayload): string })
      .collapseTag(p);

  const reminder = (mealSlotKey: string, minutesRemaining = 60) =>
    payloads.buildAttendanceReminderPayload({
      mealSlotKey,
      minutesRemaining,
      defaultPresent: false,
    });

  it('POSITIVE: CONCURRENT meals get DISTINCT collapse keys', () => {
    // The exact scenario the withdrawal enables: every meal open 07:00–09:00.
    const tags = ['breakfast', 'lunch', 'dinner'].map((s) => tagOf(reminder(s)));
    expect(new Set(tags).size).toBe(3);
  });

  it('NEGATIVE: a RE-DELIVERY of the same meal still collapses (dedupe intact)', () => {
    // The original PRIORITY-1 duplicate-notification guarantee must survive.
    expect(tagOf(reminder('breakfast'))).toBe(tagOf(reminder('breakfast')));
  });

  it('CORNER: free-form slot keys (not an enum) stay distinct', () => {
    // slotKey is admin-defined free text, not a fixed enum (MMT-002).
    expect(tagOf(reminder('evening-tea'))).not.toBe(tagOf(reminder('evening')));
  });

  it('CORNER: the collapse key ignores minutesRemaining', () => {
    // The 60-min and 15-min reminders for the SAME meal are the same logical
    // event — they must still replace one another, not stack.
    expect(tagOf(reminder('breakfast', 60))).toBe(
      tagOf(reminder('breakfast', 15)),
    );
  });

  it('the forwarded dedupeId contract is unchanged (client/OS parity)', () => {
    // The fix feeds the collapse INPUT only. `data.dedupeId` is still assigned
    // by NotificationSendService (the hash), never by the payload builder — so
    // push_notification_service.dart keeps rendering with the same identity.
    const p = reminder('breakfast');
    expect(p.data).toBeDefined();
    expect(p.data!.dedupeId).toBeUndefined();
    expect(p.data!.tag).toBe('attendance_reminder:breakfast');
  });

  it('other notification types are untouched by this change', () => {
    // Blast-radius guard: only the reminder payload gained a collapse input.
    const confirm = payloads.buildAttendanceConfirmPayload({
      mealSlotKey: 'breakfast',
      status: 'present',
    });
    expect(confirm.data?.tag).toBeUndefined();
  });
});
