#!/usr/bin/env bash
#
# Reports versions that are published to the release origin but have no
# corresponding GitHub release.
#
# Why this exists: publishing and mirroring are two different actions, and the
# mirror is the one that happens last. Under hotfix pressure it is the step that
# gets dropped, and nothing downstream ever notices — the installer is happy, the
# updater is happy, and the public repository quietly falls behind. On
# 2026-08-03 it was two releases behind and had been for a day.
#
# The public repository is a squashed source export, so a version that was not
# exported when it shipped cannot be tagged honestly later: the commit that
# eventually carried it also carries every version after it. That makes this a
# detector, not a repair tool. Run it before calling a release finished, while
# the export can still be made truthfully.
#
# Exit status: 0 clean, 1 drift found, 2 could not determine.

set -euo pipefail

# Hardcoded on purpose, and deliberately not overridable. This asks "is the
# public repository consistent with what the public origin actually serves", so
# pointing it at a private or test origin would only let it answer a question
# nobody asked. The release-origin static validator also refuses any reference to
# the installer's origin override outside the installer itself.
RELEASE_ORIGIN="https://bridgesllm.ai"
GITHUB_REPO="${BRIDGESLLM_GITHUB_REPO:-BridgesLLM-ai/portal}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v gh >/dev/null 2>&1 || { echo "gh CLI is required" >&2; exit 2; }

# Published versions. Prefer the local document root when this runs on the host
# that serves the releases, because the directory listing is authoritative there
# and needs no network. Otherwise ask the origin.
published=""
docroot="${BRIDGESLLM_MARKETING_DOCROOT:-/var/www/bridgesllm-marketing/dist}"
if [[ -d "$docroot/releases" ]]; then
  published="$(find "$docroot/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null || true)"
else
  # No listing endpoint is guaranteed, so fall back to the versions the
  # changelog claims and confirm each one actually resolves.
  while read -r v; do
    if curl -fsS -o /dev/null --max-time 20 "$RELEASE_ORIGIN/releases/$v/portal-release.manifest"; then
      published+="$v"$'\n'
    fi
  done < <(grep -oE '^## \[[0-9]+\.[0-9]+\.[0-9]+\]' "$REPO_ROOT/CHANGELOG.md" | tr -d '#[] ')
fi

published="$(printf '%s\n' "$published" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V || true)"
[[ -n "$published" ]] || { echo "Could not determine published versions" >&2; exit 2; }

released="$(gh release list --repo "$GITHUB_REPO" --limit 200 --json tagName --jq '.[].tagName' | sed 's/^v//' | sort -V)"

# A version documented as withdrawn was pulled on purpose. Mirroring it would
# advertise a build nobody should install, so absence is the correct state.
withdrawn="$(sed -n '/^### Withdrawn/,/^## \[/p' "$REPO_ROOT/CHANGELOG.md" \
  | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | sort -uV || true)"

drift=0
while read -r v; do
  [[ -n "$v" ]] || continue
  if grep -qx "$v" <<<"$released"; then continue; fi
  if grep -qx "$v" <<<"$withdrawn"; then
    echo "  ok       $v  published, no release — withdrawn in CHANGELOG"
    continue
  fi
  echo "  DRIFT    $v  published to $RELEASE_ORIGIN with no v$v GitHub release"
  drift=1
done <<<"$published"

if (( drift )); then
  echo
  echo "The public repository is behind. If the missing version is the one being"
  echo "shipped right now, finish the export and tag it. If it already shipped,"
  echo "the tree is gone — say so in the notes of the release that carries the"
  echo "code rather than backfilling a tag that never built that version."
  exit 1
fi

echo "No drift: every published version has a GitHub release."
