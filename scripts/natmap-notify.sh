#!/bin/sh
set -eu

PUBLIC_IP="${1:?missing NATMap public address}"
PUBLIC_PORT="${2:?missing NATMap public port}"
PROTOCOL="${5:-UDP}"
SYNC_URL="${NATMAP_SYNC_URL:-http://192.168.100.101:20080/internal/natmap}"

PAYLOAD="$(printf '{\"ip\":\"%s\",\"port\":%s,\"protocol\":\"%s\"}' \
    "$PUBLIC_IP" "$PUBLIC_PORT" "$PROTOCOL")"

log_message() {
    logger -t natmap-sync "$*" 2>/dev/null || true
}

attempt=1
while [ "$attempt" -le 3 ]; do
    if curl --fail --silent --show-error \
        --connect-timeout 5 \
        --max-time 10 \
        --header "Content-Type: application/json" \
        --data "$PAYLOAD" \
        "$SYNC_URL" >/dev/null; then
        log_message "updated ${PUBLIC_IP}:${PUBLIC_PORT}/${PROTOCOL}"
        exit 0
    fi

    log_message "attempt ${attempt} failed for ${PUBLIC_IP}:${PUBLIC_PORT}/${PROTOCOL}"
    sleep "$((attempt * 2))"
    attempt="$((attempt + 1))"
done

log_message "update failed after 3 attempts"
exit 1
