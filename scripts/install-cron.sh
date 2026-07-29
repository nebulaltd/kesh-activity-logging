#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${PULL_ENV_FILE:-$PROJECT_DIR/.env}"
MARKER='# kesh-activity-logging:pull'
PULL_SCRIPT="$SCRIPT_DIR/pull-activity-logs.sh"
CRON_LOG="${PULL_CRON_LOG:-$PROJECT_DIR/logs/activity-log-pull-cron.log}"

usage() {
    cat <<'EOF'
Usage: install-cron.sh [install|remove|show]

Installs the activity log pull cron entry. The schedule comes from
LOG_PULL_CRON_SCHEDULE in the env file (default "*/5 * * * *").

Re-running install replaces the existing entry, so it is safe to run
after changing the schedule.
EOF
}

read_env_value() {
    local key="$1"
    [ -f "$ENV_FILE" ] || return 0
    sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=[[:space:]]*(.*)\$/\\2/p" "$ENV_FILE" | tail -n 1
}

load_schedule() {
    local value
    value="$(read_env_value LOG_PULL_CRON_SCHEDULE)"
    value="${value%\"}"
    value="${value#\"}"
    value="${value%\'}"
    value="${value#\'}"

    printf '%s' "${value:-*/5 * * * *}"
}

current_crontab() {
    crontab -l 2>/dev/null || true
}

without_entry() {
    current_crontab | grep -Fv "$MARKER" || true
}

write_crontab() {
    local content="$1"
    local tmp
    local status
    tmp="$(mktemp)"
    [ -n "$content" ] && printf '%s\n' "$content" >"$tmp"
    crontab "$tmp"
    status=$?
    rm -f "$tmp"
    return $status
}

install_entry() {
    local schedule
    schedule="$(load_schedule)"

    if [ "$(printf '%s' "$schedule" | awk '{print NF}')" -ne 5 ]; then
        printf 'error: LOG_PULL_CRON_SCHEDULE must have 5 fields, got "%s"\n' "$schedule" >&2
        printf 'hint: quote it in %s, e.g. LOG_PULL_CRON_SCHEDULE="*/5 * * * *"\n' "$ENV_FILE" >&2
        return 1
    fi

    if [ ! -x "$PULL_SCRIPT" ]; then
        printf 'error: %s is not executable\n' "$PULL_SCRIPT" >&2
        return 1
    fi

    local entry="$schedule cd $PROJECT_DIR && $PULL_SCRIPT >>$CRON_LOG 2>&1 $MARKER"

    mkdir -p "$(dirname "$CRON_LOG")"

    local kept
    kept="$(without_entry)"

    if ! write_crontab "$(printf '%s\n%s' "$kept" "$entry" | grep -v '^[[:space:]]*$')"; then
        printf 'error: failed to install crontab entry\n' >&2
        return 1
    fi

    printf 'installed: %s\n' "$entry"
}

remove_entry() {
    local kept
    kept="$(without_entry | grep -v '^[[:space:]]*$' || true)"

    if ! write_crontab "$kept"; then
        printf 'error: failed to update crontab\n' >&2
        return 1
    fi

    printf 'removed entries marked %s\n' "$MARKER"
}

show_entry() {
    local found
    found="$(current_crontab | grep -F "$MARKER" || true)"

    if [ -z "$found" ]; then
        printf 'no cron entry installed\n'
        return 0
    fi

    printf '%s\n' "$found"
}

case "${1:-install}" in
    install) install_entry ;;
    remove) remove_entry ;;
    show) show_entry ;;
    -h | --help | help) usage ;;
    *)
        usage >&2
        exit 1
        ;;
esac
