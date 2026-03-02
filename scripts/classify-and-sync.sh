#!/bin/bash
# This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
# If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# ABOUTME: Classify videos via VLM and sync labels to ClickHouse
# ABOUTME: Replaces both the admin UI batch classifier and the k8s ch-label-backfill job
#
# Usage:
#   ./scripts/classify-and-sync.sh                    # classify + sync, start from offset 0
#   ./scripts/classify-and-sync.sh --offset 500       # start from offset 500
#   ./scripts/classify-and-sync.sh --sync-only        # skip VLM classification, just sync KV → ClickHouse
#   ./scripts/classify-and-sync.sh --batch-size 20    # classify 20 videos per batch
#
# Environment variables (or set in .env):
#   MODERATION_API_TOKEN  - Bearer token for the moderation service
#   CLICKHOUSE_URL        - ClickHouse HTTP endpoint (e.g. https://xyz.clickhouse.cloud:8443)
#   CLICKHOUSE_USER       - ClickHouse username
#   CLICKHOUSE_PASSWORD   - ClickHouse password
#   CLICKHOUSE_DATABASE   - ClickHouse database (default: nostr)
#   MODERATION_URL        - Moderation service URL (default: https://divine-moderation-service.protestnet.workers.dev)
#   FUNNELCAKE_API        - Funnelcake API URL (default: https://relay.divine.video)

set -euo pipefail

# Load .env if present
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -f "$SCRIPT_DIR/../.env" ]]; then
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/../.env"
fi

# Defaults
MODERATION_URL="${MODERATION_URL:-https://divine-moderation-service.protestnet.workers.dev}"
FUNNELCAKE_API="${FUNNELCAKE_API:-https://relay.divine.video}"
CLICKHOUSE_DATABASE="${CLICKHOUSE_DATABASE:-nostr}"
BATCH_SIZE=10
OFFSET=0
SYNC_ONLY=false
CLASSIFY_ONLY=false

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --offset)      OFFSET="$2"; shift 2 ;;
    --batch-size)  BATCH_SIZE="$2"; shift 2 ;;
    --sync-only)   SYNC_ONLY=true; shift ;;
    --classify-only) CLASSIFY_ONLY=true; shift ;;
    --help|-h)
      echo "Usage: $0 [--offset N] [--batch-size N] [--sync-only] [--classify-only]"
      exit 0 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# Validate required env
if [[ -z "${MODERATION_API_TOKEN:-}" ]]; then
  echo "ERROR: MODERATION_API_TOKEN not set. Get it from: wrangler secret list"
  exit 1
fi

if [[ "$SYNC_ONLY" == "false" && "$CLASSIFY_ONLY" == "false" ]] || [[ "$SYNC_ONLY" == "true" ]]; then
  if [[ -z "${CLICKHOUSE_URL:-}" || -z "${CLICKHOUSE_USER:-}" || -z "${CLICKHOUSE_PASSWORD:-}" ]]; then
    # Try to get from k8s secret (production cluster)
    echo "ClickHouse credentials not in env, trying kubectl..."
    CLICKHOUSE_URL=$(kubectl get secret -n funnelcake funnelcake-clickhouse-credentials -o jsonpath='{.data.CLICKHOUSE_URL}' 2>/dev/null | base64 -d) || true
    CLICKHOUSE_USER=$(kubectl get secret -n funnelcake funnelcake-clickhouse-credentials -o jsonpath='{.data.CLICKHOUSE_USER}' 2>/dev/null | base64 -d) || true
    CLICKHOUSE_PASSWORD=$(kubectl get secret -n funnelcake funnelcake-clickhouse-credentials -o jsonpath='{.data.CLICKHOUSE_PASSWORD}' 2>/dev/null | base64 -d) || true
    if [[ -z "$CLICKHOUSE_URL" ]]; then
      echo "ERROR: CLICKHOUSE_URL not set and kubectl failed. Set env vars or switch kubectl context to production."
      exit 1
    fi
    echo "Got ClickHouse credentials from kubectl"
  fi
