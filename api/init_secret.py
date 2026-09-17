"""Provision the shared TURN/JWT signing secret on first boot.

Idempotent: writes a random 256-bit key to SECRET_FILE only if it does not
exist yet, so the key rotates only when the volume holding it is deleted.
"""

import os
import secrets

PATH = os.getenv("SECRET_FILE", "/keys/secret")

if os.path.exists(PATH):
    # Enforce perms on existing files (heals stacks provisioned with older versions).
    os.chmod(PATH, 0o644)
else:
    # 0644: the coturn image runs as nobody:nogroup and must read the file; the
    # project-scoped volume is the confidentiality boundary, not unix perms.
    os.umask(0o022)
    # "x" mode is O_CREAT|O_EXCL: a generation race fails loudly instead of
    # silently producing two different keys.
    with open(PATH, "x") as f:
        f.write(secrets.token_hex(32))
