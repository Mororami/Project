#!/bin/bash
set -euo pipefail

# Claude Code 클라우드 세션에서만 실행
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# .claude/skills/bithumb-* 스킬이 내부적으로 bithumb CLI를 호출하므로 미설치 시 설치
if ! command -v bithumb >/dev/null 2>&1; then
  npm install -g @bithumb-official/bithumb-cli
fi
