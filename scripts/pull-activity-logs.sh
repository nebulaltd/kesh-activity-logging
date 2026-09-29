#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${PULL_ENV_FILE:-$PROJECT_DIR/.env}"
LOG_DIR="${PULL_LOG_DIR:-$PROJECT_DIR/logs}"
LOG_FILE="$LOG_DIR/activity-log-pull.log"
LOCK_DIR="${PULL_LOCK_DIR:-$PROJECT_DIR/.pull.lock}"
LOG_RETENTION_DAYS="${PULL_LOG_RETENTION_DAYS:-30}"

SSH_TUNNEL_PID=""
LOCK_ACQUIRED=""

mkdir -p "$LOG_DIR"

log_message() {
    local level="$1"
    local message="$2"
    printf '[%s] [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$level" "$message" | tee -a "$LOG_FILE"
}

send_notification() {
    local status="$1"
    local message="$2"

    log_message "INFO" "Notification: $status - $message"

    if [ -z "${PULL_ALERT_EMAIL:-}" ]; then
        log_message "WARN" "PULL_ALERT_EMAIL is not set; failure alerting is disabled"
        return 0
    fi

    local subject="[kesh-activity-logging] activity log pull $status on $(hostname)"
    local body
    body="$message

Host: $(hostname)
Log:  $LOG_FILE

$(tail -n 30 "$LOG_FILE" 2>/dev/null)"

    if command -v mail >/dev/null 2>&1; then
        printf '%s\n' "$body" | mail -s "$subject" "$PULL_ALERT_EMAIL" &&
            log_message "INFO" "Alert email sent to $PULL_ALERT_EMAIL" ||
            log_message "ERROR" "Failed to send alert email via mail"
        return 0
    fi

    if command -v sendmail >/dev/null 2>&1; then
        printf 'To: %s\nSubject: %s\n\n%s\n' "$PULL_ALERT_EMAIL" "$subject" "$body" | sendmail -t &&
            log_message "INFO" "Alert email sent to $PULL_ALERT_EMAIL" ||
            log_message "ERROR" "Failed to send alert email via sendmail"
        return 0
    fi

    log_message "ERROR" "Neither mail nor sendmail is available; cannot alert $PULL_ALERT_EMAIL"
}

cleanup() {
    if [ -n "$SSH_TUNNEL_PID" ]; then
        log_message "INFO" "Closing SSH tunnel (pid $SSH_TUNNEL_PID)"
        kill "$SSH_TUNNEL_PID" 2>/dev/null || true
        wait "$SSH_TUNNEL_PID" 2>/dev/null || true
        SSH_TUNNEL_PID=""
    fi

    if [ -n "$LOCK_ACQUIRED" ]; then
        rmdir "$LOCK_DIR" 2>/dev/null || true
        LOCK_ACQUIRED=""
    fi
}

trap cleanup EXIT INT TERM

acquire_lock() {
    if mkdir "$LOCK_DIR" 2>/dev/null; then
        LOCK_ACQUIRED="yes"
        return 0
    fi

    log_message "WARN" "Another pull is already running ($LOCK_DIR exists); skipping this run"
    return 1
}

# Reads the intended value of a key straight from the env file: quotes stripped and the
# correct \$ escape resolved, so it can be compared against what the shell actually parsed.
read_env_literal() {
    local key="$1" value
    value="$(sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=[[:space:]]*(.*)\$/\\2/p" "$ENV_FILE" | tail -n 1)"
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    value="${value//\\\$/\$}"
    printf '%s' "$value"
}

# A bare $ inside an env value is expanded by the shell (and by Bun) before anything sees it,
# silently truncating secrets. Refuse to run on a value that did not survive parsing.
assert_env_intact() {
    local key="$1" literal parsed
    literal="$(read_env_literal "$key")"
    [ -n "$literal" ] || return 0
    parsed="$(eval "printf '%s' \"\${$key:-}\"")"
    if [ "$literal" != "$parsed" ]; then
        log_message "ERROR" "$key was mangled while loading $ENV_FILE (${#literal} chars in the file, ${#parsed} after parsing)"
        log_message "ERROR" "escape every \$ in its value as \\\$ — an unescaped \$NAME expands to nothing"
        return 1
    fi
}

load_env() {
    if [ ! -f "$ENV_FILE" ]; then
        log_message "ERROR" "Env file not found: $ENV_FILE"
        return 1
    fi

    # -u would abort the whole script on an unset $NAME inside the file, before any logging;
    # tolerate it here so the mangled value is reported by assert_env_intact instead.
    set -a -f +u
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a +f -u

    local key status=0
    for key in API_KEY LOG_PULL_API_KEY $(sed -n -E 's/^[[:space:]]*(export[[:space:]]+)?(LOG_PULL_SOURCE_[0-9]+_API_KEY)[[:space:]]*=.*/\2/p' "$ENV_FILE"); do
        assert_env_intact "$key" || status=1
    done
    return "$status"
}

