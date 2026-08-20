#!/bin/bash
# Validate the toolchain needed to build and deploy the CDK app.
# Exits non-zero (with a clear message) on the first missing prerequisite.
set -euo pipefail

MIN_NODE_MAJOR=18

fail() {
  echo "[ERROR] - $1"
  exit 1
}

# Required executables.
command -v node >/dev/null 2>&1 || fail "node is not installed."
command -v npm  >/dev/null 2>&1 || fail "npm is not installed."
command -v npx  >/dev/null 2>&1 || fail "npx is not installed."
command -v aws  >/dev/null 2>&1 || fail "AWS CLI is not installed."

# Node major version.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  fail "node $MIN_NODE_MAJOR+ required, found $(node --version)."
fi

echo "[OK] - node $(node --version), npm $(npm --version), aws present"
