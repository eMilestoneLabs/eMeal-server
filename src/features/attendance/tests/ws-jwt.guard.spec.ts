import { WsJwtGuard } from '../../../realtime/guards/ws-jwt.guard';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../../redis/redis.service';

/**
 * WsJwtGuard unit tests.
 *
 * Tests verify:
 *   - Token extracted from handshake.auth.token (Flutter sends here)
 *   - Token extracted from Authorization header (fallback)
 *   - Invalid token → socket disconnected
 *   - Revoked family → socket disconnected
 *   - Valid token → socket.data populated with { userId, organizationId, role }
 */
describe('WsJwtGuard', () => {
  let guard: WsJwtGuard;
  let jwtService: jest.Mocked<JwtService>;
  let configService: jest.Mocked<ConfigService>;
  let redisService: jest.Mocked<RedisService>;

  const mockPayload = {
    sub: 'usr_01',
    organizationId: 'org_01',
    role: 'student',
    family: 'fam_01',
  };

  const makeSocket = (overrides: any = {}) => ({
    id: 'socket_test_01',
    handshake: {
      auth: {},
      headers: {},
      ...overrides.handshake,
    },
    data: {},
    emit: jest.fn(),
    disconnect: jest.fn(),
    join: jest.fn(),
    leave: jest.fn(),
    ...overrides,
  });

  beforeEach(() => {
    jwtService = {
      verify: jest.fn(),
      sign: jest.fn(),
    } as any;

    configService = {
      get: jest.fn().mockReturnValue('test-secret'),
    } as any;

    redisService = {
      isFamilyRevoked: jest.fn(),
    } as any;

    guard = new WsJwtGuard(jwtService, configService, redisService);
  });

  // ── Token extraction ──────────────────────────────────────────────────────

  describe('token extraction', () => {
    it('extracts token from handshake.auth.token (Flutter primary path)', async () => {
      const socket = makeSocket({
        handshake: { auth: { token: 'valid-token' }, headers: {} },
      });

      jwtService.verify.mockReturnValue(mockPayload);
      (redisService.isFamilyRevoked as jest.Mock).mockResolvedValue(false);

      const result = await guard.validateConnection(socket as any);

      expect(result).toBeDefined();
      expect(jwtService.verify).toHaveBeenCalledWith('valid-token', expect.any(Object));
    });

    it('extracts token from Authorization header (fallback)', async () => {
      const socket = makeSocket({
        handshake: {
          auth: {}, // no auth.token
          headers: { authorization: 'Bearer header-token' },
        },
      });

      jwtService.verify.mockReturnValue(mockPayload);
      (redisService.isFamilyRevoked as jest.Mock).mockResolvedValue(false);

      await guard.validateConnection(socket as any);

      expect(jwtService.verify).toHaveBeenCalledWith('header-token', expect.any(Object));
    });

    it('disconnects when no token provided', async () => {
      const socket = makeSocket({
        handshake: { auth: {}, headers: {} },
      });

      const result = await guard.validateConnection(socket as any);

      expect(result).toBeNull();
      expect(socket.disconnect).toHaveBeenCalled();
      expect(socket.emit).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({ code: 'WS_AUTH_REQUIRED' }),
      );
    });
  });

  // ── Token validation ──────────────────────────────────────────────────────

  describe('token validation', () => {
    it('disconnects when token is invalid (verify throws)', async () => {
      const socket = makeSocket({
        handshake: { auth: { token: 'bad-token' }, headers: {} },
      });

      jwtService.verify.mockImplementation(() => {
        throw new Error('invalid signature');
      });

      const result = await guard.validateConnection(socket as any);

      expect(result).toBeNull();
      expect(socket.disconnect).toHaveBeenCalled();
      expect(socket.emit).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({ code: 'WS_TOKEN_INVALID' }),
      );
    });

    it('disconnects when token family is revoked (logout detection)', async () => {
      const socket = makeSocket({
        handshake: { auth: { token: 'revoked-token' }, headers: {} },
      });

      jwtService.verify.mockReturnValue(mockPayload);
      (redisService.isFamilyRevoked as jest.Mock).mockResolvedValue(true); // revoked!

      const result = await guard.validateConnection(socket as any);

      expect(result).toBeNull();
      expect(socket.disconnect).toHaveBeenCalled();
      expect(socket.emit).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({ code: 'WS_SESSION_REVOKED' }),
      );
    });
  });

  // ── Payload population ────────────────────────────────────────────────────

  describe('socket.data population', () => {
    it('populates socket.data.userId, organizationId, role on success', async () => {
      const socket = makeSocket({
        handshake: { auth: { token: 'good-token' }, headers: {} },
      });

      jwtService.verify.mockReturnValue(mockPayload);
      (redisService.isFamilyRevoked as jest.Mock).mockResolvedValue(false);

      const result = await guard.validateConnection(socket as any);

      expect(result).not.toBeNull();
      expect(socket.data.userId).toBe('usr_01');
      expect(socket.data.organizationId).toBe('org_01');
      expect(socket.data.role).toBe('student');
    });

    it('returns the full JWT payload on success', async () => {
      const socket = makeSocket({
        handshake: { auth: { token: 'good-token' }, headers: {} },
      });

      jwtService.verify.mockReturnValue(mockPayload);
      (redisService.isFamilyRevoked as jest.Mock).mockResolvedValue(false);

      const result = await guard.validateConnection(socket as any);

      expect(result?.sub).toBe('usr_01');
      expect(result?.organizationId).toBe('org_01');
      expect(result?.role).toBe('student');
    });

    it('does NOT disconnect valid socket', async () => {
      const socket = makeSocket({
        handshake: { auth: { token: 'good-token' }, headers: {} },
      });

      jwtService.verify.mockReturnValue(mockPayload);
      (redisService.isFamilyRevoked as jest.Mock).mockResolvedValue(false);

      await guard.validateConnection(socket as any);

      expect(socket.disconnect).not.toHaveBeenCalled();
    });
  });
});
