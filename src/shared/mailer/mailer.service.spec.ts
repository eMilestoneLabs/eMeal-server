import { Logger } from '@nestjs/common';
import { MailerService } from './mailer.service';

/**
 * Live-Test-16 ISSUE-3: a successful send is now logged (masked recipient +
 * provider message id) so "email never arrived" reports can be traced. The
 * OTP code (it rides the subject) must NEVER reach the log.
 */
describe('MailerService acceptance log (ISSUE-3)', () => {
  const makeService = () => {
    const config: any = { get: jest.fn((k: string, d?: string) => d ?? '') };
    const svc = new MailerService(config);
    const sendMail = jest.fn().mockResolvedValue({ messageId: '<msg-1@smtp>' });
    (svc as any).transporter = { sendMail };
    return { svc, sendMail };
  };

  it('masks the recipient', () => {
    expect(MailerService.maskEmail('member.one@example.com')).toBe('me***@example.com');
    expect(MailerService.maskEmail('a@x.io')).toBe('a***@x.io');
    expect(MailerService.maskEmail('not-an-email')).toBe('***');
  });

  it('logs acceptance with the message id and WITHOUT the OTP digits or full address', async () => {
    const { svc } = makeService();
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const ok = await svc.sendOtp('member.one@example.com', '482913', 'signup', 10);
    expect(ok).toBe(true);
    const line = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('email accepted'));
    expect(line).toBeDefined();
    expect(line).toContain('me***@example.com');
    expect(line).toContain('<msg-1@smtp>');
    expect(line).not.toContain('482913');
    expect(line).not.toContain('member.one');
    logSpy.mockRestore();
  });

  it('a failed send is still reported as false (unchanged behaviour)', async () => {
    const { svc, sendMail } = makeService();
    sendMail.mockRejectedValueOnce(new Error('550 rejected'));
    const errSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(svc.send('a@x.io', 's', 't')).resolves.toBe(false);
    errSpy.mockRestore();
  });

  it('a FAILED OTP send logs the SMTP reason but never the code or full address (§5)', async () => {
    const { svc, sendMail } = makeService();
    sendMail.mockRejectedValueOnce(new Error('421 4.7.0 Try again later'));
    const errSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const ok = await svc.sendOtp('member.one@example.com', '739105', 'signup', 10);
    expect(ok).toBe(false);
    const line = errSpy.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('email send failed'));
    expect(line).toBeDefined();
    expect(line).toContain('me***@example.com');
    expect(line).toContain('421 4.7.0 Try again later'); // ops still see WHY
    expect(line).not.toContain('739105');
    expect(line).not.toContain('member.one');
    errSpy.mockRestore();
  });
});
