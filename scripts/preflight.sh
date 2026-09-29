#!/usr/bin/env bash
# Checks every link in the activity-log pipeline and names the first one that is broken.
# Read-only: opens no tunnel, writes no rows, changes no config.
#
#   scripts/preflight.sh            # check everything reachable right now
#   scripts/preflight.sh --tunnel   # open the SSH tunnel first, then check, then close it
#
# Exit 0 = the pipeline can run. Exit 1 = at least one blocking problem, reported below.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${PULL_ENV_FILE:-$PROJECT_DIR/.env}"
PULL_LOG_FILE="${PULL_LOG_DIR:-$PROJECT_DIR/logs}/activity-log-pull.log"

WITH_TUNNEL=""
[ "${1:-}" = "--tunnel" ] && WITH_TUNNEL="yes"

FAILURES=0
WARNINGS=0
declare -a ACTIONS=()
TUNNEL_PID=""

pass() { printf '  \033[32mok\033[0m    %s\n' "$1"; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$1"; WARNINGS=$((WARNINGS + 1)); }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
note() { printf '        %s\n' "$1"; }
step() { printf '\n%s\n' "$1"; }
action() { ACTIONS+=("$1"); }

mask() {
    local value="$1"
    local length=${#value}
    [ "$length" -eq 0 ] && { printf '(empty)'; return; }
    printf '%s… (%s chars)' "${value:0:4}" "$length"
}

cleanup() {
    if [ -n "$TUNNEL_PID" ] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
        kill "$TUNNEL_PID" 2>/dev/null
        wait "$TUNNEL_PID" 2>/dev/null
        note "closed SSH tunnel (pid $TUNNEL_PID)"
    fi
}
trap cleanup EXIT

port_open() {
    local host="$1" port="$2"
    if command -v nc >/dev/null 2>&1; then
        nc -z -w 3 "$host" "$port" >/dev/null 2>&1
        return $?
    fi
    (exec 3<>"/dev/tcp/$host/$port") >/dev/null 2>&1
}

# -init /dev/null skips ~/.sqliterc, whose .headers/.mode would leak into captured values.
sqlite() { sqlite3 -init /dev/null "$@"; }

printf '=== activity-log pipeline preflight on %s ===\n' "$(hostname)"

# ---------------------------------------------------------------- 1. environment
step '1. environment file'
if [ ! -f "$ENV_FILE" ]; then
    fail "env file not found: $ENV_FILE"
    action "create $ENV_FILE (copy .env.example) and re-run"
    exit 1
fi
pass "found $ENV_FILE"

RAW_API_KEY_LINE="$(grep -m1 '^API_KEY=' "$ENV_FILE" 2>/dev/null || true)"
# -u would abort here on an unset $NAME inside the file; tolerate it so step 4 can
# report the mangled value instead of the script dying with "unbound variable".
set -a -f +u
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a +f -u
pass 'sourced without aborting'

# ---------------------------------------------------------------- 2. bun
step '2. bun executable'
BUN_RESOLVED=""
if [ -n "${BUN_BIN:-}" ] && [ -x "${BUN_BIN:-}" ]; then
    BUN_RESOLVED="$BUN_BIN"
    pass "BUN_BIN=$BUN_BIN"
elif BUN_RESOLVED="$(command -v bun 2>/dev/null)" && [ -n "$BUN_RESOLVED" ]; then
    if [ -z "${BUN_BIN:-}" ]; then
        warn "bun found on PATH at $BUN_RESOLVED, but BUN_BIN is unset"
        note 'cron does not inherit your shell PATH; the scheduled pull will fail'
        action "set BUN_BIN=$BUN_RESOLVED in $ENV_FILE"
    else
        pass "bun at $BUN_RESOLVED"
    fi
else
    fail 'bun not found'
    action 'install bun and set BUN_BIN to its absolute path'
    exit 1
fi

# ---------------------------------------------------------------- 3. archive database
step '3. archive database'
DB_PATH="${DATABASE_PATH:-./data/logs.db}"
case "$DB_PATH" in
    /*) pass "DATABASE_PATH is absolute: $DB_PATH" ;;
    :memory:) fail 'DATABASE_PATH is :memory: — nothing is persisted'; action 'point DATABASE_PATH at a file under shared/' ;;
    *)
        warn "DATABASE_PATH is relative: $DB_PATH"
        note 'it resolves against the process working directory, so a release-based deploy'
        note 'silently starts a new empty database on every deploy'
        action "make DATABASE_PATH absolute, e.g. $PROJECT_DIR/shared/logs.db"
        ;;
esac

if [ ! -f "$DB_PATH" ]; then
    warn "database file does not exist yet: $DB_PATH"
    action 'run: bun run db:migrate'
elif ! command -v sqlite3 >/dev/null 2>&1; then
    warn 'sqlite3 CLI not installed; skipping database inspection'
else
    MIGRATIONS="$(sqlite -readonly "$DB_PATH" "SELECT group_concat(id,' ') FROM _migrations;" 2>/dev/null || true)"
    if [ -z "$MIGRATIONS" ]; then
        fail 'no _migrations rows — schema not applied'
        action 'run: bun run db:migrate'
    else
        pass "migrations: $MIGRATIONS"
        case "$MIGRATIONS" in
            *0003_remote_log_dedup.sql*) : ;;
            *) fail 'migration 0003 missing — inserts will fail with "no column named remote_source"'
               action 'run: bun run db:migrate' ;;
        esac
    fi

    ROWS="$(sqlite -readonly "$DB_PATH" 'SELECT count(*) FROM logs;' 2>/dev/null || echo '?')"
    NEWEST="$(sqlite -readonly "$DB_PATH" "SELECT COALESCE(datetime(max(timestamp)/1000,'unixepoch','localtime'),'never') FROM logs;" 2>/dev/null || echo '?')"
    LAST_PULL="$(sqlite -readonly "$DB_PATH" "SELECT COALESCE(datetime(max(timestamp)/1000,'unixepoch','localtime'),'never') FROM logs WHERE action='pull_run';" 2>/dev/null || echo '?')"
    note "rows=$ROWS  newest_event=$NEWEST  last_successful_pull=$LAST_PULL"

    if sqlite "$DB_PATH" 'BEGIN IMMEDIATE; ROLLBACK;' >/dev/null 2>&1; then
        pass "writable by $(whoami)"
    else
        fail "cannot acquire a write lock on $DB_PATH as $(whoami)"
        action 'fix ownership/permissions on the file and its directory'
    fi
fi

# ---------------------------------------------------------------- 4. inbound API key
step '4. inbound API_KEY'
if [ -z "${API_KEY:-}" ]; then
    fail 'API_KEY is empty or unset — the service will refuse to start'
    action "set API_KEY in $ENV_FILE"
else
    LITERAL="${RAW_API_KEY_LINE#API_KEY=}"
    LITERAL="${LITERAL%\"}"; LITERAL="${LITERAL#\"}"
    LITERAL="${LITERAL%\'}"; LITERAL="${LITERAL#\'}"
    LITERAL="${LITERAL//\\\$/\$}"   # \$ is the correct escape; compare against its intended value
    if [ "$LITERAL" != "$API_KEY" ]; then
        fail "API_KEY is being expanded: file says $(mask "$LITERAL"), process gets $(mask "$API_KEY")"
        note 'an unescaped $ in the value is expanded away, so every client gets 401'
        action 'escape each $ in API_KEY as \$ in the env file'
    else
        pass "value survives parsing intact: $(mask "$API_KEY")"
    fi
fi

# ---------------------------------------------------------------- 5. resolved pull config
step '5. pull configuration'
CONFIG_JSON="$(cd "$PROJECT_DIR" && "$BUN_RESOLVED" -e '
import { loadConfig } from "./src/config";
try {
  const c = loadConfig();
  console.log(JSON.stringify({ ok: true, mode: c.LOG_PULL_MODE, batch: c.LOG_PULL_BATCH_SIZE,
    iterations: c.LOG_PULL_MAX_ITERATIONS, interval: c.LOG_PULL_INTERVAL_MS,
    sources: c.LOG_PULL_SOURCES }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }));
}' 2>/dev/null)"

if [ -z "$CONFIG_JSON" ]; then
    fail 'could not evaluate the service configuration'
    action 'run from the project directory: bun run src/index.ts (and read the error)'
    CONFIG_OK=""
else
    CONFIG_OK="$(printf '%s' "$CONFIG_JSON" | sed -n 's/.*"ok":\([a-z]*\).*/\1/p')"
fi

if [ "$CONFIG_OK" = "false" ]; then
    fail "config rejected: $(printf '%s' "$CONFIG_JSON" | sed -n 's/.*"message":"\([^"]*\)".*/\1/p')"
    action 'fix the reported variable in the env file'
elif [ "$CONFIG_OK" = "true" ]; then
    MODE="$(printf '%s' "$CONFIG_JSON" | sed -n 's/.*"mode":"\([^"]*\)".*/\1/p')"
    SOURCE_COUNT="$(printf '%s' "$CONFIG_JSON" | grep -o '"name":' | wc -l | tr -d ' ')"
    case "$MODE" in
        off)
            fail 'LOG_PULL_MODE=off — nothing will ever pull'
            note 'this alone is enough to keep the archive permanently empty'
            action "set LOG_PULL_MODE=oneshot in $ENV_FILE (cron-driven) or interval (in-process)"
            ;;
        oneshot) pass 'LOG_PULL_MODE=oneshot — pulls come from scripts/pull-activity-logs.sh' ;;
        interval) pass 'LOG_PULL_MODE=interval — the running server pulls itself' ;;
    esac
    if [ "$SOURCE_COUNT" -eq 0 ]; then
        fail 'no pull sources configured'
        action "set LOG_PULL_SOURCE_1_NAME/_URL/_API_KEY in $ENV_FILE"
    else
        pass "$SOURCE_COUNT source(s) configured"
    fi
fi

# ---------------------------------------------------------------- 6. tunnel
step '6. SSH tunnel'
LOCAL_PORT="${PULL_SSH_LOCAL_PORT:-5055}"
if [ -z "${PULL_SSH_HOST:-}" ]; then
    warn 'PULL_SSH_HOST is unset — assuming kesh-back is reachable directly'
elif port_open 127.0.0.1 "$LOCAL_PORT"; then
    pass "127.0.0.1:$LOCAL_PORT already reachable (tunnel up or port in use)"
elif [ -n "$WITH_TUNNEL" ]; then
    note "opening tunnel 127.0.0.1:$LOCAL_PORT -> ${PULL_SSH_REMOTE_HOST:-127.0.0.1}:${PULL_SSH_REMOTE_PORT:-5050} via ${PULL_SSH_USER:-forge}@$PULL_SSH_HOST"
    ssh -N -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new \
        -o ConnectTimeout=10 ${PULL_SSH_KEY:+-i "$PULL_SSH_KEY"} \
        ${PULL_SSH_PORT:+-p "$PULL_SSH_PORT"} \
        -L "$LOCAL_PORT:${PULL_SSH_REMOTE_HOST:-127.0.0.1}:${PULL_SSH_REMOTE_PORT:-5050}" \
        "${PULL_SSH_USER:-forge}@$PULL_SSH_HOST" &
    TUNNEL_PID=$!
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        port_open 127.0.0.1 "$LOCAL_PORT" && break
        sleep 1
    done
    if port_open 127.0.0.1 "$LOCAL_PORT"; then
        pass "tunnel established on 127.0.0.1:$LOCAL_PORT"
    else
        fail 'tunnel did not come up'
        action 'check PULL_SSH_HOST/USER/KEY and that the key has no passphrase'
    fi
else
    fail "127.0.0.1:$LOCAL_PORT is not reachable — tunnel is down"
    action 'run: scripts/preflight.sh --tunnel   (or: scripts/pull-activity-logs.sh tunnel-test)'
fi

# ---------------------------------------------------------------- 7. kesh-back outbox
step '7. kesh-back outbox endpoint'
if [ "$CONFIG_OK" != "true" ] || [ "${SOURCE_COUNT:-0}" -eq 0 ]; then
    warn 'skipped — no usable source configuration'
elif ! command -v curl >/dev/null 2>&1; then
    warn 'curl not installed; skipping the endpoint probe'
else
    INDEX=0
    while :; do
        URL="$(printf '%s' "$CONFIG_JSON" | "$BUN_RESOLVED" -e "
          const c = JSON.parse(await Bun.stdin.text());
          const s = c.sources[$INDEX];
          if (!s) process.exit(3);
          console.log(s.name); console.log(s.url); console.log(s.apiKey);" 2>/dev/null)" || break
        [ -z "$URL" ] && break
        NAME="$(printf '%s\n' "$URL" | sed -n 1p)"
        SRC_URL="$(printf '%s\n' "$URL" | sed -n 2p)"
        SRC_KEY="$(printf '%s\n' "$URL" | sed -n 3p)"

        BODY_FILE="$(mktemp)"
        ERR_FILE="$(mktemp)"
        CODE="$(curl -sS -o "$BODY_FILE" -w '%{http_code}' --max-time 15 \
            -H "x-internal-api-key: $SRC_KEY" "${SRC_URL}?limit=1" 2>"$ERR_FILE" || true)"
        CODE="${CODE:-000}"; CODE="${CODE: -3}"   # curl still writes a code when it fails
        case "$CODE" in
            200)
                ITEMS="$(grep -o '"id"' "$BODY_FILE" | wc -l | tr -d ' ')"
                pass "$NAME: HTTP 200, $ITEMS undelivered row(s) in this probe"
                [ "$ITEMS" = "0" ] && note 'outbox is empty right now — nothing pending to pull'
                ;;
            401)
                fail "$NAME: HTTP 401 — key rejected"
                note 'either ACTIVITY_LOG_INTERNAL_API_KEY is unset on kesh-back, or it differs'
                note "from LOG_PULL_SOURCE_<n>_API_KEY here (this side sends $(mask "$SRC_KEY"))"
                action "set ACTIVITY_LOG_INTERNAL_API_KEY on kesh-back to the same value, then restart it"
                ;;
            404)
                fail "$NAME: HTTP 404 — wrong path"
                note "probed ${SRC_URL}?limit=1"
                action 'the path must be /internal/activity-logs on the kesh-back host'
                ;;
            000)
                fail "$NAME: connection failed"
                note "probed ${SRC_URL}?limit=1"
                [ -s "$ERR_FILE" ] && note "$(head -c 300 "$ERR_FILE")"
                if [ -n "${PULL_SSH_HOST:-}" ]; then
                    action 'bring the tunnel up first: scripts/preflight.sh --tunnel'
                else
                    action "this host cannot reach ${SRC_URL%%/internal/*} — check DNS and outbound firewall"
                fi
                ;;
            *)
                fail "$NAME: HTTP $CODE"
                note "$(head -c 200 "$BODY_FILE")"
                ;;
        esac
        rm -f "$BODY_FILE" "$ERR_FILE"
        INDEX=$((INDEX + 1))
    done
