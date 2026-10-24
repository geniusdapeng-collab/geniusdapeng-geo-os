#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec "${NODE_BINARY:-node}" "$SCRIPT_DIR/../../scripts/package-deployment.mjs" "$@"
