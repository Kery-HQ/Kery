#!/usr/bin/env bash
# Run a suite across N shards concurrently, each against its own app servers.
#
#   ./run-parallel.sh <suite> <mode> <repeat> <label> [shards]
#
# Results are written as <label>-shard<i>-*.json and are read together by
# collect-noise.mjs / compare.mjs, which glob on the label prefix.
set -uo pipefail
SUITE=$1; MODE=$2; REPEAT=$3; LABEL=$4; SHARDS=${5:-4}
cd "$(dirname "$0")/.."

pids=()
for ((i = 0; i < SHARDS; i++)); do
  off=$((i * 10))
  node harness/run-benchmark.mjs \
    --suite "$SUITE" --mode "$MODE" --repeat "$REPEAT" \
    --shard "$i/$SHARDS" --portOffset "$off" \
    --label "${LABEL}-shard${i}" > "/tmp/${LABEL}-shard${i}.log" 2>&1 &
  pids+=($!)
done

echo "launched $SHARDS shards for $LABEL"
fail=0
for p in "${pids[@]}"; do wait "$p" || fail=$((fail + 1)); done
echo "$LABEL complete ($fail shard failures)"
grep -ahE "TUNING SET" /tmp/${LABEL}-shard*.log