resolve_bun() {
    if [ -n "${BUN_BIN:-}" ] && [ -x "$BUN_BIN" ]; then
        printf '%s' "$BUN_BIN"
        return 0
    fi

    local candidate
    candidate="$(command -v bun 2>/dev/null)"
    if [ -n "$candidate" ]; then
        printf '%s' "$candidate"
        return 0
    fi

    for candidate in "$HOME/.bun/bin/bun" /usr/local/bin/bun /opt/homebrew/bin/bun; do
        if [ -x "$candidate" ]; then
            printf '%s' "$candidate"
            return 0
        fi
    done

    return 1
}

port_is_open() {
    local port="$1"
    (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null && exec 3<&- 2>/dev/null
}

open_ssh_tunnel() {
    if [ -z "${PULL_SSH_HOST:-}" ] || [ -z "${PULL_SSH_USER:-}" ]; then
        log_message "INFO" "PULL_SSH_HOST/PULL_SSH_USER not set; assuming direct network access"
        return 0
    fi

    local local_port="${PULL_SSH_LOCAL_PORT:-5055}"
    local remote_host="${PULL_SSH_REMOTE_HOST:-127.0.0.1}"
    local remote_port="${PULL_SSH_REMOTE_PORT:-5050}"

    if port_is_open "$local_port"; then
        log_message "INFO" "Local port $local_port already reachable; reusing existing tunnel"
        return 0
    fi

    local ssh_args=(-N -o ExitOnForwardFailure=yes -o BatchMode=yes -o ServerAliveInterval=15 -o StrictHostKeyChecking=accept-new)
    if [ -n "${PULL_SSH_KEY:-}" ]; then
        ssh_args+=(-i "$PULL_SSH_KEY")
    fi
    if [ -n "${PULL_SSH_PORT:-}" ]; then
        ssh_args+=(-p "$PULL_SSH_PORT")
    fi

    log_message "INFO" "Opening SSH tunnel 127.0.0.1:$local_port -> $remote_host:$remote_port via $PULL_SSH_USER@$PULL_SSH_HOST"
    ssh "${ssh_args[@]}" -L "$local_port:$remote_host:$remote_port" "$PULL_SSH_USER@$PULL_SSH_HOST" &
    SSH_TUNNEL_PID=$!

    local attempt=0
    while [ "$attempt" -lt 20 ]; do
        if ! kill -0 "$SSH_TUNNEL_PID" 2>/dev/null; then
            log_message "ERROR" "SSH tunnel process exited before becoming ready"
            SSH_TUNNEL_PID=""
            return 1
        fi
        if port_is_open "$local_port"; then
            log_message "INFO" "SSH tunnel ready on 127.0.0.1:$local_port"
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 0.5
    done

    log_message "ERROR" "SSH tunnel did not become ready on 127.0.0.1:$local_port"
    return 1
}

rotate_logs() {
    find "$LOG_DIR" -name 'activity-log-pull.log.*' -type f -mtime "+$LOG_RETENTION_DAYS" -delete 2>/dev/null || true

    local max_bytes=$((10 * 1024 * 1024))
    local size
    size="$(wc -c <"$LOG_FILE" 2>/dev/null | tr -d ' ')"
    if [ -n "$size" ] && [ "$size" -gt "$max_bytes" ]; then
        mv "$LOG_FILE" "$LOG_FILE.$(date '+%Y%m%d%H%M%S')"
    fi
}

main() {
    acquire_lock || exit 0

    log_message "INFO" "=== Activity log pull started ==="

    if ! load_env; then
        send_notification "FAILED" "Could not load env file $ENV_FILE"
        exit 1
    fi

    local bun_bin
    if ! bun_bin="$(resolve_bun)"; then
        log_message "ERROR" "bun not found. Set BUN_BIN to its absolute path (cron does not inherit your shell PATH)."
        send_notification "FAILED" "bun executable not found"
        exit 1
    fi
    log_message "INFO" "Using bun at $bun_bin"

    if ! open_ssh_tunnel; then
        send_notification "FAILED" "Could not establish SSH tunnel to $PULL_SSH_HOST"
        exit 1
    fi

    local output
    local status
    output="$(cd "$PROJECT_DIR" && "$bun_bin" run src/logs/pull-once.ts 2>&1)"
    status=$?

    printf '%s\n' "$output" | while IFS= read -r line; do
        [ -n "$line" ] && log_message "INFO" "pull-once: $line"
    done

    if [ "$status" -eq 0 ]; then
        log_message "INFO" "=== Activity log pull completed ==="
        rotate_logs
        exit 0
    fi

    log_message "ERROR" "=== Activity log pull failed (exit $status) ==="
    send_notification "FAILED" "pull-once exited with status $status"
    rotate_logs
    exit 1
}

case "${1:-}" in
    "tunnel-test")
        load_env || exit 1
        open_ssh_tunnel || exit 1
        log_message "INFO" "Tunnel test succeeded"
        exit 0
        ;;
    *)
        main
        ;;
esac
