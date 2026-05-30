import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
  MessageBody,
  WsException,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, UseGuards, Injectable } from '@nestjs/common';
import { WsJwtGuard } from '../guards/ws-jwt.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { WsMetricsService } from '../services/ws-metrics.service';

/**
 * AttendanceGateway (B4 + B7) — Production Socket.IO gateway.
 *
 * ── Room architecture ──────────────────────────────────────────────────────
 *   user:{userId}             — personal room (auto-join on connection)
 *   organization:{orgId}      — org-wide room (auto-join on connection)
 *   admin:{orgId}             — admin-only room (auto-join for admin roles)
 *   group:{groupId}           — group-scoped (join via join:group message)
 *
 * ── Event naming (versioned, additive-safe) ────────────────────────────────
 *   attendance.marked.v1           — first-time attendance mark
 *   attendance.updated.v1          — admin override / re-mark
 *   meal.updated.v1                — meal config changed
 *   meal.published.v1              — meal activated for the day
 *   schedule.updated.v1            — draft schedule modified
 *   schedule.published.v1          — schedule published to students
 *   dashboard.summary.updated.v1   — dashboard cache bust signal
 *   member.blocked.v1              — member blocked by admin
 *   group.member.updated.v1        — membership change
 *
 * ── Security ──────────────────────────────────────────────────────────────
 *   - JWT verified on every connection (validateConnection)
 *   - Revoked token families rejected (Redis check)
 *   - Group room join requires org isolation check + active membership
 *   - Per-socket message rate limiting (WS_RATE_LIMIT_MAX / WS_RATE_WINDOW_MS)
 *
 * ── Reconnect safety ──────────────────────────────────────────────────────
 *   - socket.data.userId persists across transport upgrades
 *   - Re-identified reconnects recorded in WsMetricsService
 *   - No stale room subscriptions (Socket.IO cleans rooms on disconnect)
 */

const ADMIN_ROLES = new Set([
  'messManager',
  'hostelManager',
  'hostelAdmin',
  'organizationManager',
]);

/** Per-socket anti-spam: max messages per window */
const WS_RATE_LIMIT_MAX = parseInt(process.env.WS_RATE_LIMIT_MAX ?? '30', 10);
const WS_RATE_WINDOW_MS = parseInt(process.env.WS_RATE_WINDOW_MS ?? '60000', 10);

interface SocketRateEntry {
  count: number;
  windowStart: number;
}

