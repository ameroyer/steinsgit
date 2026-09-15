#!/usr/bin/env bash
# Build a throwaway repository with a believable branching history so the
# viewer has something to show. Safe: it only ever writes inside $TARGET.
set -euo pipefail

TARGET="${1:-/tmp/steinsgit-demo}"

if [ -e "$TARGET" ]; then
  echo "refusing to overwrite existing path: $TARGET" >&2
  echo "pass a different path, or remove it yourself first." >&2
  exit 1
fi

mkdir -p "$TARGET"
cd "$TARGET"
git init -q -b main
git config user.name "Rintaro Okabe"
git config user.email "okarin@futuregadget.lab"
git config commit.gpgsign false

DAY=0
commit() { # commit <days-ago> <author> <subject>
  local ago="$1" who="$2" subject="$3"
  local when
  when="$(date -u -v-"${ago}"d +"%Y-%m-%dT%H:%M:%S" 2>/dev/null || date -u -d "${ago} days ago" +"%Y-%m-%dT%H:%M:%S")"
  GIT_AUTHOR_NAME="$who" GIT_COMMITTER_NAME="$who" \
  GIT_AUTHOR_EMAIL="${who// /.}@futuregadget.lab" GIT_COMMITTER_EMAIL="${who// /.}@futuregadget.lab" \
  GIT_AUTHOR_DATE="$when" GIT_COMMITTER_DATE="$when" \
  git commit -q -m "$subject"
}

w() { mkdir -p "$(dirname "$1")"; printf '%b\n' "$2" >> "$1"; }

# bulk <file> <lines> <label> - append N generated lines, so commit sizes vary
# realistically and the per-commit size score has something to show.
bulk() {
  mkdir -p "$(dirname "$1")"
  local n=$2 label=$3 i=1
  while [ "$i" -le "$n" ]; do
    printf '%s_%03d = %d  # %s\n' "$label" "$i" $((i * 7 % 97)) "$label" >> "$1"
    i=$((i + 1))
  done
}

# ---------------------------------------------------------------- main line
w README.md "# Future Gadget Lab"
w README.md "Operation Urd. Do not tell the Organization."
w src/core.py "def boot():\n    return 'lab online'"
git add -A; commit 120 "Rintaro Okabe" "Initial lab manifest"

w src/core.py "TUBE_COUNT = 8"
w src/registry.py "LAB_MEMBERS = ['okabe', 'mayuri', 'daru']"
git add -A; commit 112 "Itaru Hashida" "Add lab member registry"

w src/core.py "def status():\n    return {'divergence': 0.0}"
git add -A; commit 104 "Rintaro Okabe" "Report divergence in core status"

w tests/test_core.py "def test_boot():\n    assert True"
git add -A; commit 96 "Kurisu Makise" "Add a real test, for once"

# ------------------------------------------------- branch: phone microwave
git checkout -q -b feature/phone-microwave
w src/microwave.py "class PhoneMicrowave:\n    def __init__(self):\n        self.bananas = 0"
git add -A; commit 88 "Itaru Hashida" "Scaffold the phone microwave (name subject to change)"
w src/microwave.py "    def send(self, mail):\n        return len(mail) <= 36"
git add -A; commit 84 "Itaru Hashida" "Cap D-Mail payload at 36 bytes"
w src/core.py "MICROWAVE_ATTACHED = True"
w src/registry.py "LAB_MEMBERS.append('suzuha')"
git add -A; commit 79 "Rintaro Okabe" "Wire the microwave into core boot"
w src/microwave.py "    def gelify(self, item):\n        raise RuntimeError('do not')"
bulk src/microwave_tables.py 240 GEL_CONST
bulk src/microwave_calib.py 95 CALIB
git add -A; commit 71 "Itaru Hashida" "Handle the banana incident (adds gel lookup tables)"
w tests/test_microwave.py "def test_payload_cap():\n    assert True"
git add -A; commit 63 "Kurisu Makise" "Test the payload cap"
w src/microwave.py "    TIMER_SECONDS = 3.4"
git add -A; commit 12 "Itaru Hashida" "Tune the timer after the 3.4s incident"