fi

# Counters
TOTAL_CLASSIFIED=0
TOTAL_SYNCED=0
TOTAL_SKIPPED=0
TOTAL_ERRORS=0
START_TIME=$(date +%s)

log() { echo "[$(date +%H:%M:%S)] $*"; }

# Step 1: Classify videos missing KV data (calls moderation service batch endpoint)
classify_batch() {
  local offset=$1
  local result
  result=$(curl -sf "$MODERATION_URL/admin/api/classify-batch" \
    -H "Authorization: Bearer $MODERATION_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"cursor\":$offset,\"batchSize\":$BATCH_SIZE,\"purge\":true}" 2>&1) || {
    log "ERROR: classify-batch HTTP error at offset $offset"
    return 1
  }

  local classified skipped errors has_more next_offset
  classified=$(echo "$result" | jq -r '.classified // 0')
  skipped=$(echo "$result" | jq -r '.skipped // 0')
  errors=$(echo "$result" | jq -r '.errors // 0')
  has_more=$(echo "$result" | jq -r '.hasMore // false')
  next_offset=$(echo "$result" | jq -r '.offset // 0')

  TOTAL_CLASSIFIED=$((TOTAL_CLASSIFIED + classified))
  TOTAL_SKIPPED=$((TOTAL_SKIPPED + skipped))
  TOTAL_ERRORS=$((TOTAL_ERRORS + errors))

  # Log details for classified videos
  echo "$result" | jq -r '.details[]? | select(.status == "classified") | .sha256[:12] + " OK " + (.sceneSummary // "no scene")' 2>/dev/null | while read -r line; do
    log "  $line"
  done

  local empty_count
  empty_count=$(echo "$result" | jq '[.details[]? | select(.status == "empty")] | length' 2>/dev/null || echo 0)
  if [[ "$empty_count" -gt 0 ]]; then
    log "  ($empty_count videos returned empty VLM results)"
  fi

  log "batch offset=$offset: +$classified classified, $skipped skip, $errors err (total: $TOTAL_CLASSIFIED classified, $TOTAL_SKIPPED skip)"

  if [[ "$has_more" == "true" ]]; then
    echo "$next_offset"
  else
    echo "done"
  fi
}