fi

# ---------------------------------------------------------------- 8. query API
step '8. query API on this host'
API_PORT="${PORT:-3000}"
if ! command -v curl >/dev/null 2>&1; then
    warn 'curl not installed; skipping'
elif ! port_open 127.0.0.1 "$API_PORT"; then
    warn "nothing listening on 127.0.0.1:$API_PORT — the service is not running"
    note 'not required for pulling; only for querying the archive'
else
    HEALTH="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$API_PORT/health" 2>/dev/null || true)"
    HEALTH="${HEALTH:-000}"; HEALTH="${HEALTH: -3}"
    [ "$HEALTH" = "200" ] && pass 'GET /health → 200' || fail "GET /health → $HEALTH"
    AUTH="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 \
        -H "x-api-key: ${API_KEY:-}" "http://127.0.0.1:$API_PORT/logs?limit=1" 2>/dev/null || true)"
    AUTH="${AUTH:-000}"; AUTH="${AUTH: -3}"
    case "$AUTH" in
        200) pass 'GET /logs with API_KEY → 200' ;;
        401) fail 'GET /logs with API_KEY → 401 — the running process holds a different key'
             note 'it was started before the current env file, or the value is being expanded'
             action 'restart the background process, then re-run this check' ;;
        *)   fail "GET /logs → $AUTH" ;;
    esac
