import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * SRS Module 03 ACC-005 (survey Q1/Q19) — email verification is required to
 * PARTICIPATE: marking attendance, preference selection (rides marking),
 * guest booking, correction requests and vacation requests are blocked for
 * unverified accounts. Read-only browsing stays open, and existing
 * history/billing is untouched — the member simply cannot create new
 * participation writes until they verify.
 *
 * The client shows a guided "Verify your email" flow on this error — the
 * message wording is part of that contract.
 *
 * Enforcement is env-toggleable (EMAIL_VERIFICATION_REQUIRED, default ON)
 * purely as an emergency rollback lever.
 */
@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const enforced =
      (process.env.EMAIL_VERIFICATION_REQUIRED ?? 'true') !== 'false';
    if (!enforced) return true;

    const req = context.switchToHttp().getRequest();
    const userId: string | undefined = req.user?.sub;
    if (!userId) return true; // JwtAuthGuard owns authentication

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { emailVerifiedAt: true },
    });
    if (user?.emailVerifiedAt) return true;

    throw new ForbiddenException({
      message:
        'Please verify your email to participate. Verification is required before marking attendance, booking guests, or sending requests.',
      code: 'EMAIL_VERIFICATION_REQUIRED',
      errors: { email: 'Email not verified' },
    });
  }
}
