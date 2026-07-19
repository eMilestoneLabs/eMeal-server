#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# enable-kernel-accept.sh — OPT-IN tail-latency fix: take the PM2 daemon OUT
# of the TCP accept path.
#
# WHY (2026-07-19 p95/max forensics):
#   ecosystem.config.js runs emeal-server in PM2 CLUSTER mode. Node's cluster
#   default on Linux is SCHED_RR: the cluster MASTER — which is the PM2 God
#   daemon itself — accept()s EVERY incoming connection on :3000 and passes
#   the socket to a worker over IPC. The same single daemon also consumes the
#   stdout/stderr pipes of all 6 managed processes (JSON log streaming) and
#   serves every `pm2 jlist` RPC the monitoring stack and audit scripts issue.
#   On a shared-vCPU box under load, the daemon being off-CPU for 100–400ms
#   delays new connections for ALL workers at once — which is exactly the
#   observed audit signature: synchronized, ROTATING p95/max spikes across
#   unrelated endpoints (even the memory-cached /health hit max=427ms) while
#   every endpoint's min stays 7–31ms.
#
#   NODE_CLUSTER_SCHED_POLICY=none switches Node cluster to kernel-level
#   accept distribution: each worker accepts directly from the shared listen
#   socket — no daemon hop, no IPC handle-pass, nothing user-space between
#   SYN and the worker's event loop.
#
# TRADE-OFF (why this is opt-in, not default): with kernel distribution the
#   connection spread across workers can be less even under LOW concurrency
#   (whichever worker polls first wins). Throughput and correctness are
#   unaffected; per-worker Redis/warmup caches are already per-worker.
#
# The env var must be present in the DAEMON's environment before it forks
# workers — per-app `env:` in ecosystem.config.js CANNOT do this. So this
# script edits the pm2 systemd unit and restarts the daemon (≈10s downtime;
# run off-peak). Fully reversible.
#
# USAGE (on the VPS):
#   bash deploy/enable-kernel-accept.sh            # dry-run: show current state
#   sudo bash deploy/enable-kernel-accept.sh --apply
#   sudo bash deploy/enable-kernel-accept.sh --revert
#
# NOTE: the health-alert auto-heal cron may observe 1 failed check during the
# restart window — that is expected and below AUTOHEAL_MIN_FAILS.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

LINE="Environment=NODE_CLUSTER_SCHED_POLICY=none"
HEALTH="${HEALTH:-http://localhost:3000/api/v1/health}"
UNIT="${UNIT:-}"

# Auto-locate the pm2 resurrect unit (name depends on the user pm2 startup ran for).
if [ -z "$UNIT" ]; then
  for u in /etc/systemd/system/pm2-*.service; do
    [ -e "$u" ] && grep -q 'pm2' "$u" && UNIT="$u" && break
  done
fi
[ -n "$UNIT" ] && [ -f "$UNIT" ] || { echo "✗ pm2 systemd unit not found (set UNIT=/path/to/pm2-<user>.service)"; exit 1; }
SVC="$(basename "$UNIT" .service)"
BAK="$UNIT.bak-kernel-accept"

# pm2 lives under the app user's nvm prefix, so root's PATH (sudo) can't see
# it — the 2026-07-19 live run died at `pm2: command not found` AFTER editing
# the unit. Resolve the binary + user + PM2_HOME from the unit file itself
# (pm2 startup writes its full path into ExecStart and its env into
# Environment=), and run every pm2 command as that user.
PM2_USER="$(grep -oP '^User=\K.*' "$UNIT" | head -1 || true)"
PM2_USER="${PM2_USER:-$(id -un)}"
PM2_BIN="$(grep -oP '^ExecStart=\K\S+' "$UNIT" | head -1 || true)"
[ -n "$PM2_BIN" ] && [ -x "$PM2_BIN" ] || PM2_BIN="$(command -v pm2 || true)"
[ -n "$PM2_BIN" ] || { echo "✗ pm2 binary not found (not in ExecStart of $UNIT nor in PATH)"; exit 1; }
PM2_HOME_ENV="$(grep -oP '^Environment=PM2_HOME=\K.*' "$UNIT" | head -1 || true)"
PM2_HOME_ENV="${PM2_HOME_ENV:-$(getent passwd "$PM2_USER" | cut -d: -f6)/.pm2}"

