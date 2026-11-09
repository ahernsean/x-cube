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
npm ci --no-audit --no-fund --loglevel=error

# Chromium for the smoke test is already in the image. WebKit is not; install it
# with `npx playwright install --with-deps webkit` when a change needs Safari checks.
echo "npm dependencies installed. Run: npx tsc --noEmit && npm test"
