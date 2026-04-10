#!/bin/bash
# check-isolated-deps.sh
# Verifies that packages/knowhow only imports dependencies it actually declares.
# Runs tsc in an isolated temp directory with NO parent node_modules available,
# so any dep resolved from the monorepo root will cause a real compile failure.
#
# Usage: bash scripts/check-isolated-deps.sh
# Also used as the "prepublishOnly" hook to prevent publishing broken packages.

set -e

PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MONOREPO_ROOT="$(cd "$PACKAGE_DIR/../.." && pwd)"
TUNNEL_DIR="$MONOREPO_ROOT/packages/knowhow-tunnel"

echo "=== Isolated dependency check for @tyvm/knowhow ==="
echo "Package dir: $PACKAGE_DIR"

# 1. Build knowhow-tunnel so we can pack it
echo ""
echo "--- Building knowhow-tunnel ---"
cd "$TUNNEL_DIR"
npm run build --silent

# Pack and capture just the filename (redirect stderr so npm warnings don't corrupt JSON)
TUNNEL_TARBALL=$(npm pack --json 2>/dev/null | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.parse(d)[0].filename))")
TUNNEL_TARBALL_PATH="$TUNNEL_DIR/$TUNNEL_TARBALL"
echo "Packed tunnel: $TUNNEL_TARBALL_PATH"

# 2. Create isolated temp directory
WORK_DIR=$(mktemp -d)
trap "rm -rf '$WORK_DIR'; rm -f '$TUNNEL_TARBALL_PATH'" EXIT
echo ""
echo "--- Creating isolated workspace at $WORK_DIR ---"

# 3. Copy package source (excluding node_modules and ts_build)
rsync -a \
  --exclude='node_modules' \
  --exclude='ts_build' \
  --exclude='.knowhow' \
  --exclude='scripts' \
  "$PACKAGE_DIR/" "$WORK_DIR/"

# 4. Copy the tunnel tarball into work dir and rewrite the dependency
cp "$TUNNEL_TARBALL_PATH" "$WORK_DIR/$TUNNEL_TARBALL"
cd "$WORK_DIR"

# Replace workspace dep reference with local tarball path
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
  pkg.dependencies['@tyvm/knowhow-tunnel'] = 'file:./' + process.argv[1];
  fs.writeFileSync('./package.json', JSON.stringify(pkg, null, 2));
" "$TUNNEL_TARBALL"

echo "Updated @tyvm/knowhow-tunnel dep to local tarball"

# 5. Install in isolated dir (include devDeps for tsc) — NO parent node_modules accessible
echo ""
echo "--- Running npm install (isolated, including devDependencies) ---"
npm install --ignore-scripts 2>&1 | grep -v "^npm warn deprecated" | grep -v "^$" || true

# 6. Run tsc --noEmit from the isolated dir
echo ""
echo "--- Running tsc --noEmit (isolated) ---"
./node_modules/.bin/tsc --noEmit

echo ""
echo "=== Isolated dependency check PASSED ==="
