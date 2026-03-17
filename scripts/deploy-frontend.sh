#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/frontend/dist"
ASSETS="$ROOT/assets"

cd "$ROOT/frontend"
npm run build

mkdir -p "$ASSETS"
rm -rf "$ASSETS/assets"
find "$ASSETS" -maxdepth 1 -type f \( -name 'index.html' -o -name 'vite.svg' \) -delete
cp -r "$DIST"/* "$ASSETS"/

echo "Frontend deployed cleanly to $ASSETS"