@WebSocketGateway({
  cors: {
    origin: '*', // Inherited from main.ts CORS config in production
    credentials: true,
  },
  namespace: '/',
  transports: ['websocket', 'polling'],
})
@Injectable()
export class AttendanceGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  private server: Server;

  private readonly logger = new Logger(AttendanceGateway.name);

  /** Per-socket rate limiting state — keyed by socket.id */
  private readonly rateLimitMap = new Map<string, SocketRateEntry>();

  constructor(
    private readonly wsJwtGuard: WsJwtGuard,
    private readonly prisma: PrismaService,
    private readonly metrics: WsMetricsService,
  ) {}

  afterInit(server: Server): void {
    this.logger.log('AttendanceGateway initialized');
  }

  // ── Connection lifecycle ──────────────────────────────────────────────────

  async handleConnection(client: Socket): Promise<void> {
    this.logger.debug(`WS connecting: ${client.id}`);

    const payload = await this.wsJwtGuard.validateConnection(client);
    if (!payload) return; // Guard already disconnected the client

    const isReconnect = !!client.handshake?.auth?.reconnect;
    this.metrics.recordConnection(isReconnect);

    // Auto-join personal user room
    await client.join(`user:${payload.sub}`);

    // Auto-join org-wide room (students + admins)
    await client.join(`organization:${payload.organizationId}`);

    // Auto-join admin room for admin roles
    if (ADMIN_ROLES.has(payload.role)) {
      await client.join(`admin:${payload.organizationId}`);
    }

    if (isReconnect) {
      this.logger.debug(
        `WS reconnected: userId=${payload.sub} socketId=${client.id}`,
      );
    } else {
      this.logger.log(
        `WS connected: userId=${payload.sub} orgId=${payload.organizationId} ` +
          `role=${payload.role} socketId=${client.id}`,
      );
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    this.metrics.recordDisconnection();
    this.rateLimitMap.delete(client.id);
    this.logger.debug(
      `WS disconnected: userId=${client.data?.userId ?? 'unknown'} socketId=${client.id}`,
    );
  }

  // ── Anti-spam rate limiting ───────────────────────────────────────────────

  /**
   * Check per-socket rate limit.
   * Returns false and disconnects if limit exceeded.
   */
  private checkRateLimit(client: Socket): boolean {
    const now = Date.now();
    const entry = this.rateLimitMap.get(client.id) ?? {
      count: 0,
      windowStart: now,
    };

    if (now - entry.windowStart > WS_RATE_WINDOW_MS) {
      // New window
      entry.count = 1;
      entry.windowStart = now;
    } else {
      entry.count++;
    }

    this.rateLimitMap.set(client.id, entry);

    if (entry.count > WS_RATE_LIMIT_MAX) {
      this.logger.warn(
        `WS rate limit exceeded: userId=${client.data?.userId} socketId=${client.id} ` +
          `count=${entry.count}/${WS_RATE_LIMIT_MAX}`,
      );
      client.emit('error', {
        message: 'Rate limit exceeded — slow down',
        code: 'WS_RATE_LIMIT',
      });
      return false;
    }

    return true;
  }

  // ── Room join / leave ─────────────────────────────────────────────────────

  /**
   * join:group — client requests to join a group room.
   * Payload: { groupId: string }
   *
   * Validates:
   *   1. Group belongs to user's organization (cross-org isolation)
   *   2. Non-admin users must be active members of the group
   */
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('join:group')
  async handleJoinGroup(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { groupId: string },
  ): Promise<{ joined: boolean; room: string }> {
    if (!this.checkRateLimit(client)) {
      throw new WsException('Rate limit exceeded');
    }

    const { userId, organizationId, role } = client.data;
    const groupId = data?.groupId;

    if (!groupId || typeof groupId !== 'string') {
      throw new WsException('groupId is required');
    }

    // CRITICAL: Verify group belongs to user's org — prevents cross-org leakage
    const group = await this.prisma.group.findFirst({
      where: { id: groupId, organizationId, isActive: true },
      select: { id: true },
    });

    if (!group) {
      throw new WsException('Group not found or access denied');
    }

    // Non-admin roles must be active members
    if (!ADMIN_ROLES.has(role)) {
      const memberCount = await this.prisma.groupMember.count({
        where: { groupId, userId, status: 'active' },
      });

      if (!memberCount) {
        throw new WsException('Not an active member of this group');
      }
    }

    await client.join(`group:${groupId}`);
    this.logger.debug(`userId=${userId} joined group:${groupId}`);

    return { joined: true, room: `group:${groupId}` };
  }

  /**
   * leave:group — client leaves a group room.
   * Payload: { groupId: string }
   */
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('leave:group')
  async handleLeaveGroup(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { groupId: string },
  ): Promise<{ left: boolean; room: string }> {
    if (!this.checkRateLimit(client)) {
      throw new WsException('Rate limit exceeded');
    }

    const room = `group:${data?.groupId}`;
    await client.leave(room);
    this.logger.debug(`userId=${client.data?.userId} left ${room}`);
    return { left: true, room };
  }

  /**
   * ping — client heartbeat / latency measurement.
   * Returns: { pong: true, serverTime: ISO string }
   *
   * Client should record round-trip time for latency monitoring.
   */
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('ping')
  handlePing(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { clientTime?: number },
  ): { pong: boolean; serverTime: string; latencyMs?: number } {
    const serverNow = Date.now();
    const latencyMs = data?.clientTime
      ? Math.abs(serverNow - data.clientTime)
      : undefined;

    if (latencyMs !== undefined) {
      this.metrics.recordLatency(latencyMs);
    }

    return {
      pong: true,
      serverTime: new Date(serverNow).toISOString(),
      latencyMs,
    };
  }

  /**
   * get:metrics — admin-only: returns current WS metrics snapshot.
   */
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('get:metrics')
  handleGetMetrics(
    @ConnectedSocket() client: Socket,
  ): Record<string, unknown> {
    if (!ADMIN_ROLES.has(client.data?.role)) {
      throw new WsException('Admin access required');
    }
    return this.metrics.getSnapshot(this.server) as unknown as Record<string, unknown>;
  }

  // ── Emit helpers — called by RealtimeEventsService ────────────────────────

  /** Emit versioned event to all sockets in a group room */
  emitToGroup(groupId: string, event: string, payload: unknown): void {
    this.server?.to(`group:${groupId}`).emit(event, payload);
  }

  /** Emit event to a specific user's personal room */
  emitToUser(userId: string, event: string, payload: unknown): void {
    this.server?.to(`user:${userId}`).emit(event, payload);
  }

  /** Emit event to entire organization room (students + admins) */
  emitToOrg(organizationId: string, event: string, payload: unknown): void {
    this.server?.to(`organization:${organizationId}`).emit(event, payload);
  }

  /** Emit event to admin-only room for an organization */
  emitToAdmin(organizationId: string, event: string, payload: unknown): void {
    this.server?.to(`admin:${organizationId}`).emit(event, payload);
  }

  // ── Typed convenience emitters (used by AttendanceService directly) ────────

  emitAttendanceMarked(
    groupId: string,
    payload: {
      groupId: string;
      userId: string;
      mealId: string;
      date: string;
      status: string;
      preference: string | null;
      markedAt: string;
    },
  ): void {
    this.emitToGroup(groupId, 'attendance.marked.v1', payload);
  }

  emitAttendanceUpdated(
    groupId: string,
    payload: {
      groupId: string;
      userId: string;
      mealId: string;
      date: string;
      status: string;
      preference: string | null;
      markedAt: string;
      markedBy: string | null;
    },
  ): void {
    this.emitToGroup(groupId, 'attendance.updated.v1', payload);
  }

  emitMealUpdated(organizationId: string, payload: unknown): void {
    this.emitToOrg(organizationId, 'meal.updated.v1', payload);
  }

  emitMealPublished(groupId: string, payload: unknown): void {
    this.emitToGroup(groupId, 'meal.published.v1', payload);
  }

  emitSchedulePublished(organizationId: string, groupId: string, payload: unknown): void {
    this.emitToGroup(groupId, 'schedule.published.v1', payload);
    this.emitToAdmin(organizationId, 'schedule.published.v1', payload);
  }

  emitScheduleUpdated(organizationId: string, payload: unknown): void {
    this.emitToAdmin(organizationId, 'schedule.updated.v1', payload);
  }

  emitDashboardSummaryUpdated(
    organizationId: string,
    groupId: string,
    payload: unknown,
  ): void {
    this.emitToGroup(groupId, 'dashboard.summary.updated.v1', payload);
    this.emitToAdmin(organizationId, 'dashboard.summary.updated.v1', payload);
  }

  emitMemberBlocked(groupId: string, payload: unknown): void {
    this.emitToGroup(groupId, 'member.blocked.v1', payload);
  }

  emitGroupMemberUpdated(groupId: string, payload: unknown): void {
    this.emitToGroup(groupId, 'group.member.updated.v1', payload);
  }

  /** Expose server for metrics service */
  getServer(): Server {
    return this.server;
  }
}
