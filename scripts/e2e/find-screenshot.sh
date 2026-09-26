#!/usr/bin/env bash
# Print the path of a file a Maestro flow wrote with `takeScreenshot`.
#
# Where that file lands depends on the Maestro version, and CI installs the
# latest CLI every run:
#   - older CLIs wrote it into the current working directory;
#   - some resolved it against the flow's directory tree (maestro#1911);
#   - current CLIs (per-flow artifact bundles, revamped in 2.7.0) write it
#     into the flow's bundle: ~/.maestro/tests/<session>/<flow>/takeScreenshot/,
#     or under --test-output-dir when that is given.
# So look in all of them rather than trust one.
#
# Usage: find-screenshot.sh <name.png> <flow-dir> [<newer-than-file>]
#   <flow-dir>         the directory holding the flow (e.g. .maestro)
#   <newer-than-file>  if given, only files modified after it count, so a
#                      stale screenshot from an earlier run is never checked
# Prints the path on stdout and exits 0; exits 1 (listing where it looked)
# when there is no such file.
set -u
NAME=$1
FLOW_DIR=$2
MARK=${3:-}

fresh() { [ -f "$1" ] && { [ -z "$MARK" ] || [ "$1" -nt "$MARK" ]; }; }

for candidate in "$PWD/$NAME" "$FLOW_DIR/$NAME"; do
  if fresh "$candidate"; then
    echo "$candidate"
    exit 0
  fi
done

# Anywhere under the flow dir or Maestro's default artifact root: newest wins
# (a retried flow leaves one per attempt).
ROOTS=()
for root in "$FLOW_DIR" "$HOME/.maestro/tests"; do [ -d "$root" ] && ROOTS+=("$root"); done
NEWEST=""
if [ ${#ROOTS[@]} -gt 0 ]; then
  while IFS= read -r -d '' f; do
    fresh "$f" || continue
    if [ -z "$NEWEST" ] || [ "$f" -nt "$NEWEST" ]; then NEWEST=$f; fi
  done < <(find "${ROOTS[@]}" -type f -name "$NAME" -print0 2>/dev/null)
fi
if [ -n "$NEWEST" ]; then
  echo "$NEWEST"
  exit 0
fi

echo "no ${MARK:+fresh }$NAME in $PWD, $FLOW_DIR (recursively) or $HOME/.maestro/tests" >&2
exit 1
