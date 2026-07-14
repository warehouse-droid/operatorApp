#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_DIR}"

ENV_FILE="${ENV_FILE:-docker/env/.env}"
REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-codex/dockerVer}"
BACKUP_DIR="${BACKUP_DIR:-docker/backups}"
SKIP_BACKUP="${SKIP_BACKUP:-0}"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-30}"
HEALTH_INTERVAL_SECONDS="${HEALTH_INTERVAL_SECONDS:-2}"

COMPOSE=(docker compose --env-file "${ENV_FILE}")
APP_STOPPED=0

log() {
  printf '\n[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

fail() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

recover_stopped_app() {
  local status=$?
  if (( APP_STOPPED == 1 )); then
    printf '\nUpdate failed while the application was stopped. Restarting the previous app container...\n' >&2
    "${COMPOSE[@]}" start app >/dev/null 2>&1 || true
  fi
  exit "${status}"
}

trap recover_stopped_app ERR

command -v git >/dev/null 2>&1 || fail "git is not installed."
command -v docker >/dev/null 2>&1 || fail "docker is not installed."
command -v curl >/dev/null 2>&1 || fail "curl is not installed."
[[ -f "${ENV_FILE}" ]] || fail "Missing Docker environment file: ${ENV_FILE}"
[[ -f docker-compose.yml ]] || fail "Run this script from the operatorApp repository."

docker info >/dev/null 2>&1 || fail "Docker is not running or this user cannot access Docker."
"${COMPOSE[@]}" config --quiet

CURRENT_BRANCH="$(git branch --show-current)"
[[ "${CURRENT_BRANCH}" == "${BRANCH}" ]] || fail "Current branch is '${CURRENT_BRANCH}'. Switch to '${BRANCH}' before updating."

WORKTREE_STATUS="$(git status --porcelain)"
if [[ -n "${WORKTREE_STATUS}" ]]; then
  printf '%s\n' "${WORKTREE_STATUS}" >&2
  fail "The VM repository has local changes. Commit or stash them before updating."
fi

if [[ "${SKIP_BACKUP}" != "1" ]]; then
  log "Creating PostgreSQL backup"
  mkdir -p "${BACKUP_DIR}"
  STAMP="$(date '+%Y%m%d-%H%M%S')"
  CONTAINER_BACKUP="/tmp/mbbs-before-update-${STAMP}.dump"
  HOST_BACKUP="${BACKUP_DIR}/mbbs-before-update-${STAMP}.dump"

  "${COMPOSE[@]}" exec -T db sh -c \
    "pg_dump -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Fc -f '${CONTAINER_BACKUP}'"
  DB_CONTAINER="$("${COMPOSE[@]}" ps -q db)"
  [[ -n "${DB_CONTAINER}" ]] || fail "PostgreSQL container is not running."
  docker cp "${DB_CONTAINER}:${CONTAINER_BACKUP}" "${HOST_BACKUP}"
  "${COMPOSE[@]}" exec -T db rm -f "${CONTAINER_BACKUP}"
  [[ -s "${HOST_BACKUP}" ]] || fail "Database backup is missing or empty: ${HOST_BACKUP}"
  log "Backup created: ${HOST_BACKUP}"
else
  log "Skipping PostgreSQL backup because SKIP_BACKUP=1"
fi

BEFORE_COMMIT="$(git rev-parse --short HEAD)"
log "Pulling ${REMOTE}/${BRANCH} (current ${BEFORE_COMMIT})"
git fetch "${REMOTE}" "${BRANCH}"
git pull --ff-only "${REMOTE}" "${BRANCH}"
AFTER_COMMIT="$(git rev-parse --short HEAD)"
log "Repository updated to ${AFTER_COMMIT}"

log "Building the application and migration images"
"${COMPOSE[@]}" build app migrate

log "Stopping the application container"
"${COMPOSE[@]}" stop app
APP_STOPPED=1

log "Applying database migrations"
"${COMPOSE[@]}" --profile tools run --rm migrate

log "Recreating the application container"
"${COMPOSE[@]}" up -d --no-deps --force-recreate app
APP_STOPPED=0

HOST_PORT="$(awk -F= '$1 == "MBBS_APP_HOST_PORT" { value=$2; gsub(/^[[:space:]\"]+|[[:space:]\"]+$/, "", value); print value; exit }' "${ENV_FILE}")"
HOST_PORT="${HOST_PORT:-3001}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${HOST_PORT}/health}"

log "Waiting for application health at ${HEALTH_URL}"
HEALTHY=0
for (( attempt=1; attempt<=HEALTH_ATTEMPTS; attempt++ )); do
  if HEALTH_RESPONSE="$(curl --fail --silent --show-error "${HEALTH_URL}" 2>/dev/null)"; then
    HEALTHY=1
    printf '%s\n' "${HEALTH_RESPONSE}"
    break
  fi
  sleep "${HEALTH_INTERVAL_SECONDS}"
done

if (( HEALTHY == 0 )); then
  "${COMPOSE[@]}" ps
  "${COMPOSE[@]}" logs --tail 150 app
  fail "Application did not become healthy after ${HEALTH_ATTEMPTS} attempts."
fi

log "Container status"
"${COMPOSE[@]}" ps

log "Recent application logs"
"${COMPOSE[@]}" logs --tail 80 app

printf '\nVM update completed successfully: %s -> %s\n' "${BEFORE_COMMIT}" "${AFTER_COMMIT}"

