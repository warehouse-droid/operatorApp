#!/usr/bin/env bash

mbt_write_gauntlet_summary() {
  local mbt_summary_output="${1:-}"
  local mbt_summary_phase="${2:-}"
  local mbt_summary_exit_code="${3:-}"
  local mbt_summary_failed_line="${4:-}"
  local mbt_summary_started_at="${5:-}"
  local mbt_summary_finished_at="${6:-}"
  local mbt_summary_status="failed"
  local mbt_summary_temporary=""

  if [[ -z "$mbt_summary_output" ]]; then
    echo "A gauntlet summary output path is required." >&2
    return 64
  fi
  case "$mbt_summary_phase" in
    baseline|P1|P2|P3) ;;
    *)
      echo "The gauntlet summary phase is invalid." >&2
      return 64
      ;;
  esac
  if [[ ! "$mbt_summary_exit_code" =~ ^[0-9]+$ ]] || (( mbt_summary_exit_code > 255 )); then
    echo "The gauntlet summary exit code is invalid." >&2
    return 64
  fi
  if (( mbt_summary_exit_code == 0 )); then
    mbt_summary_status="passed"
    if [[ "$mbt_summary_failed_line" != "null" ]]; then
      echo "A passing gauntlet summary cannot contain a failed line." >&2
      return 64
    fi
  elif [[ ! "$mbt_summary_failed_line" =~ ^[1-9][0-9]*$ ]]; then
    echo "A failing gauntlet summary requires its failed line." >&2
    return 64
  fi
  if [[ ! "$mbt_summary_started_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
      [[ ! "$mbt_summary_finished_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
    echo "The gauntlet summary timestamps are invalid." >&2
    return 64
  fi

  mbt_summary_temporary="${mbt_summary_output}.tmp.$$"
  printf '%s\n' \
    '{' \
    '  "schemaVersion": "mbt-gauntlet-summary-v1",' \
    "  \"phase\": \"$mbt_summary_phase\"," \
    "  \"status\": \"$mbt_summary_status\"," \
    "  \"exitCode\": $mbt_summary_exit_code," \
    "  \"failedLine\": $mbt_summary_failed_line," \
    "  \"startedAt\": \"$mbt_summary_started_at\"," \
    "  \"finishedAt\": \"$mbt_summary_finished_at\"" \
    '}' >"$mbt_summary_temporary" || return 74
  mv "$mbt_summary_temporary" "$mbt_summary_output"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -Eeuo pipefail
  mbt_write_gauntlet_summary "$@"
fi
