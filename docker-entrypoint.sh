#!/bin/sh
# Runs as root ONLY long enough to make the bind-mounted data volume writable by the
# unprivileged `node` user, then drops privileges for the actual process.
#
# Why: /app/data is a host bind mount (/opt/stack/atenu-live/data). Files written by the
# old root-running container (atenu.db, -wal, -shm) are root-owned; without this step the
# server would start, fail to open the DB read-write, and crash-loop.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data
  chown -R node:node /app/data
  exec su-exec node "$@"
fi
exec "$@"
