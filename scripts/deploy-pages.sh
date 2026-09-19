#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/ubuntu/afg-command-center-live-final"
KEY="/home/ubuntu/.ssh/afg_pages_deploy"
REMOTE="git@github.com:brendan-afg/afg-command-center-live.git"
PUBLIC_ENVELOPE="https://brendan-afg.github.io/afg-command-center-live/data.enc"
LOCK="/tmp/afg-command-center-refresh.lock"

exec 9>"$LOCK"
flock -w 120 9 || { echo "Another AFG refresh held the deployment lock for more than 120 seconds." >&2; exit 75; }

[[ -f "$KEY" ]] || { echo "Deployment key unavailable; refusing to publish." >&2; exit 1; }
[[ -n "${GOOGLE_CLOUD_CREDENTIALS:-}" ]] || { echo "Drive credential unavailable; refusing to publish." >&2; exit 1; }
[[ -n "${GOOGLE_DRIVE_FOLDER_ID:-}" ]] || { echo "Drive scope unavailable; refusing to publish." >&2; exit 1; }

cd "$ROOT"
pnpm install --frozen-lockfile
GITHUB_EVENT_NAME=manual-scheduled-refresh pnpm main
for artifact in index.html app.js snapshot-policy.js url-policy.js styles.css afg-logo.jpeg data.enc; do
  cmp -s "site/$artifact" "dist/$artifact" || { echo "Source/artifact mismatch: $artifact" >&2; exit 1; }
done

local_generated=$(node -e "const fs=require('fs');const e=JSON.parse(fs.readFileSync('dist/data.enc','utf8'));process.stdout.write(e.generatedAt)")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes" git clone --depth 1 --branch gh-pages "$REMOTE" "$tmp/repo"
find "$tmp/repo" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -a dist/. "$tmp/repo/"
cd "$tmp/repo"
git add -A
if git diff --cached --quiet; then
  echo "Encrypted dashboard artifact is already current."
else
  git -c user.name='AFG Command Center' -c user.email='automation@altfundsglobal.com' commit -m "Authenticated daily dashboard refresh ${local_generated}"
  GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes" git push origin gh-pages
fi

for attempt in $(seq 1 24); do
  remote_generated=$(curl -fsS --max-time 20 "${PUBLIC_ENVELOPE}?verify=${attempt}" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).generatedAt||'')}catch{}})" || true)
  if [[ "$remote_generated" == "$local_generated" ]]; then
    echo "Verified encrypted production artifact ${remote_generated}."
    (cd "$ROOT" && node scripts/create-release-receipt.mjs)
    exit 0
  fi
  sleep 10
done

echo "Deployment pushed but public artifact verification did not converge." >&2
exit 1
