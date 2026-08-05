#!/usr/bin/env bash
# Serve the three benchmark apps locally on fixed ports for the harness.
set -uo pipefail
start() { # dir port branch extra_env
  local dir=$1 port=$2 branch=$3
  cd ~/Documents/repo/$dir || return 1
  git checkout -q "$branch" 2>/dev/null
  if lsof -ti tcp:$port >/dev/null 2>&1; then echo "$dir already on :$port"; return 0; fi
  ( PORT=$port nohup npm run start -- -p $port > /tmp/harness-$dir.log 2>&1 & )
  echo "$dir → :$port ($branch)"
}
start purchasify 4101 feat/checkout-v2
start noted-so   4102 feat/onboarding-wizard
AUTH0_DOMAIN=test.auth0.com AUTH0_CLIENT_ID=x AUTH0_CLIENT_SECRET=x \
AUTH0_SECRET=0123456789abcdef0123456789abcdef APP_BASE_URL=http://localhost:4103 \
start chatific 4103 feat/model-compare
sleep 12
for p in 4101 4102 4103; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$p" --max-time 8)
  echo ":$p → $code"
done
