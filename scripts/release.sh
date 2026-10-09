#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI_DIR="$PROJECT_ROOT/apps/desktop/src-tauri"
VERSION="$(node -p "require('$TAURI_DIR/tauri.conf.json').version")"
ARCH="$(uname -m)"
if [ "$ARCH" = "arm64" ]; then
  ARCH_SUFFIX="aarch64"
else
  ARCH_SUFFIX="x64"
fi
PKG_PATH="$TAURI_DIR/target/release/bundle/pkg/LMMs-Lab_Writer_${VERSION}_${ARCH_SUFFIX}.pkg"
DMG_PATH="$TAURI_DIR/target/release/bundle/dmg/Y-Writer_${VERSION}_${ARCH_SUFFIX}.dmg"
APP_PATH="$TAURI_DIR/target/release/bundle/macos/Y-Writer.app"
RELEASE_TAG="v${VERSION}"
RELEASE_URL="https://github.com/EvolvingLMMs-Lab/lmms-lab-writer/releases/tag/${RELEASE_TAG}"
DMG_ASSET_NAME="LMMs-Lab.Writer_${VERSION}_${ARCH_SUFFIX}.dmg"
PKG_ASSET_NAME="LMMs-Lab_Writer_${VERSION}_${ARCH_SUFFIX}.pkg"

UPLOAD_GITHUB_RELEASE="${PUBLISH_GITHUB_RELEASE:-1}"
CREATE_GITHUB_RELEASE="${CREATE_GITHUB_RELEASE:-0}"

while [ $# -gt 0 ]; do
  case "$1" in
    --github-release)
      UPLOAD_GITHUB_RELEASE=1
      ;;
    --create-github-release)
      UPLOAD_GITHUB_RELEASE=1
      CREATE_GITHUB_RELEASE=1
      ;;
    --no-github-release)
      UPLOAD_GITHUB_RELEASE=0
      ;;
    -h|--help)
      echo "Usage: ./scripts/release.sh [--github-release] [--create-github-release] [--no-github-release]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: ./scripts/release.sh [--github-release] [--create-github-release] [--no-github-release]"
      exit 1
      ;;
  esac
  shift
done

echo "=========================================="
echo "Y-Writer Release Script"
echo "=========================================="
echo ""

cd "$PROJECT_ROOT"

echo "[1/5] Building Tauri app..."
pnpm tauri:build

echo ""
echo "[2/5] Building DMG and PKG installers..."
./scripts/build-dmg.sh
./scripts/build-pkg.sh

echo ""
echo "[3/5] Uploading to GitHub Release..."
if [ "$UPLOAD_GITHUB_RELEASE" = "1" ]; then
  GH_ARGS=()
  if [ "$CREATE_GITHUB_RELEASE" = "1" ]; then
    GH_ARGS+=(--create)
  fi
  ./scripts/upload-to-github-release.sh "${GH_ARGS[@]}"
else
  echo "Skipped. This disables distribution artifacts upload."
fi

echo ""
echo "[4/5] Updating Homebrew cask..."
NEW_SHA=$(shasum -a 256 "$PKG_PATH" | awk '{print $1}')
cd /tmp
rm -rf homebrew-tap
git clone https://github.com/EvolvingLMMs-Lab/homebrew-tap.git
cd homebrew-tap
sed -i '' "s/sha256 \".*\"/sha256 \"$NEW_SHA\"/" Casks/lmms-lab-writer.rb
git add -A
git commit -m "chore: update sha256 for $(date +%Y-%m-%d)"
git push
cd "$PROJECT_ROOT"

echo ""
echo "[5/5] Opening app bundle..."
open "$APP_PATH"

echo ""
echo "=========================================="
echo "✓ Release complete!"
echo "=========================================="
echo ""
echo "Downloads:"
echo "  Release: ${RELEASE_URL}"
echo "  DMG: https://github.com/EvolvingLMMs-Lab/lmms-lab-writer/releases/download/${RELEASE_TAG}/${DMG_ASSET_NAME}"
echo "  PKG: https://github.com/EvolvingLMMs-Lab/lmms-lab-writer/releases/download/${RELEASE_TAG}/${PKG_ASSET_NAME}"
echo "  Homebrew: brew install --cask EvolvingLMMs-Lab/tap/lmms-lab-writer"
echo ""
echo "GitHub Release:"
echo "  Tag: ${RELEASE_TAG}"
echo "  URL: ${RELEASE_URL}"
echo "  Upload (existing release): ./scripts/upload-to-github-release.sh"
echo "  Upload (create if missing): ./scripts/upload-to-github-release.sh --create"
echo ""
