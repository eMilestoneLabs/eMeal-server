/**
 * PM2 Ecosystem Configuration
 * Smart Meal & Attendance Management SaaS — Production Deployment
 *
 * Deployment target: Contabo VPS 10 / Ubuntu 22.04
 * Runtime: Node.js cluster mode for multi-core utilization
 *
 * Usage:
 *   pm2 start ecosystem.config.js --env production
 *   pm2 reload ecosystem.config.js --env production   (zero-downtime reload)
 *   pm2 stop ecosystem.config.js
 *   pm2 delete ecosystem.config.js
 *   pm2 logs emeal-server
 *   pm2 monit
 */

module.exports = {
  apps: [
    {
      name: 'emeal-server',
      script: 'dist/main.js',

      // ── Cluster mode for multi-core VPS ────────────────────────────────
      instances: 'max',        // Use all available CPU cores
      exec_mode: 'cluster',    // PM2 cluster mode (Node.js cluster)

      // ── Auto-restart behavior ──────────────────────────────────────────
      autorestart: true,
      watch: false,            // Never watch in production
      max_restarts: 10,
      min_uptime: '10s',       // Minimum uptime before considered stable
      restart_delay: 2000,     // 2s between restarts
      exp_backoff_restart_delay: 100,

      // ── Memory & CPU guards ────────────────────────────────────────────
      max_memory_restart: '512M',  // Restart instance if RSS exceeds 512MB

      // ── Logging ───────────────────────────────────────────────────────
      // NOTE: PM2 reads `out_file`/`error_file` (NOT `output`/`error`). Using the
      // correct keys ensures logs land here (and pm2-logrotate caps them at 100M/30d).
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,        // Merge cluster instance logs into one file
      log_type: 'json',        // Structured JSON logging for log aggregators

      // ── Environment: Development ───────────────────────────────────────
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        QUEUE_ROLE: 'web',       // HTTP tier — job processing lives in emeal-worker
      },

      // ── Environment: Production ────────────────────────────────────────
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        QUEUE_ROLE: 'web',       // HTTP tier — job processing lives in emeal-worker

        // Database (override via .env — these are fallback reference values)
        // DATABASE_URL: 'postgresql://user:pass@localhost:5432/emeal_prod',

        // Redis
        // REDIS_HOST: '127.0.0.1',
        // REDIS_PORT: 6379,

        // JWT
        // JWT_ACCESS_SECRET: '<set-via-env-file>',
        // JWT_REFRESH_SECRET: '<set-via-env-file>',
        // JWT_ACCESS_EXPIRY: '15m',
        // JWT_REFRESH_EXPIRY: '7d',

        // App
        // CORS_ORIGINS: 'https://app.emeal.in,https://admin.emeal.in',
        // BULL_BOARD_SECRET: '<set-via-env-file>',
      },

      // ── Graceful shutdown ──────────────────────────────────────────────
      kill_timeout: 10000,       // 10s for graceful shutdown before SIGKILL
      listen_timeout: 8000,      // 8s to wait for app to bind to port

      // ── Source maps (enable for readable stack traces in production) ───
      source_map_support: true,

      // ── Node.js flags ──────────────────────────────────────────────────
      node_args: [
        '--max-old-space-size=384',  // Limit V8 heap to 384MB per instance
      ],
    },

    // ── Dedicated background-job tier (2026-07-19) ─────────────────────────
    // Owns ALL BullMQ processors + the repeatable sweep scheduler (see
    // QUEUE_ROLE in app.module.ts). Web instances above run QUEUE_ROLE=web
    // and never execute jobs, so a sweep can no longer stall a request's
    // event loop mid-flight (the measured rotating p95 outliers). One fork
    // instance is correct: BullMQ concurrency lives inside the process, and
    // job volume is minutes-cadence sweeps, not throughput work. Listens on
    // :3010 (never routed by Nginx) purely so /health works for monitoring.
    // Realtime emits from jobs reach web-tier sockets via the Socket.IO
    // Redis adapter, which the PM2 cluster already requires.
    {
      name: 'emeal-worker',
      script: 'dist/main.js',
      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 2000,
      exp_backoff_restart_delay: 100,
      max_memory_restart: '512M',

      out_file: './logs/pm2-worker-out.log',
      error_file: './logs/pm2-worker-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      log_type: 'json',

      env: {
        NODE_ENV: 'development',
        PORT: 3010,
        QUEUE_ROLE: 'worker',
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3010,
        QUEUE_ROLE: 'worker',
      },

      kill_timeout: 10000,       // let in-flight jobs finish on reload
      listen_timeout: 8000,
      source_map_support: true,
      node_args: ['--max-old-space-size=384'],
    },
  ],

  // ── Deployment ─────────────────────────────────────────────────────────
  // NOTE: production releases are driven by deploy/deploy.sh on the server
  // (pre-deploy backup → pull → build → migrate → reload → health + rollback),
  // NOT `pm2 deploy`. Values below are kept only as accurate reference.
  deploy: {
    production: {
      user: 'emeal',
      host: ['5.189.153.205'],
      ref: 'origin/eMeal-server',
      repo: 'git@github.com:eMilestoneLabs/eMeal-server.git',
      path: '/home/emeal/eMeal-server',
      'post-deploy': 'bash deploy/deploy.sh',
      env: {
        NODE_ENV: 'production',
      },
    },
  },
};