fi

# ---------------------------------------------------------------- 9. schedule
step '9. schedule'
if crontab -l 2>/dev/null | grep -q 'pull-activity-logs.sh'; then
    pass 'cron entry installed'
    crontab -l 2>/dev/null | grep 'pull-activity-logs.sh' | while IFS= read -r line; do note "$line"; done
else
    if [ "${MODE:-}" = "oneshot" ]; then
        fail 'LOG_PULL_MODE=oneshot but no cron entry calls pull-activity-logs.sh'
        action 'run: scripts/install-cron.sh install'
    else
        warn 'no cron entry (fine for interval mode)'
    fi
fi

if [ -f "$PULL_LOG_FILE" ]; then
    note "last lines of $PULL_LOG_FILE:"
    tail -n 3 "$PULL_LOG_FILE" | while IFS= read -r line; do note "  $line"; done
elif [ "${LAST_PULL:-never}" != "never" ] && [ "${LAST_PULL:-}" != "?" ]; then
    note "no pull log at $PULL_LOG_FILE yet — logs/ is per release, so a deploy starts it empty;"
    note "the next cron run recreates it (last successful pull: $LAST_PULL)"
else
    note "no pull log at $PULL_LOG_FILE — the wrapper has never run"
fi

# ---------------------------------------------------------------- 10. archive sync
step '10. archive sync target'
if [ -z "${ARCHIVE_SYNC_HOST:-}" ]; then
    note 'ARCHIVE_SYNC_HOST unset — archive is not copied anywhere (optional)'
