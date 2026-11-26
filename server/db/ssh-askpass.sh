#!/bin/sh
# OpenSSH SSH_ASKPASS wrapper invoking DataDip's askpass helper (dev script or compiled binary) without relying on PATH.
if [ -n "$DATADIP_ASKPASS_SCRIPT" ]; then
	exec "$DATADIP_BUN" "$DATADIP_ASKPASS_SCRIPT" "$@"
fi
exec "$DATADIP_BUN" __ssh_askpass "$@"
