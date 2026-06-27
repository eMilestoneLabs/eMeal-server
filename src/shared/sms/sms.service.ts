import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * SmsService — transactional SMS OTP (Phase 3).
 *
 * Provider-agnostic, env-driven, DISABLED by default (returns false if not
 * configured, so phone OTP simply isn't delivered until you add a provider —
 * the OTP is still generated/verified). Uses Node 20's global fetch (no dep).
 *
 * There is NO free production SMS in India. Recommended providers (commercially
 * paid, DLT-compliant): MSG91 / Fast2SMS. Alternatively, Firebase Phone Auth
 * (free tier, Flutter-side) bypasses this adapter entirely — see
 * docs/NOTIFICATION_OTP_PLAN.md §5.
 *
 * Env:
 *   SMS_PROVIDER     "msg91" (default) | "generic"
 *   SMS_API_URL      provider endpoint (e.g. https://control.msg91.com/api/v5/flow/)
 *   SMS_API_KEY      provider auth key
 *   SMS_SENDER_ID    approved sender / header (e.g. EMEALX)
 *   SMS_TEMPLATE_ID  DLT/flow template id (MSG91)
 *   SMS_COUNTRY_CODE default country code for 10-digit numbers (default 91 = India)
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private warnedDisabled = false;

  constructor(private readonly config: ConfigService) {}

  private cfg() {
    return {
      provider: this.config.get<string>('SMS_PROVIDER', 'msg91') ?? 'msg91',
      apiUrl: this.config.get<string>('SMS_API_URL'),
      apiKey: this.config.get<string>('SMS_API_KEY'),
      sender: this.config.get<string>('SMS_SENDER_ID'),
      templateId: this.config.get<string>('SMS_TEMPLATE_ID'),
      cc: this.config.get<string>('SMS_COUNTRY_CODE', '91') ?? '91',
    };
  }

  /** Best-effort SMS OTP. Returns true on success; never throws. */
  async sendOtp(phone: string, code: string): Promise<boolean> {
    const c = this.cfg();
    if (!c.apiUrl || !c.apiKey) {
      if (!this.warnedDisabled) {
        this.logger.warn('SMS not configured (SMS_API_URL/SMS_API_KEY) — SMS OTP disabled');
        this.warnedDisabled = true;
      }
      return false;
    }
    const mobile = this.normalize(phone, c.cc);
    try {
      let res: Response;
      if (c.provider === 'msg91') {
        // MSG91 Flow API — OTP delivered via a pre-approved DLT template
        res = await fetch(c.apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', authkey: c.apiKey },
          body: JSON.stringify({
            template_id: c.templateId,
            sender: c.sender,
            short_url: '0',
            recipients: [{ mobiles: mobile, OTP: code }],
          }),
        });
      } else {
        // Generic provider — adjust to your gateway's contract via env/this branch
        res = await fetch(c.apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
          body: JSON.stringify({
            to: mobile,
            sender: c.sender,
            message: `Your eMeal code is ${code}. Valid 10 minutes.`,
          }),
        });
      }
      if (!res.ok) {
        this.logger.error(`SMS send failed http=${res.status} to=${this.mask(mobile)}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(`SMS send error to=${this.mask(mobile)}: ${(err as Error).message}`);
      return false;
    }
  }

  /** Strip non-digits; prefix country code for bare 10-digit numbers. */
  private normalize(phone: string, cc: string): string {
    const d = phone.replace(/\D/g, '');
    return d.length === 10 ? `${cc}${d}` : d;
  }

  private mask(m: string): string {
    return m.length > 4 ? `${m.slice(0, 2)}***${m.slice(-2)}` : '***';
  }
}
