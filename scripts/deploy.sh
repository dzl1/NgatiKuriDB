#!/usr/bin/env bash
# Deploys the app code to App Service. Only the files listed below are uploaded:
# the data folder (BMSData.accdb) is never part of the package.
#
#   RESOURCE_GROUP=ngatikuri-rg WEB_APP=<name> ./scripts/deploy.sh
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-ngatikuri-rg}"
WEB_APP="${WEB_APP:-$(az webapp list -g "$RESOURCE_GROUP" --query "[0].name" -o tsv)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE="$(mktemp -d)/harbour.zip"

cd "$ROOT"
zip -qr "$PACKAGE" package.json package-lock.json server.js src public -x '*.DS_Store'
if unzip -l "$PACKAGE" | grep -qiE '\.(accdb|accde|mdb)$'; then
  echo "Refusing to deploy: the package contains a database file." >&2
  exit 1
fi

az webapp deploy -g "$RESOURCE_GROUP" -n "$WEB_APP" --src-path "$PACKAGE" --type zip --track-status true -o none
echo "Deployed to https://$(az webapp show -g "$RESOURCE_GROUP" -n "$WEB_APP" --query defaultHostName -o tsv)"
