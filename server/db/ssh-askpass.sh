#!/bin/sh
# OpenSSH SSH_ASKPASS wrapper invoking DataDip's Bun askpass helper without relying on PATH.
exec "$DATADIP_BUN" "$DATADIP_ASKPASS_SCRIPT" "$@"
