#!/usr/bin/env bash
# start-daemon.sh — start the resident driver on 127.0.0.1:${DRIVER_PORT:-8899}.
#
# Credentials are read from the environment (STRONGHOLD_AUTH_USER / STRONGHOLD_AUTH_PASSWORD, or the
# repository's .env). If they are not already there, one of these can supply them WITHOUT ever writing
# them to disk:
#
#   SP_AUTH_ENV_FILE   a local file containing shell assignments, e.g. SP_AUTH_USER=... / SP_AUTH_PASSWORD=...
#   SP_AUTH_ENV_CMD    a command whose stdout is such assignments, e.g. an ssh + cat of a server-side file
#
# Those assignments use the game server's own names (SP_AUTH_*, as in its service environment), so they
# are handed to the MCP under the names it reads (STRONGHOLD_AUTH_*). Both are optional: an open server
# that needs no login works with no credentials at all.
set -euo pipefail
cd "$(dirname "$0")"

if [ -z "${STRONGHOLD_AUTH_USER:-}" ] && [ -z "${SP_AUTH_USER:-}" ]; then
  if [ -n "${SP_AUTH_ENV_FILE:-}" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$SP_AUTH_ENV_FILE"
    set +a
  elif [ -n "${SP_AUTH_ENV_CMD:-}" ]; then
    set -a
    # shellcheck disable=SC1090
    source <(eval "$SP_AUTH_ENV_CMD")
    set +a
  fi
fi

if [ -z "${STRONGHOLD_AUTH_USER:-}" ] && [ -n "${SP_AUTH_USER:-}" ]; then
  export STRONGHOLD_AUTH_USER="$SP_AUTH_USER" STRONGHOLD_AUTH_PASSWORD="${SP_AUTH_PASSWORD:-}"
fi
unset SP_AUTH_USER SP_AUTH_PASSWORD

exec node drive-daemon.mjs
