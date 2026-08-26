#!/bin/bash
# One-time: clone vpn-panel-api for PROJECT_LOG git sync on VPS.
set -euo pipefail

GIT_DIR="${PROJECT_LOG_GIT_ROOT:-/opt/vpn-panel-git-sync}"
REPO="${PROJECT_LOG_GIT_REPO:-git@github.com:Dayanchk15/vpn-panel-api.git}"
BRANCH="${PROJECT_LOG_GIT_BRANCH:-main}"
SSH_KEY="${PROJECT_LOG_GIT_SSH_KEY:-/root/.ssh/id_ed25519_work}"
FILES_LOG="/opt/vpn-panel/files/PROJECT_LOG.md"

export GIT_SSH_COMMAND="ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no -o IdentitiesOnly=yes"

mkdir -p "$(dirname "$GIT_DIR")"

if [ ! -d "$GIT_DIR/.git" ]; then
  echo "Cloning $REPO -> $GIT_DIR"
  git clone --depth 100 --branch "$BRANCH" "$REPO" "$GIT_DIR"
else
  echo "Repo exists: $GIT_DIR"
  cd "$GIT_DIR"
  git fetch origin "$BRANCH"
  git checkout "$BRANCH"
  git pull origin "$BRANCH" || true
fi

cd "$GIT_DIR"
git config user.email "${PROJECT_LOG_GIT_EMAIL:-desktop-agent@vpn-panel}"
git config user.name "${PROJECT_LOG_GIT_AUTHOR:-Desktop Agent}"

if [ -f "$FILES_LOG" ] && [ -f "$GIT_DIR/PROJECT_LOG.md" ]; then
  if [ "$FILES_LOG" -nt "$GIT_DIR/PROJECT_LOG.md" ]; then
    cp "$FILES_LOG" "$GIT_DIR/PROJECT_LOG.md"
    echo "Copied newer PROJECT_LOG from files volume"
  fi
elif [ -f "$FILES_LOG" ]; then
  cp "$FILES_LOG" "$GIT_DIR/PROJECT_LOG.md"
  echo "Seeded PROJECT_LOG from files volume"
fi

echo "OK: $GIT_DIR"
ls -la "$GIT_DIR/PROJECT_LOG.md"
