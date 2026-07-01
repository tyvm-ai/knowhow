#!/usr/bin/env bash
# Usage: bash scripts/build-for-node.sh [node-version]
# Example: bash scripts/build-for-node.sh 24        # any Node 24.x
# Example: bash scripts/build-for-node.sh 20.19.0   # exact version
# Example: npm run node:build 24
#
# This script:
#   1. Compiles TypeScript with Node 20 (required for workspace deps)
#   2. Creates /tmp/knowhow-node-<major> with the compiled output
#   3. Symlinks the package globally for ALL installed nvm versions matching the target
#
# Note: isolated-vm is now in @tyvm/knowhow-module-script — install that separately
# for the correct node version if you need script execution support.

set -e

TARGET_VERSION="${1:-}"

if [ -z "$TARGET_VERSION" ]; then
  echo "Usage: $0 <node-version>"
  echo "Example: $0 24"
  echo "Example: $0 20.19.0"
  exit 1
fi

# Extract the major version number for staging dir naming and glob matching
TARGET_MAJOR="$(echo "$TARGET_VERSION" | cut -d. -f1)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "📦 Package dir: $PACKAGE_DIR"

# --- Find Node 20 for compiling TypeScript ---
NODE20_BIN=""
for dir in "$HOME/.nvm/versions/node"/v20.*/bin; do
  if [ -f "$dir/node" ]; then
    NODE20_BIN="$dir/node"
    break
  fi
done

if [ -z "$NODE20_BIN" ]; then
  echo "⚠️  Node 20 not found via nvm, falling back to current node for TS compile"
  NODE20_BIN="$(which node)"
fi

NODE20_NPM="$(dirname "$NODE20_BIN")/npm"
echo "🔨 Compiling TypeScript with: $NODE20_BIN ($(${NODE20_BIN} --version))"

# --- Compile TypeScript ---
cd "$PACKAGE_DIR"
"$NODE20_NPM" run compile
echo "✅ TypeScript compiled"

# --- Find target Node binaries ---
# If exact version given (e.g. 20.19.0), match exactly. Otherwise match all patch versions.
TARGET_NODE_BINS=()

if echo "$TARGET_VERSION" | grep -qE '^\d+\.\d+\.\d+$'; then
  # Exact version like 20.19.0
  exact_dir="$HOME/.nvm/versions/node/v${TARGET_VERSION}/bin"
  if [ -f "$exact_dir/node" ]; then
    TARGET_NODE_BINS+=("$exact_dir/node")
  fi
else
  # Major only — collect all patch versions
  for dir in "$HOME/.nvm/versions/node"/v${TARGET_MAJOR}.*/bin; do
    if [ -f "$dir/node" ]; then
      TARGET_NODE_BINS+=("$dir/node")
    fi
  done
fi

if [ ${#TARGET_NODE_BINS[@]} -eq 0 ]; then
  echo "❌ Node $TARGET_VERSION not found in ~/.nvm/versions/node/"
  echo "   Run: nvm install $TARGET_VERSION"
  exit 1
fi

# Use the last (latest patch) for building
TARGET_NODE_BIN="${TARGET_NODE_BINS[${#TARGET_NODE_BINS[@]}-1]}"
TARGET_NODE_ACTUAL_VERSION="$("$TARGET_NODE_BIN" --version)"

echo "🎯 Found Node $TARGET_VERSION installs: ${TARGET_NODE_BINS[*]}"
echo "🔨 Building with: $TARGET_NODE_BIN ($TARGET_NODE_ACTUAL_VERSION)"

# --- Create staging directory ---
STAGING_DIR="/tmp/knowhow-node-${TARGET_MAJOR}"
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
echo ""
echo "📁 Staging dir: $STAGING_DIR"

# --- Copy compiled output and package files into staging dir ---
echo "📋 Copying compiled output to staging dir..."
cp -r "$PACKAGE_DIR/ts_build" "$STAGING_DIR/ts_build"
cp -r "$PACKAGE_DIR/bin" "$STAGING_DIR/bin" 2>/dev/null || true
cp "$PACKAGE_DIR/package.json" "$STAGING_DIR/package.json"
for item in README.md LICENSE .npmignore; do
  [ -e "$PACKAGE_DIR/$item" ] && cp "$PACKAGE_DIR/$item" "$STAGING_DIR/" || true
done

# --- Patch package.json to remove workspace protocol deps ---
echo "📝 Patching package.json..."
"$NODE20_BIN" -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('$STAGING_DIR/package.json', 'utf8'));
  if (pkg.dependencies) {
    for (const [k, v] of Object.entries(pkg.dependencies)) {
      if (String(v).startsWith('workspace:')) delete pkg.dependencies[k];
    }
  }
  fs.writeFileSync('$STAGING_DIR/package.json', JSON.stringify(pkg, null, 2));
  console.log('✅ package.json patched');
"

# --- Install dependencies in staging dir with target Node ---
TARGET_NODE_NPM="$(dirname "$TARGET_NODE_BIN")/npm"
echo ""
echo "📦 Installing dependencies in staging dir with Node $TARGET_MAJOR..."
cd "$STAGING_DIR"
"$TARGET_NODE_NPM" install --omit=dev
echo "✅ Dependencies installed"
cd "$PACKAGE_DIR"

# --- Symlink globally for ALL matching Node version installs ---
PKG_NAME="$("$NODE20_BIN" -e "console.log(require('$STAGING_DIR/package.json').name)")"
PKG_BIN_NAME="$("$NODE20_BIN" -e "const b=require('$STAGING_DIR/package.json').bin; console.log(Object.keys(b)[0])")"
PKG_BIN_FILE="$("$NODE20_BIN" -e "const b=require('$STAGING_DIR/package.json').bin; console.log(Object.values(b)[0])")"

echo ""
echo "🔗 Linking $PKG_NAME globally for all Node $TARGET_MAJOR installs..."
for node_bin in "${TARGET_NODE_BINS[@]}"; do
  node_prefix="$("$node_bin" -e "const p=require('path');console.log(p.join(p.dirname(process.execPath),'..'))" 2>/dev/null)"
  global_modules="$node_prefix/lib/node_modules"
  global_bin="$node_prefix/bin"
  mkdir -p "$global_modules/@tyvm"
  rm -rf "$global_modules/$PKG_NAME"
  ln -sf "$STAGING_DIR" "$global_modules/$PKG_NAME"
  rm -f "$global_bin/$PKG_BIN_NAME"
  ln -sf "$global_modules/$PKG_NAME/$PKG_BIN_FILE" "$global_bin/$PKG_BIN_NAME"
  echo "✅ $("$node_bin" --version): $global_modules/$PKG_NAME → $STAGING_DIR"
done

echo ""
echo "🎉 Done! Switch to Node $TARGET_MAJOR and run: knowhow"
echo "   nvm use $TARGET_MAJOR && knowhow"
