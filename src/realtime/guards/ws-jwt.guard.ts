import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Socket } from 'socket.io';
import { RedisService } from '../../redis/redis.service';

/**
 * WsJwtGuard — validates JWT on Socket.IO connection handshake.
 *
 * Token extraction order:
 *  1. socket.handshake.auth.token (Flutter sends here)
 *  2. socket.handshake.headers.authorization (Bearer <token>)
 *
 * On failure: socket is disconnected immediately with error payload.
 * On success: socket.data.{userId, organizationId, role} is populated.
 */
@Injectable()
export class WsJwtGuard implements CanActivate {
  private readonly logger = new Logger(WsJwtGuard.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  /**
   * validateConnection — called by gateway.handleConnection() on new socket.
   * Extracts + verifies JWT, checks Redis revocation, populates socket.data.
   * Returns payload on success, null on failure (socket is disconnected).
   */
  async validateConnection(
    client: Socket,
  ): Promise<{ sub: string; organizationId: string; role: string } | null> {
    const token = this.extractToken(client);
    if (!token) {
      this.logger.warn(`WS rejected — no token (socketId=${client.id})`);
      client.emit('error', { message: 'Authentication required', code: 'WS_AUTH_REQUIRED' });
      client.disconnect();
      return null;
    }

    try {
      const secret = this.config.get<string>('jwt.accessSecret');
      const payload = this.jwtService.verify<{
        sub: string;
        organizationId: string;
        role: string;
      }>(token, { secret });

      // Check token family revocation (logout / theft detection)
      const family = (payload as any).family;
      if (family) {
        const revoked = await this.redis.isFamilyRevoked(family);
        if (revoked) {
          this.logger.warn(`WS rejected — revoked family (userId=${payload.sub})`);
          client.emit('error', { message: 'Session expired', code: 'WS_SESSION_REVOKED' });
          client.disconnect();
          return null;
        }
      }

      // Populate socket.data for downstream guards and message handlers
      client.data.userId = payload.sub;
      client.data.organizationId = payload.organizationId;
      client.data.role = payload.role;

      return payload;
    } catch (err) {
      this.logger.warn(`WS rejected — invalid token: ${err?.message} (socketId=${client.id})`);
      client.emit('error', { message: 'Invalid token', code: 'WS_TOKEN_INVALID' });
      client.disconnect();
      return null;
    }
  }

  /**
   * canActivate — used by @UseGuards(WsJwtGuard) on individual message handlers.
   * socket.data.userId is set by validateConnection on connection.
   * If present, the socket is already authenticated — no re-verification needed.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client: Socket = context.switchToWs().getClient<Socket>();
    return !!client.data?.userId;
  }

  private extractToken(client: Socket): string | null {
    // Primary: Flutter sends token in handshake.auth.token
    const authToken = client.handshake?.auth?.token;
    if (authToken && typeof authToken === 'string') return authToken;

    // Fallback: Authorization: Bearer <token> header
    const authHeader = client.handshake?.headers?.authorization;
    if (authHeader && typeof authHeader === 'string') {
      const parts = authHeader.split(' ');
      if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
        return parts[1];
      }
    }

    return null;
  }
}
