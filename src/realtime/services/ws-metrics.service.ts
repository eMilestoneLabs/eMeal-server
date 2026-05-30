import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';

/**
 * WsMetricsService — WebSocket connection and room metrics.
 *
 * Tracks:
 *   - Total lifetime connections / disconnections
 *   - Reconnect count (socket.data.reconnect flag set by gateway)
 *   - Active socket count (live, from server.sockets.sockets)
 *   - Per-room socket counts
 *   - Latency samples (from ping/pong round-trips)
 *
 * Usage:
 *   Inject into the gateway. Call record*() from lifecycle hooks.
 *   Call getSnapshot(server) for full metrics dump (health endpoint / logs).
 */
export interface WsMetricsSnapshot {
  activeConnections: number;
  totalConnections: number;
  totalDisconnections: number;
  totalReconnects: number;
  rooms: Record<string, number>;
  avgLatencyMs: number | null;
  uptimeSeconds: number;
}

@Injectable()
export class WsMetricsService {
  private readonly logger = new Logger(WsMetricsService.name);

  private totalConnections = 0;
  private totalDisconnections = 0;
  private totalReconnects = 0;
  private readonly latencySamples: number[] = [];
  private readonly MAX_LATENCY_SAMPLES = 100;
  private readonly startedAt = Date.now();

  /** Call from gateway.handleConnection() */
  recordConnection(isReconnect = false): void {
    this.totalConnections++;
    if (isReconnect) this.totalReconnects++;
  }

  /** Call from gateway.handleDisconnect() */
  recordDisconnection(): void {
    this.totalDisconnections++;
  }

  /** Record a ping/pong latency sample (ms) */
  recordLatency(ms: number): void {
    this.latencySamples.push(ms);
    if (this.latencySamples.length > this.MAX_LATENCY_SAMPLES) {
      this.latencySamples.shift();
    }
  }

  /**
   * Returns a full metrics snapshot.
   * Pass the gateway's server instance for live socket/room counts.
   */
  getSnapshot(server?: Server): WsMetricsSnapshot {
    const activeConnections = server?.sockets?.sockets?.size ?? 0;

    const rooms: Record<string, number> = {};
    if (server?.sockets?.adapter?.rooms) {
      for (const [roomName, sockets] of server.sockets.adapter.rooms) {
        // Skip socket-id rooms (each socket gets its own private room)
        if (!server.sockets.sockets.has(roomName)) {
          rooms[roomName] = sockets.size;
        }
      }
    }

    const avgLatencyMs =
      this.latencySamples.length > 0
        ? Math.round(
            this.latencySamples.reduce((a, b) => a + b, 0) /
              this.latencySamples.length,
          )
        : null;

    return {
      activeConnections,
      totalConnections: this.totalConnections,
      totalDisconnections: this.totalDisconnections,
      totalReconnects: this.totalReconnects,
      rooms,
      avgLatencyMs,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  /** Log current metrics at INFO level (call from scheduled job or health check) */
  logSnapshot(server?: Server): void {
    const snap = this.getSnapshot(server);
    this.logger.log(
      `WS metrics | active=${snap.activeConnections} total=${snap.totalConnections} ` +
        `disconnects=${snap.totalDisconnections} reconnects=${snap.totalReconnects} ` +
        `avgLatency=${snap.avgLatencyMs ?? 'n/a'}ms uptime=${snap.uptimeSeconds}s`,
    );
    const roomEntries = Object.entries(snap.rooms)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10); // top 10 rooms
    if (roomEntries.length) {
      const roomStr = roomEntries.map(([r, n]) => `${r}:${n}`).join(' ');
      this.logger.log(`WS rooms | ${roomStr}`);
    }
  }
}
