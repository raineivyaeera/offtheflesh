#!/usr/bin/env bash
# launch of the flesh locally
set -e
cd "$(dirname "$0")"

if [ ! -d node_modules/marked ]; then
	echo "installing dependencies..."
	npm install
fi

if command -v xdg-open >/dev/null 2>&1; then
	( sleep 1; xdg-open http://localhost:4321 >/dev/null 2>&1 || true ) &
fi

echo "of the flesh — http://localhost:4321"
npm run dev