elif [ -z "${ARCHIVE_SYNC_USER:-}" ] || [ -z "${ARCHIVE_SYNC_PATH:-}" ]; then
    fail 'ARCHIVE_SYNC_HOST is set but ARCHIVE_SYNC_USER or ARCHIVE_SYNC_PATH is empty'
    action "set ARCHIVE_SYNC_USER and ARCHIVE_SYNC_PATH in $ENV_FILE"
else
    SYNC_TARGET="$ARCHIVE_SYNC_USER@$ARCHIVE_SYNC_HOST"
    SYNC_DIR="$(dirname "$ARCHIVE_SYNC_PATH")"
    SYNC_OUT="$(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 \
        ${ARCHIVE_SYNC_KEY:+-i "$ARCHIVE_SYNC_KEY"} ${ARCHIVE_SYNC_PORT:+-p "$ARCHIVE_SYNC_PORT"} \
        "$SYNC_TARGET" "test -d $(printf '%q' "$SYNC_DIR") && test -w $(printf '%q' "$SYNC_DIR") && echo writable" 2>&1)"
    case "$SYNC_OUT" in
        *writable) pass "$SYNC_TARGET: $SYNC_DIR exists and is writable" ;;
        *'Permission denied'*)
            fail "$SYNC_TARGET: SSH key rejected"
            action "add $(whoami)'s public key (~/.ssh/id_*.pub) to $ARCHIVE_SYNC_USER@$ARCHIVE_SYNC_HOST:~/.ssh/authorized_keys"
            ;;
        '')
            fail "$SYNC_TARGET: $SYNC_DIR is missing or not writable by $ARCHIVE_SYNC_USER"
            action "on $ARCHIVE_SYNC_HOST: mkdir -p $SYNC_DIR (as $ARCHIVE_SYNC_USER)"
            ;;
        *)
            fail "$SYNC_TARGET: $(printf '%s' "$SYNC_OUT" | head -c 200)"
            action "check that $(hostname) can reach $ARCHIVE_SYNC_HOST on SSH"
            ;;
    esac
fi

# ---------------------------------------------------------------- verdict
printf '\n=== verdict: %s failure(s), %s warning(s) ===\n' "$FAILURES" "$WARNINGS"
if [ "${#ACTIONS[@]}" -gt 0 ]; then
    printf 'do this next:\n'
    INDEX=1
    for item in "${ACTIONS[@]}"; do
        printf '  %s. %s\n' "$INDEX" "$item"
        INDEX=$((INDEX + 1))
    done
fi
[ "$FAILURES" -eq 0 ] || exit 1
printf 'pipeline is ready — run: scripts/pull-activity-logs.sh\n'
