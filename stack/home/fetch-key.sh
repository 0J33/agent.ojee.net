#!/usr/bin/env bash
# Fetch the AC's local encryption key from your Haismart account — once.
#
# Run this yourself; it prompts for the password on the terminal and never takes it as an
# argument, so it stays out of your shell history, out of this repo, and out of any logs.
#
# After this, nothing touches Haier's servers again: the hub talks to the AC directly on
# tcp/56800. The key rotates server-side unless you block the AC's outbound internet — see
# SETUP.md, "Freezing the key".
#
#   ./fetch-key.sh                       # list every AC on the account, with keys
#   ./fetch-key.sh 94224C108338          # just this one
set -euo pipefail

DEVICE="${1:-}"
REGION="${HAIER_REGION:-20}"     # phone dialling code of the country the ACCOUNT was registered in
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "${HAIER_USERNAME:-}" ]; then
  read -r -p "Haismart account email or phone: " HAIER_USERNAME
fi

cat <<EOF

  account   ${HAIER_USERNAME}
  region    ${REGION}   (dialling code of the country the ACCOUNT was registered in, not
                        where the AC is installed — a wrong one reports as "account is not
                        registered", which reads exactly like a wrong password.
                        Override with HAIER_REGION=xx)
  device    ${DEVICE:-<all on the account>}

You will be prompted for the account password next. It is read directly by the tool and is
never passed as an argument.

EOF

exec docker run --rm -it \
  -v "${HERE}/vendor:/vendor:ro" \
  -w /vendor \
  -e PYTHONPATH=/vendor \
  python:3.12-slim \
  bash -lc "pip install --quiet --disable-pip-version-check 'cryptography>=41' 'httpx>=0.27' >/dev/null 2>&1 && \
            python -m haismart_extractor.cli \
              --username '${HAIER_USERNAME}' \
              --region '${REGION}' \
              ${DEVICE:+--device '${DEVICE}'}"
