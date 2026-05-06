#!/usr/bin/env bash
set -euo pipefail

COMMAND="${1:-}"

get_current_version() {
  node -e "process.stdout.write(require('./package.json').version)"
}

version_nightly() {
  local version
  version=$(get_current_version)
  # Strip any existing pre-release suffix (e.g. -dev.xxx or -nightly.xxx)
  version=$(echo "$version" | sed 's/-.*$//')
  local stamp
  stamp=$(date -u +%Y%m%d)
  local pre="${version}-nightly.${stamp}"
  local current
  current=$(get_current_version)
  if [ "$current" = "$pre" ]; then
    echo "Version already set to: $pre (no change needed)"
  else
    echo "Bumping version to: $pre"
    npm version "$pre" --no-git-tag-version
  fi
}

version_dev() {
  local version
  version=$(get_current_version)
  # Strip any existing pre-release suffix (e.g. -dev.xxx or -nightly.xxx)
  version=$(echo "$version" | sed 's/-.*$//')
  local hash
  hash=$(git rev-parse --short HEAD)
  local pre="${version}-dev.${hash}"
  local current
  current=$(get_current_version)
  if [ "$current" = "$pre" ]; then
    echo "Version already set to: $pre (no change needed)"
  else
    echo "Bumping version to: $pre"
    npm version "$pre" --no-git-tag-version
  fi
}

case "$COMMAND" in
  nightly)
    echo "🌙 Publishing nightly release..."
    npm run compile
    bash scripts/check-isolated-deps.sh
    version_nightly
    npm publish --tag nightly
    echo "✅ Nightly published!"
    ;;
  dev)
    echo "🔧 Publishing dev release..."
    npm run compile
    bash scripts/check-isolated-deps.sh
    version_dev
    npm publish --tag dev
    echo "✅ Dev release published!"
    ;;
  stable|latest)
    echo "🚀 Publishing stable release..."
    npm run compile
    bash scripts/check-isolated-deps.sh
    npm publish --tag latest
    echo "✅ Stable release published!"
    ;;
  version:nightly)
    version_nightly
    ;;
  version:dev)
    version_dev
    ;;
  *)
    echo "Usage: $0 <nightly|dev|stable|version:nightly|version:dev>"
    echo ""
    echo "  nightly        - Compile, check deps, bump version with nightly stamp, publish to 'nightly' tag"
    echo "  dev            - Compile, check deps, bump version with git hash, publish to 'dev' tag"
    echo "  stable         - Compile, check deps, publish to 'latest' tag"
    echo "  version:nightly - Only bump version with nightly stamp (no publish)"
    echo "  version:dev     - Only bump version with git hash (no publish)"
    exit 1
    ;;
esac
