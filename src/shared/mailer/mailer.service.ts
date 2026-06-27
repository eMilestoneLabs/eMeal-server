import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

/**
 * MailerService — transactional email (OTP, password reset, verification, welcome).
 *
 * Design (see docs/NOTIFICATION_OTP_PLAN.md §1.3): AUTH identity is separate from
 * the FROM identity so an alias → dedicated-mailbox migration is ENV-ONLY:
 *   • SMTP_USER  = the real mailbox you authenticate as (admin@ now, no-reply@ later)
 *   • MAIL_FROM  = the header From users see (no-reply@…) — unchanged on migration
 * The SMTP envelope/Return-Path is set to SMTP_USER (the authenticated mailbox) so
 * sending "as" an alias stays deliverable.
 *
 * Delivery is BEST-EFFORT: send() never throws — the OTP is already stored, so an
 * email failure must not break the auth flow (it is logged for ops to see).
 *
 * Env (all optional; if SMTP_HOST/USER/PASS are absent, email is simply disabled):
 *   SMTP_HOST · SMTP_PORT(465) · SMTP_SECURE(true) · SMTP_USER · SMTP_PASS
 *   MAIL_FROM · MAIL_REPLY_TO
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private transporter: nodemailer.Transporter | null = null;
  private warnedDisabled = false;

  private readonly authUser: string;
  private readonly from: string;
  private readonly replyTo?: string;

  constructor(private readonly config: ConfigService) {
    this.authUser = this.config.get<string>('SMTP_USER', '') ?? '';
    this.from = this.config.get<string>('MAIL_FROM') || this.authUser;
    this.replyTo = this.config.get<string>('MAIL_REPLY_TO') || undefined;
  }

  private getTransport(): nodemailer.Transporter | null {
    if (this.transporter) return this.transporter;
    const host = this.config.get<string>('SMTP_HOST');
    const pass = this.config.get<string>('SMTP_PASS');
    if (!host || !this.authUser || !pass) {
      if (!this.warnedDisabled) {
        this.logger.warn('SMTP not configured (SMTP_HOST/USER/PASS) — transactional email disabled');
        this.warnedDisabled = true;
      }
      return null;
    }
    const port = parseInt(this.config.get<string>('SMTP_PORT', '465') ?? '465', 10);
    const secure = (this.config.get<string>('SMTP_SECURE', 'true') ?? 'true') !== 'false';
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure, // true for 465 (implicit TLS), false for 587 (STARTTLS)
      auth: { user: this.authUser, pass },
    });
    return this.transporter;
  }

  /**
   * Best-effort send. Returns true on success, false on disabled/failure. Never throws.
   */
  async send(to: string, subject: string, text: string, html?: string): Promise<boolean> {
    const t = this.getTransport();
    if (!t) return false;
    try {
      await t.sendMail({
        from: this.from,                          // header From (e.g. no-reply@) — shown to users
        sender: this.authUser,                    // authenticated mailbox
        envelope: { from: this.authUser, to },    // Return-Path = authenticated mailbox (alias-safe)
        replyTo: this.replyTo,
        to,
        subject,
        text,
        html: html ?? text,
      });
      return true;
    } catch (err) {
      this.logger.error(
        `email send failed to=${to} subject="${subject}": ${(err as Error).message}`,
      );
      return false;
    }
  }

  /** OTP / verification / password-reset code email. */
  async sendOtp(to: string, code: string, purpose = 'verification'): Promise<boolean> {
    const label = purpose === 'reset' ? 'password reset' : purpose === 'signup' ? 'sign-up' : 'login';
    const subject = `Your eMeal ${label} code: ${code}`;
    const text =
      `Your eMeal ${label} code is ${code}.\n` +
      `It expires in 10 minutes.\n\n` +
      `If you didn't request this, you can safely ignore this email.`;
    const html =
      `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px">` +
      `<p>Your eMeal ${label} code is:</p>` +
      `<p style="font-size:28px;font-weight:700;letter-spacing:4px;margin:8px 0">${code}</p>` +
      `<p style="color:#555">It expires in 10 minutes.</p>` +
      `<p style="color:#999;font-size:12px">If you didn't request this, you can safely ignore this email.</p>` +
      `</div>`;
    return this.send(to, subject, text, html);
  }
}
