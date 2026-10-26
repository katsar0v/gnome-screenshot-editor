#!/usr/bin/env bash
# Install or remove the Screenshot Editor extension for the current user.
#
#   ./install.sh              symlink the extension and generate the .desktop file
#   ./install.sh --uninstall  disable the extension and remove both again
#
# Only the user's own data directory is touched; nothing is enabled here.
set -euo pipefail

UUID="screenshot-editor@katsarov.info"
APP_ID="info.katsarov.ScreenshotEditor"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
EXT_LINK="$DATA_HOME/gnome-shell/extensions/$UUID"
APPS_DIR="$DATA_HOME/applications"
DESKTOP_DST="$APPS_DIR/$APP_ID.desktop"
DESKTOP_TEMPLATE="$ROOT/data/$APP_ID.desktop.in"
EXT_SRC="$ROOT/extension"

die() {
    echo "error: $*" >&2
    exit 1
}

update_desktop_database() {
    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "$APPS_DIR" || true
    fi
}

do_install() {
    [[ -f "$EXT_SRC/extension.js" && -f "$EXT_SRC/metadata.json" ]] \
        || die "extension files not found in $EXT_SRC"
    [[ -f "$DESKTOP_TEMPLATE" ]] || die "missing template $DESKTOP_TEMPLATE"

    local editor_dir
    editor_dir="$(realpath "$EXT_SRC/editor")"
    [[ -f "$editor_dir/main.js" ]] || die "editor entry point not found: $editor_dir/main.js"
    # The path ends up inside a quoted Exec= value; keep it free of characters
    # that the desktop-entry spec treats specially there.
    case "$editor_dir" in
        *[\"\\\`\$%\&]*) die "editor path contains characters not allowed in an Exec= line: $editor_dir" ;;
    esac

    glib-compile-schemas "$EXT_SRC/schemas" || die "could not compile the settings schema"
    echo "Compiled $EXT_SRC/schemas/gschemas.compiled"

    mkdir -p "$(dirname "$EXT_LINK")" "$APPS_DIR"

    if [[ -L "$EXT_LINK" ]]; then
        ln -sfn "$EXT_SRC" "$EXT_LINK"
    elif [[ -e "$EXT_LINK" ]]; then
        die "$EXT_LINK exists and is not a symlink; refusing to replace it. Move it away first."
    else
        ln -s "$EXT_SRC" "$EXT_LINK"
    fi
    echo "Linked   $EXT_LINK -> $EXT_SRC"

    local content
    shopt -u patsub_replacement 2>/dev/null || true
    content="$(<"$DESKTOP_TEMPLATE")"
    printf '%s\n' "${content//@EDITOR_DIR@/$editor_dir}" > "$DESKTOP_DST"
    echo "Wrote    $DESKTOP_DST"
    if command -v desktop-file-validate >/dev/null 2>&1; then
        desktop-file-validate "$DESKTOP_DST" || echo "warning: desktop file did not validate" >&2
    fi

    update_desktop_database

    cat <<EOF

Installed. Next steps:
  1. On Wayland, log out and back in once so GNOME Shell discovers the new extension.
  2. Enable it:  gnome-extensions enable $UUID
  3. Take a screenshot with Print; the editor opens on the saved file.
EOF
}

do_uninstall() {
    gnome-extensions disable "$UUID" 2>/dev/null || true

    if [[ -L "$EXT_LINK" ]]; then
        rm "$EXT_LINK"
        echo "Removed  $EXT_LINK"
    elif [[ -e "$EXT_LINK" ]]; then
        echo "warning: $EXT_LINK is not a symlink; leaving it in place" >&2
    fi

    if [[ -e "$DESKTOP_DST" ]]; then
        rm "$DESKTOP_DST"
        echo "Removed  $DESKTOP_DST"
    fi

    update_desktop_database
    echo "Uninstalled. GNOME Shell may keep the extension loaded until the next login."
}

case "${1:-}" in
    "")          do_install ;;
    --uninstall) do_uninstall ;;
    -h|--help)   sed -n '2,8p' "${BASH_SOURCE[0]}" ;;
    *)           die "unknown option: $1 (usage: $0 [--uninstall])" ;;
esac
