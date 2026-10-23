# Private desktop WebSocket runtime

Websockify 0.13.0, by Joel Martin and contributors, from https://github.com/novnc/websockify.
The unmodified upstream Python wheel is distributed under LGPLv3; see COPYING and the wheel metadata.

Pinned wheel SHA-256: `ac497a8dafc7f51d28ca989f01cdf5f8add663a497d425a56b159dcb8d6a314c`.

Portal runs only the fixed Unix-socket bridge with its own authenticated gateway.
The OS websockify on supported Ubuntu hosts may lack Unix-listener support, so the
signed Portal bundle supplies this isolated module without replacing system Python
packages or downloading packages at desktop startup. The core bridge needs only
Python's standard library. System NumPy is an optional acceleration; token/auth
plugins requiring requests, jwcrypto or redis are not enabled by Portal.
