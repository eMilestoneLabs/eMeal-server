import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { UsersRepository } from './repositories/users.repository';
import { UserSerializer } from './serializers/user.serializer';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  constructor(private readonly usersRepo: UsersRepository) {}

  async getMe(userId: string) {
    const user = await this.usersRepo.findById(userId);
    if (!user) throw new NotFoundException('User not found');
    return UserSerializer.toResponse(user);
  }

  async updateMe(userId: string, dto: UpdateUserDto) {
    const user = await this.usersRepo.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    // Check for email/phone conflicts if updating
    if (dto.email && dto.email !== user.email) {
      const exists = await this.usersRepo.existsByEmail(dto.email);
      if (exists) {
        throw new ConflictException({
          message: 'Validation failed',
          errors: { email: 'Email already in use' },
        });
      }
    }
    if (dto.phone && dto.phone !== user.phone) {
      const exists = await this.usersRepo.existsByPhone(dto.phone);
      if (exists) {
        throw new ConflictException({
          message: 'Validation failed',
          errors: { phone: 'Phone number already in use' },
        });
      }
    }

    const updated = await this.usersRepo.update(userId, {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.email !== undefined && { email: dto.email }),
      ...(dto.phone !== undefined && { phone: dto.phone }),
      ...(dto.avatarUrl !== undefined && { avatarUrl: dto.avatarUrl }),
      ...(dto.gender !== undefined && { gender: dto.gender }),
      ...(dto.age !== undefined && { age: dto.age }),
      ...(dto.isVacationMode !== undefined && { isVacationMode: dto.isVacationMode }),
      ...(dto.isDefaultAttendance !== undefined && { isDefaultAttendance: dto.isDefaultAttendance }),
      ...(dto.remindersEnabled !== undefined && { remindersEnabled: dto.remindersEnabled }),
      ...(dto.loginPreference !== undefined && { loginPreference: dto.loginPreference }),
    });

    return UserSerializer.toResponse(updated);
  }

  async setVacationMode(userId: string, enabled: boolean) {
    const user = await this.usersRepo.update(userId, { isVacationMode: enabled });
    return {
      isVacationMode: user.isVacationMode,
      message: enabled ? 'Vacation mode enabled' : 'Vacation mode disabled',
    };
  }

  async setDefaultAttendance(userId: string, enabled: boolean) {
    const user = await this.usersRepo.update(userId, { isDefaultAttendance: enabled });
    return {
      isDefaultAttendance: user.isDefaultAttendance,
      message: enabled
        ? 'Default attendance mode enabled'
        : 'Default attendance mode disabled',
    };
  }

  async updateFcmToken(userId: string, token: string) {
    await this.usersRepo.update(userId, { fcmToken: token });
    return { message: 'FCM token updated' };
  }
  async listByOrg(organizationId: string, params: { page: number; limit: number }) {
    const page = Math.max(1, params.page);
    const limit = Math.min(100, Math.max(1, params.limit));
    const skip = (page - 1) * limit;
    const [users, total] = await Promise.all([
      this.usersRepo.findByOrg(organizationId, skip, limit),
      this.usersRepo.countByOrg(organizationId),
    ]);
    return {
      data: users.map(UserSerializer.toResponse),
      total,
      page,
      limit,
    };
  }

  async removeUser(userId: string, organizationId: string) {
    const user = await this.usersRepo.findById(userId);
    if (!user || user.organizationId !== organizationId) {
      throw new NotFoundException('User not found');
    }
    await this.usersRepo.update(userId, { isActive: false });
    return { message: 'User removed successfully' };
  }

}
