#!/bin/sh
set -eu
export NPM_CONFIG_REGISTRY='https://registry.npmjs.org/'
npm ci --registry='https://registry.npmjs.org/'
mkdir -p dist
cp server.js run.sh package.json package-lock.json dist/
cp -R node_modules dist/node_modules
chmod 755 dist/run.sh
