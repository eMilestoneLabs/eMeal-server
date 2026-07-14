import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Refresh Token operations ──────────────────────────────────────────────

  async createRefreshToken(data: {
    userId: string;
    tokenHash: string;
    family: string;
    expiresAt: Date;
    userAgent?: string;
    ipAddress?: string;
  }) {
    return this.prisma.refreshToken.create({ data });
  }

  async findRefreshTokenByHash(tokenHash: string) {
    return this.prisma.refreshToken.findUnique({ where: { tokenHash } });
  }

  async findRefreshTokenById(id: string) {
    return this.prisma.refreshToken.findUnique({ where: { id } });
  }

  /**
   * Rotation bookkeeping: the token was redeemed (usedAt) and superseded by
   * `replacedById`. A revoked token whose successor has usedAt = null was
   * never delivered to the client — lost-response rescue, not theft.
   */
  async markRefreshTokenRotated(id: string, replacedById: string) {
    return this.prisma.refreshToken.update({
      where: { id },
      data: { isRevoked: true, usedAt: new Date(), replacedById },
    });
  }

  async revokeRefreshToken(id: string) {
    return this.prisma.refreshToken.update({
      where: { id },
      data: { isRevoked: true },
    });
  }

  async revokeAllTokensByFamily(family: string) {
    return this.prisma.refreshToken.updateMany({
      where: { family },
      data: { isRevoked: true },
    });
  }

  async revokeAllTokensByUser(userId: string) {
    return this.prisma.refreshToken.updateMany({
      where: { userId },
      data: { isRevoked: true },
    });
  }

  async deleteExpiredTokens() {
    return this.prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
  }

  // ── OTP operations ────────────────────────────────────────────────────────

  async createOtpRequest(data: {
    identifier: string;
    otpHash: string;
    purpose: string;
    expiresAt: Date;
    userId?: string;
  }) {
    // UNI-013 (uniqueness audit): exactly ONE active OTP per identifier +
    // purpose. Issuing a new code invalidates every previous unused one in the
    // same transaction — an older code can never be replayed after a resend
    // (findValidOtpRequest would otherwise fall back to it once the newest
    // code exhausts its attempts). Purposes stay independent (login vs reset).
    const [, created] = await this.prisma.$transaction([
      this.prisma.otpRequest.updateMany({
        where: { identifier: data.identifier, purpose: data.purpose, isUsed: false },
        data: { isUsed: true },
      }),
      this.prisma.otpRequest.create({ data }),
    ]);
    return created;
  }

  async findValidOtpRequest(identifier: string, purpose: string, maxAttempts = 5) {
    return this.prisma.otpRequest.findFirst({
      where: {
        identifier,
        purpose,
        isUsed: false,
        expiresAt: { gt: new Date() },
        attempts: { lt: maxAttempts },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async markOtpUsed(id: string) {
    return this.prisma.otpRequest.update({
      where: { id },
      data: { isUsed: true },
    });
  }

  async incrementOtpAttempts(id: string) {
    return this.prisma.otpRequest.update({
      where: { id },
      data: { attempts: { increment: 1 } },
    });
  }

  // ── Organization operations ───────────────────────────────────────────────

  async createOrganization(data: { name: string; slug: string }) {
    return this.prisma.organization.create({ data });
  }

  async findOrgBySlug(slug: string) {
    return this.prisma.organization.findUnique({ where: { slug } });
  }

  async slugExists(slug: string): Promise<boolean> {
    const org = await this.prisma.organization.findUnique({ where: { slug } });
    return !!org;
  }
}
