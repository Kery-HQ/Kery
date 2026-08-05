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
# purchasify serves BOTH benchmark routes: /estimate (checkout-v2) and the
# held-out /licences. Its middleware constructs a Supabase client on every
# request, so .env.local must exist or every route 500s — see harness/README.
if [ ! -f ~/Documents/repo/purchasify/.env.local ]; then
  echo "WARNING: purchasify/.env.local missing — all routes will return 500"
fi
start purchasify 4101 feat/licence-planner
start noted-so   4102 feat/onboarding-wizard
AUTH0_DOMAIN=test.auth0.com AUTH0_CLIENT_ID=x AUTH0_CLIENT_SECRET=x \
AUTH0_SECRET=0123456789abcdef0123456789abcdef APP_BASE_URL=http://localhost:4103 \
start chatific 4103 feat/model-compare
sleep 12
for u in localhost:4101/estimate localhost:4101/licences localhost:4102 localhost:4103; do
  echo "$u → $(curl -s -o /dev/null -w '%{http_code}' "http://$u" --max-time 8)"
done