# ---------------------------------------------- branch: divergence meter
git checkout -q main
w src/core.py "def tubes():\n    return TUBE_COUNT"
git add -A; commit 90 "Rintaro Okabe" "Expose tube count"

git checkout -q -b feature/divergence-meter
w src/meter.py "NIXIE_DIGITS = 7\n\ndef render(value):\n    return f'{value:.6f}'"
git add -A; commit 58 "Kurisu Makise" "Nixie tube renderer"
w src/meter.py "ATTRACTOR_FIELDS = ['alpha', 'beta']"
bulk src/meter_glyphs.py 160 GLYPH
git add -A; commit 51 "Kurisu Makise" "Name the attractor fields, add glyph table"
w tests/test_meter.py "def test_render():\n    assert True"
git add -A; commit 44 "Kurisu Makise" "Cover the renderer"

# -------------------------------------------------- branch: SERN detection
git checkout -q main
w src/net.py "def ping(host):\n    return 0"
git add -A; commit 80 "Itaru Hashida" "Basic network probe"

git checkout -q -b fix/sern-detection
w src/net.py "BLOCKLIST = ['sern.ch']"
git add -A; commit 9 "Itaru Hashida" "Flag known Organization hosts"
w src/net.py "def is_watched(host):\n    return host in BLOCKLIST"
git add -A; commit 6 "Itaru Hashida" "Expose is_watched()"

# ------------------------------- branch: time leap machine (stale and huge)
git checkout -q main
git checkout -q -b experiment/time-leap-machine
for i in 1 2 3 4 5 6 7 8; do
  w "src/timeleap/module_${i}.py" "# module ${i}"
  bulk "src/timeleap/module_${i}.py" $((i * 22)) "STAGE${i}"
  git add -A; commit $((78 - i * 3)) "Kurisu Makise" "Time leap module ${i}: memory transfer stage"
done
w src/core.py "TIME_LEAP_ENABLED = False  # experimental"
w src/registry.py "LAB_MEMBERS = ['okabe', 'mayuri', 'daru', 'kurisu', 'faris', 'ruka']"
git add -A; commit 52 "Kurisu Makise" "Rewrite the member registry for time leap contexts"

# ---------------------------------- main keeps moving (creates contested files)
git checkout -q main
w src/registry.py "def is_member(name):\n    return name in LAB_MEMBERS"
git add -A; commit 40 "Rintaro Okabe" "Add membership lookup"
w src/core.py "def shutdown():\n    return 'el psy congroo'"
bulk src/telemetry.py 130 TELEM
git add -A; commit 30 "Rintaro Okabe" "Graceful shutdown plus telemetry counters"
w README.md "## Warning\nThe Organization is watching."
git add -A; commit 21 "Mayuri Shiina" "Tuturu! Add a warning to the README"
w src/registry.py "LAB_MEMBERS.append('moeka')"
git add -A; commit 14 "Rintaro Okabe" "Register lab member 007"
w tests/test_registry.py "def test_lookup():\n    assert True"
git add -A; commit 5 "Kurisu Makise" "Test membership lookup"

# ------------------------------------------- a merge, so the graph has a join
git checkout -q -b release/beta
git merge -q --no-ff --no-edit feature/divergence-meter -m "Merge divergence meter into beta line"
w CHANGELOG.md "## beta\n- divergence meter"
git add -A; commit 3 "Rintaro Okabe" "Start the beta changelog"

git checkout -q main
git config user.name "Rintaro Okabe"

# A remote so the viewer can infer GitHub links. Nothing is ever pushed.
git remote add origin git@github.com:futuregadgetlab/steins-gate.git

echo
echo "demo repository ready: $TARGET"
git -C "$TARGET" log --oneline --graph --all --decorate -n 20
echo
echo "run:  ./steinsgit.py $TARGET"
