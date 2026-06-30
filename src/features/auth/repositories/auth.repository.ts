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
    return this.prisma.otpRequest.create({ data });
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
