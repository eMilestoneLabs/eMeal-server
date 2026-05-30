import { UserSerializer } from '../../users/serializers/user.serializer';
import { UserEntity } from '../../users/entities/user.entity';

/**
 * Auth response serializer.
 * Produces the exact shape Flutter AuthSession.fromJson expects:
 *
 * {
 *   "accessToken": "...",
 *   "refreshToken": "...",
 *   "expiresIn": 900,        ← INTEGER (seconds), not ISO string
 *   "user": { ... }          ← full UserModel JSON
 * }
 *
 * Contract (M-02 fix): expiresIn is INTEGER primary field.
 */
export class AuthSerializer {
  static toResponse(data: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;  // seconds integer
    user: UserEntity;
  }): Record<string, unknown> {
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expiresIn: data.expiresIn,  // integer — primary field Flutter reads
      user: UserSerializer.toResponse(data.user),
    };
  }
}
