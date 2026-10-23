#!/usr/bin/env bash
# End-to-end test in a throwaway headless GNOME Shell: its own session bus,
# data, config and Pictures directory, so your real session is untouched.
#
#   tests/e2e/run.sh          run and delete the temp dir afterwards
#   KEEP=1 tests/e2e/run.sh   keep it (screenshots of each step are in shots/)
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$HERE/../.." && pwd -P)"

if [[ -z "${E2E_INNER:-}" ]]; then
    exec dbus-run-session -- env E2E_INNER=1 "$0" "$@"
fi

E2E_DIR="$(mktemp -d -t screenshot-editor-e2e.XXXXXX)"
export E2E_DIR
mkdir -p "$E2E_DIR"/{data/gnome-shell/extensions,config,cache,state,pictures/Screenshots,shots}
echo "XDG_PICTURES_DIR=\"$E2E_DIR/pictures\"" > "$E2E_DIR/config/user-dirs.dirs"
cp -r "$HERE/driver" "$E2E_DIR/data/gnome-shell/extensions/test-driver@scratch"

export XDG_DATA_HOME="$E2E_DIR/data" XDG_CONFIG_HOME="$E2E_DIR/config"
export XDG_CACHE_HOME="$E2E_DIR/cache" XDG_STATE_HOME="$E2E_DIR/state"
export GSETTINGS_BACKEND=memory WAYLAND_DISPLAY="wl-e2e-$$"
unset DISPLAY

cleanup() {
    kill "$SHELL_PID" 2>/dev/null
    wait "$SHELL_PID" 2>/dev/null
    if [[ -n "${KEEP:-}" ]]; then
        echo "Kept $E2E_DIR"
    else
        rm -rf "$E2E_DIR"
    fi
}

"$ROOT/install.sh" > "$E2E_DIR/install.log" 2>&1 || { cat "$E2E_DIR/install.log"; exit 1; }
gnome-shell --headless --wayland --no-x11 --sm-disable --virtual-monitor 1600x1000 \
    --wayland-display "$WAYLAND_DISPLAY" > "$E2E_DIR/shell.log" 2>&1 &
SHELL_PID=$!
trap cleanup EXIT

gdbus wait --session --timeout 40 org.gnome.Shell || { echo "shell did not start"; tail -30 "$E2E_DIR/shell.log"; exit 1; }
sleep 2
gnome-extensions enable test-driver@scratch
gnome-extensions enable screenshot-editor@katsarov.info
gdbus wait --session --timeout 15 test.Driver || { echo "driver did not start"; tail -30 "$E2E_DIR/shell.log"; exit 1; }
sleep 1
gjs -m "$HERE/e2e.js" 2>> "$E2E_DIR/e2e.log"
