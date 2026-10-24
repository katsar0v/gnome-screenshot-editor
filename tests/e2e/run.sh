#!/usr/bin/env bash
# End-to-end test in a throwaway headless GNOME Shell: its own session bus,
# data, config and Pictures directory, so your real session is untouched.
#
#   tests/e2e/run.sh          run and delete the temp dir afterwards
#   KEEP=1 tests/e2e/run.sh   keep it (screenshots of each step are in shots/)
#   tests/e2e/run.sh FILE.js  run another scenario in the same environment
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
# GNOME only adds screenshots to an existing recent-files list, as in a real session.
cat > "$E2E_DIR/data/recently-used.xbel" <<'XBEL'
<?xml version="1.0" encoding="UTF-8"?>
<xbel version="1.0" xmlns:bookmark="http://www.freedesktop.org/standards/desktop-bookmarks" xmlns:mime="http://www.freedesktop.org/standards/shared-mime-info"></xbel>
XBEL

export XDG_DATA_HOME="$E2E_DIR/data" XDG_CONFIG_HOME="$E2E_DIR/config"
export XDG_CACHE_HOME="$E2E_DIR/cache" XDG_STATE_HOME="$E2E_DIR/state"
export WAYLAND_DISPLAY="wl-e2e-$$"
unset DISPLAY GSETTINGS_BACKEND
# Services the test bus starts on demand (dconf, Extensions preferences,
# portals, the file manager) take their environment from the bus, not from
# this script. Point them at the test display and folders too, never at yours.
# This must run before anything starts dconf on the test bus: its dconf
# service then keeps settings in the test config folder, shared by the test
# shell, the editor and the gsettings CLI.
dbus-update-activation-environment XDG_DATA_HOME XDG_CONFIG_HOME XDG_CACHE_HOME \
    XDG_STATE_HOME WAYLAND_DISPLAY DISPLAY= \
    || { echo "could not isolate the test bus environment"; exit 1; }

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
# One at a time: back-to-back enables can overwrite each other's settings
# write, and the driver must load first so its sound spy sits under the
# extension's override.
gnome-extensions enable test-driver@scratch
gdbus wait --session --timeout 15 test.Driver || { echo "driver did not start"; tail -30 "$E2E_DIR/shell.log"; exit 1; }
gnome-extensions enable screenshot-editor@katsarov.info
gdbus wait --session --timeout 15 info.katsarov.ScreenshotEditor.Shell \
    || { echo "extension did not start"; tail -30 "$E2E_DIR/shell.log"; exit 1; }
sleep 1
gjs -m "$(realpath "${1:-$HERE/e2e.js}")" 2>> "$E2E_DIR/e2e.log"
