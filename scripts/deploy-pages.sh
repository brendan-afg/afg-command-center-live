#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEY="/home/ubuntu/.ssh/afg_pages_deploy"
REMOTE="git@github.com:brendan-afg/afg-command-center-live.git"
PUBLIC_SNAPSHOT="https://brendan-afg.github.io/afg-command-center-live/data.json"
LOCK="/tmp/afg-command-center-refresh.lock"

exec 9>"$LOCK"
flock -w 120 9 || { echo "Another AFG refresh held the deployment lock for more than 120 seconds." >&2; exit 75; }

[[ -f "$KEY" ]] || { echo "Deployment key unavailable; refusing to publish." >&2; exit 1; }
[[ -n "${GOOGLE_CLOUD_CREDENTIALS:-}" ]] || { echo "Drive credential unavailable; refusing to publish." >&2; exit 1; }
[[ -n "${GOOGLE_DRIVE_FOLDER_ID:-}" ]] || { echo "Drive scope unavailable; refusing to publish." >&2; exit 1; }

cd "$ROOT"
[[ -z "$(git status --porcelain --untracked-files=all)" ]] || { echo "Source tree is not clean; refusing to publish an uncommitted build." >&2; git status --short >&2; exit 1; }
source_commit=$(git rev-parse HEAD)
remote_main=$(GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes" git ls-remote "$REMOTE" refs/heads/main | cut -f1)
[[ "$source_commit" == "$remote_main" ]] || { echo "Local source commit does not match protected remote main; refusing to publish." >&2; exit 1; }
export AFG_SOURCE_COMMIT="$source_commit"
pnpm install --frozen-lockfile
GITHUB_EVENT_NAME=manual-scheduled-refresh pnpm main
node scripts/verify-artifact.mjs

local_generated=$(node -e "const fs=require('fs');const e=JSON.parse(fs.readFileSync('dist/data.json','utf8'));if(e?.access?.mode!=='link_only_no_login')process.exit(1);process.stdout.write(e.generatedAt)")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes" git clone --depth 1 --branch gh-pages "$REMOTE" "$tmp/repo"
find "$tmp/repo" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -a dist/. "$tmp/repo/"
cd "$tmp/repo"
expected_artifacts=$'.nojekyll\nafg-logo.png\napp.js\ndata.json\nindex.html\nsnapshot-policy.js\nstyles.css\nurl-policy.js'
actual_artifacts=$(find . -mindepth 1 -maxdepth 1 ! -name .git -printf '%f\n' | sort)
[[ "$actual_artifacts" == "$expected_artifacts" ]] || { echo "Refusing to push unexpected public artifact set:" >&2; printf '%s\n' "$actual_artifacts" >&2; exit 1; }
git add -A
if git diff --cached --quiet; then
  echo "Link-only dashboard artifact is already current."
else
  git -c user.name='AFG Command Center' -c user.email='automation@altfundsglobal.com' commit -m "Authenticated daily dashboard refresh ${local_generated}"
  GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes" git push origin gh-pages
fi

for attempt in $(seq 1 24); do
  remote_generated=$(curl -fsS --max-time 20 "${PUBLIC_SNAPSHOT}?verify=${attempt}" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).generatedAt||'')}catch{}})" || true)
  if [[ "$remote_generated" == "$local_generated" ]]; then
    echo "Verified link-only production artifact ${remote_generated}."
    (cd "$ROOT" && node scripts/create-release-receipt.mjs)
    exit 0
  fi
  sleep 10
done

echo "Deployment pushed but public artifact verification did not converge." >&2
exit 1