pm2_run() {
  if [ "$(id -u)" = 0 ] && [ "$PM2_USER" != root ]; then
    runuser -u "$PM2_USER" -- env PM2_HOME="$PM2_HOME_ENV" "$PM2_BIN" "$@"
  else
    PM2_HOME="$PM2_HOME_ENV" "$PM2_BIN" "$@"
  fi
}

daemon_pid() { pgrep -f 'PM2 .*God Daemon' | head -1 || true; }

show_state() {
  echo "── current state ──"
  echo "  unit: $UNIT"
  if grep -qF "$LINE" "$UNIT"; then echo "  unit file: kernel accept ENABLED ($LINE present)"
  else echo "  unit file: kernel accept DISABLED (daemon is the accept broker — SCHED_RR)"; fi
  local pid; pid="$(daemon_pid)"
  if [ -n "$pid" ] && [ -r "/proc/$pid/environ" ]; then
    if tr '\0' '\n' < "/proc/$pid/environ" | grep -q '^NODE_CLUSTER_SCHED_POLICY=none$'; then
      echo "  running daemon (pid $pid): kernel accept ACTIVE"
    else
      echo "  running daemon (pid $pid): SCHED_RR active (env not set — restart required after --apply)"
    fi
  else
    echo "  running daemon: not found / environ unreadable (run as root for the live check)"
  fi
}

wait_health() {
  echo "  ⏳ waiting for $HEALTH …"
  local i
  for i in $(seq 1 30); do
    if curl -sf -o /dev/null --max-time 3 "$HEALTH"; then echo "  ✓ health 200 after ~$((i*2))s"; return 0; fi
    sleep 2
  done
  echo "  ✗ health did not return 200 within 60s — check: pm2 list && pm2 logs emeal-server --lines 50"
  return 1
}

restart_daemon() {
  # Fresh dump so the resurrect after the daemon restart restores EXACTLY the
  # current process list (web tier + worker tier).
  echo "  → pm2 save (snapshot current process list; as $PM2_USER via $PM2_BIN)"
  pm2_run save
  echo "  → pm2 kill (stop daemon + apps; ≈10s downtime starts now)"
  pm2_run kill
  echo "  → systemctl daemon-reload && systemctl restart $SVC (daemon restarts with new env, resurrects apps)"
  systemctl daemon-reload
  systemctl restart "$SVC"
  wait_health
}

case "${1:-}" in
  --apply)
    [ "$(id -u)" = 0 ] || { echo "✗ --apply needs sudo (edits $UNIT)"; exit 1; }
    if grep -qF "$LINE" "$UNIT"; then
      echo "already enabled in unit file — nothing to write"
    else
      cp -a "$UNIT" "$BAK"
      echo "  backup: $BAK"
      sed -i "/^\[Service\]/a $LINE" "$UNIT"
      grep -qF "$LINE" "$UNIT" || { echo "✗ failed to insert env line — restoring backup"; cp -a "$BAK" "$UNIT"; exit 1; }
      echo "  ✓ inserted: $LINE"
    fi
    restart_daemon
    show_state
    echo "── next ── benchmark on a calm box to compare tails: bash deploy/run.sh --benchmark --yes"
    ;;
  --revert)
    [ "$(id -u)" = 0 ] || { echo "✗ --revert needs sudo (edits $UNIT)"; exit 1; }
    if grep -qF "$LINE" "$UNIT"; then
      sed -i "\|^$LINE\$|d" "$UNIT"
      echo "  ✓ removed: $LINE"
    else
      echo "env line not present in unit file — nothing to remove"
    fi
    restart_daemon
    show_state
    ;;
  *)
    show_state
    echo
    echo "dry-run only. sudo bash $0 --apply   |   sudo bash $0 --revert"
    ;;
esac
