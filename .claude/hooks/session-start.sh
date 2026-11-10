#!/bin/bash
# Install the npm dependencies for Claude Code on the web.
#
# Those containers clone the repository into a bare image, so without this the
# typecheck and the Lab build have no TypeScript or esbuild. A local checkout is
# left alone: its environment is whatever the developer set up.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# The hook event arrives as JSON on stdin. A compact or a clear keeps the same
# container, whose dependencies are already installed.
payload=""
[ -t 0 ] || payload=$(cat)
case "$payload" in
  *'"source":"compact"'*|*'"source": "compact"'*|*'"source":"clear"'*|*'"source": "clear"'*) exit 0 ;;
esac

# Run in the background so the session starts at once. A missing module in the
# first seconds of a session means the install is still running.
echo '{"async": true, "asyncTimeout": 300000}'

cd "${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"

# Mesa's EGL and llvmpipe, as CI installs them. Without them headless Chromium draws
# WebGL with SwiftShader, which makes the browser tests about ten times slower.
mesa="libegl1 libegl-mesa0 libgl1-mesa-dri"
missing=""
for p in $mesa; do dpkg -s "$p" >/dev/null 2>&1 || missing="$missing $p"; done
if [ -n "$missing" ]; then
  export DEBIAN_FRONTEND=noninteractive
  # The image's package lists may be stale; refresh them only if the install needs it.
  apt-get install -y --no-install-recommends $missing >/dev/null 2>&1 ||
    { apt-get update >/dev/null && apt-get install -y --no-install-recommends $missing >/dev/null; }
fi

npm ci --no-audit --no-fund --loglevel=error

# Chromium for the browser tests is already in the image. WebKit is not; install it
# with `npx playwright install --with-deps webkit` when a change needs Safari checks.
echo "npm dependencies installed. Run: npx tsc --noEmit && npm test"
