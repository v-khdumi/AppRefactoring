#!/usr/bin/env bash
set -euo pipefail

resource_group="${1:?Resource group is required}"
job="${2:?Migration job name is required}"
image="${3:?Release worker image is required}"

az containerapp job update --name "$job" --resource-group "$resource_group" \
  --image "$image" --output none
execution="$(az containerapp job start --name "$job" --resource-group "$resource_group" --query name --output tsv)"
if [[ -z "$execution" ]]; then
  echo "Migration job did not return an execution name." >&2
  exit 1
fi

for ((attempt = 0; attempt < 100; attempt++)); do
  status="$(az containerapp job execution show --name "$job" --resource-group "$resource_group" \
    --job-execution-name "$execution" --query properties.status --output tsv)"
  case "$status" in
    Succeeded) echo "Database migrations completed: $execution"; exit 0 ;;
    Failed|Stopped|Degraded|Canceled|Cancelled)
      echo "Database migration execution $execution ended with status $status." >&2
      exit 1
      ;;
    Running|Processing|Pending|Unknown|"") sleep 10 ;;
    *) echo "Unexpected migration execution status: $status" >&2; exit 1 ;;
  esac
done

echo "Timed out waiting for database migration execution $execution." >&2
exit 1
