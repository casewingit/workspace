#!/usr/bin/env bash
# package.sh — Chrome 확장(MV3)을 배포 가능한 zip으로 패키징한다.
# 확장 런타임에 필요한 파일만 화이트리스트로 담고(테스트·문서·개발 스크립트 제외),
# dist/wandercut-v<version>.zip 을 생성한다. chrome://extensions 언팩 로드 또는
# Chrome Web Store 업로드에 그대로 사용할 수 있다.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v zip >/dev/null 2>&1; then
  echo "error: 'zip' 명령이 필요합니다." >&2
  exit 1
fi

VERSION="$(node -p "require('./manifest.json').version")"
OUT_DIR="dist"
STAGE="$OUT_DIR/wandercut"
ZIP="$OUT_DIR/wandercut-v${VERSION}.zip"

rm -rf "$OUT_DIR"
mkdir -p "$STAGE/src" "$STAGE/icons"

# 확장 동작에 필요한 파일만 명시적으로 포함(allowlist)
cp manifest.json \
   popup.html popup.css popup.js \
   editor.html editor.css editor.js \
   "$STAGE/"
cp src/bpm.js src/metadata.js src/renderer.js src/timeline.js "$STAGE/src/"
cp icons/icon16.png icons/icon48.png icons/icon128.png "$STAGE/icons/"

# 재현 가능한 zip(-X: 확장 속성 제거)
( cd "$STAGE" && zip -r -X "../wandercut-v${VERSION}.zip" . >/dev/null )

echo "Built ${ZIP} (version ${VERSION})"
( cd "$STAGE" && find . -type f | sort | sed 's/^\.\//  - /' )
