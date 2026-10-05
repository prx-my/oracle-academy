#!/usr/bin/env bash
set -e

# Ensure the profile volume exists and is writable.
mkdir -p "${ORACLE_ACADEMY_PROFILE:-/data/profile}"

cat <<'BANNER'
oracle-academy container
  VNC (login browser):  http://localhost:6080/vnc.html
  Run commands with:    docker compose exec app oracle-academy <command>

  First run:  oracle-academy login   (then sign in via the VNC page)
BANNER

# supervisord runs in the foreground (nodaemon=true) and keeps the display,
# VNC and noVNC alive; the shared browser is spawned on demand by the CLI.
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/oracle-academy.conf
