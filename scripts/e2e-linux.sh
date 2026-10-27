#!/usr/bin/env bash
# Regenerates Linux screenshot baselines (the ones CI compares against) inside the
# official Playwright image, so fonts and rendering match ubuntu CI runners.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(pnpm exec playwright --version | awk '{print $2}')
docker run --rm -v "$PWD":/src:ro -v "$PWD/tests/e2e":/out -w /work \
  "mcr.microsoft.com/playwright:v${version}-noble" bash -euc '
    tar -C /src --exclude=./node_modules --exclude=./.git --exclude="*/node_modules" -cf - . | tar -xf -
    corepack enable >/dev/null && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile >/dev/null
    # only specs with screenshot baselines; the panel stack needs Docker, which this container lacks
    pnpm exec playwright test tests/e2e/test-site.spec.ts --update-snapshots
    cd tests/e2e && find . -name "*-linux.png" | tar -cf - -T - | tar -C /out -xf -'
