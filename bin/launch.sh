#!/bin/sh
# Start the Git Workbench MCP server.
#
# ZCode launches GUI processes with a minimal PATH, so a bare `node` command is
# not guaranteed to resolve even when Node is installed. Probe the common
# locations, then fall back to ZCode's own Electron binary running as Node.
set -eu

SERVER="${1:?missing server.mjs path}"

if command -v node >/dev/null 2>&1; then
  exec node "$SERVER"
fi

for candidate in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
  if [ -x "$candidate" ]; then
    exec "$candidate" "$SERVER"
  fi
done

HELPER="/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper"
ZCODE_CJS="/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"
if [ -x "$HELPER" ] && [ -f "$ZCODE_CJS" ]; then
  ELECTRON_RUN_AS_NODE=1 exec "$HELPER" "$ZCODE_CJS" "__zcode-plugin-host" "$SERVER"
fi

echo "git-workbench: no Node.js runtime found (checked PATH, /usr/local/bin, /opt/homebrew/bin, ZCode Helper)" >&2
exit 1