# Step 2: Sync labels from KV → ClickHouse for a single video
sync_video_labels() {
  local sha256=$1
  local video_url=$2

  # Get recommendation labels from moderation API
  local reco
  reco=$(curl -sf "$MODERATION_URL/api/v1/classifier/$sha256/recommendations" \
    -H "Authorization: Bearer $MODERATION_API_TOKEN" 2>/dev/null) || return 1

  # Check if there are labels
  local label_count
  label_count=$(echo "$reco" | jq '.gorse.labels | length' 2>/dev/null || echo 0)
  if [[ "$label_count" == "0" || "$label_count" == "null" ]]; then
    return 0  # no labels, skip
  fi

  # Look up the event ID for this sha256 in ClickHouse
  local event_id
  event_id=$(curl -sf "$CLICKHOUSE_URL/?user=$CLICKHOUSE_USER&password=$CLICKHOUSE_PASSWORD&database=$CLICKHOUSE_DATABASE" \
    -d "SELECT id FROM videos_with_loops WHERE sha256 = '$sha256' OR video_url LIKE '%$sha256%' LIMIT 1" 2>/dev/null | tr -d '[:space:]')

  if [[ -z "$event_id" || ${#event_id} -ne 64 ]]; then
    return 0  # video not in ClickHouse
  fi

  # Build INSERT for each label
  local values=""
  while IFS= read -r label; do
    local label_value namespace
    # Labels are like "topic:food", "setting:kitchen", etc.
    namespace=$(echo "$label" | cut -d: -f1)
    label_value="$label"
    if [[ -n "$values" ]]; then values="$values,"; fi
    values="$values('$event_id','$label_value','$namespace',now())"
  done < <(echo "$reco" | jq -r '.gorse.labels[]' 2>/dev/null)

  if [[ -n "$values" ]]; then
    curl -sf "$CLICKHOUSE_URL/?user=$CLICKHOUSE_USER&password=$CLICKHOUSE_PASSWORD&database=$CLICKHOUSE_DATABASE" \
      -d "INSERT INTO content_labels (target_event_id, label_value, label_namespace, labeled_at) VALUES $values" >/dev/null 2>&1 || {
      log "  WARN: ClickHouse insert failed for $sha256"
      return 1
    }
    TOTAL_SYNCED=$((TOTAL_SYNCED + 1))
  fi
}

# Main: fetch videos from funnelcake API, classify, then sync
main() {
  log "Starting classify-and-sync (offset=$OFFSET, batch_size=$BATCH_SIZE, sync_only=$SYNC_ONLY)"

  local current_offset=$OFFSET

  if [[ "$SYNC_ONLY" == "false" ]]; then
    log "=== Phase 1: VLM Classification ==="
    while true; do
      local next
      next=$(classify_batch "$current_offset") || {
        log "Classify batch failed, retrying in 5s..."
        sleep 5
        next=$(classify_batch "$current_offset") || { log "Retry failed, stopping classify phase."; break; }
      }
      if [[ "$next" == "done" ]]; then
        log "Classification complete."
        break
      fi
      current_offset="$next"
    done
    log "Classification phase done: $TOTAL_CLASSIFIED classified, $TOTAL_SKIPPED skipped, $TOTAL_ERRORS errors"
  fi

  if [[ "$CLASSIFY_ONLY" == "true" ]]; then
    log "Classify-only mode, skipping sync."
    print_summary
    return
  fi

  log "=== Phase 2: Sync labels KV → ClickHouse ==="
  local sync_offset=0
  local page_size=50
  local sync_page=0

  while true; do
    sync_page=$((sync_page + 1))
    local videos
    videos=$(curl -sf "$FUNNELCAKE_API/api/videos?limit=$page_size&offset=$sync_offset&sort=recent" 2>/dev/null) || {
      log "ERROR: funnelcake API failed at offset $sync_offset"
      break
    }

    local count
    count=$(echo "$videos" | jq 'length' 2>/dev/null || echo 0)
    if [[ "$count" == "0" ]]; then
      log "No more videos at offset $sync_offset."
      break
    fi

    local synced_this_batch=0
    for i in $(seq 0 $((count - 1))); do
      local video_url sha256
      video_url=$(echo "$videos" | jq -r ".[$i].video_url" 2>/dev/null)
      # Extract sha256 from URL path
      sha256=$(echo "$video_url" | sed 's|.*/||; s|\.[^.]*$||')
      if [[ ${#sha256} -ne 64 ]]; then
        sha256=$(echo "$videos" | jq -r ".[$i].d_tag" 2>/dev/null)
      fi
      if [[ ${#sha256} -eq 64 ]]; then
        sync_video_labels "$sha256" "$video_url" && synced_this_batch=$((synced_this_batch + 1)) || true
      fi
    done

    log "sync page $sync_page (offset=$sync_offset): synced $synced_this_batch/$count"
    sync_offset=$((sync_offset + count))

    if [[ "$count" -lt "$page_size" ]]; then
      break
    fi
  done

  print_summary
}

print_summary() {
  local elapsed=$(( $(date +%s) - START_TIME ))
  local minutes=$((elapsed / 60))
  log "=== Done ==="
  log "Classified: $TOTAL_CLASSIFIED | Synced to ClickHouse: $TOTAL_SYNCED | Skipped: $TOTAL_SKIPPED | Errors: $TOTAL_ERRORS"
  log "Elapsed: ${minutes}m${((elapsed % 60))}s"
}

main
