#!/bin/sh
set -eu
directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' 'Install Node.js 22.12 or newer from https://nodejs.org/ and try again.' >&2
    exit 1
fi
exec node "$directory/setup.mjs"
