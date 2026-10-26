#!/usr/bin/env bash
# Local app control for the self-test (the real harness boots apps itself).
#   app.sh start <workdir> <api_port> <web_port> <db_path> <log>   -> waits until both ports answer
#   app.sh stop  <api_port> <web_port>
set -u
NODE22="$HOME/.nvm/versions/node/v22.23.3/bin"
[ -d "$NODE22" ] && export PATH="$NODE22:$PATH"

kill_ports() {
  for port in "$@"; do
    pids=$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
  done
}

http_up() {
  code=$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$1" 2>/dev/null)
  [ -n "$code" ] && [ "$code" != "000" ]
}

case "${1:-}" in
  start)
    WORKDIR=$2 API_PORT=$3 WEB_PORT=$4 DB_PATH=$5 LOG=$6
    kill_ports "$API_PORT" "$WEB_PORT"
    mkdir -p "$(dirname "$DB_PATH")" "$(dirname "$LOG")"
    (cd "$WORKDIR" && API_PORT=$API_PORT WEB_PORT=$WEB_PORT DB_PATH=$DB_PATH TZ=UTC \
      exec perl -e 'setpgrp(0, 0); exec @ARGV or die "exec failed: $!"' pnpm dev) >"$LOG" 2>&1 </dev/null &
    deadline=$(($(date +%s) + 120))
    while [ "$(date +%s)" -lt "$deadline" ]; do
      if http_up "http://localhost:$WEB_PORT/" && http_up "http://localhost:$API_PORT/api/health"; then sleep 1; exit 0; fi
      sleep 1
    done
    echo "app did not start; see $LOG" >&2; exit 1 ;;
  stop)
    kill_ports "$2" "$3"; sleep 1; kill_ports "$2" "$3"; exit 0 ;;
  *) echo "usage: $0 start|stop ..." >&2; exit 64 ;;
esac
