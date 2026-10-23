// SPDX-License-Identifier: GPL-2.0-or-later
//
// Screenshot Editor
//
// Opens a separate annotation editor on every screenshot taken with GNOME
// Shell's own screenshot UI (Print key, quick-settings button).
//
// Why this is safe for the shell:
//  - Nothing is monkey-patched or overridden. The extension only connects to
//    the public 'screenshot-taken' signal of Main.screenshotUI, which GNOME
//    emits after the PNG has been written to disk and put on the clipboard.
//  - The editor is a separate process (a desktop-file launch, or a plain
//    `gjs -m` subprocess as a fallback). No editor code runs inside the shell.
//  - The only thing exported on D-Bus is Shell.CopyImage(ay), which validates
//    its input and hands the PNG to St.Clipboard exactly as GNOME's own
//    _storeScreenshot() does, so a copy outlives the editor window.
//  - Everything is undone in disable(): signal handler, pending timeout,
//    D-Bus object and bus name.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const DESKTOP_ID = 'info.katsarov.ScreenshotEditor.desktop';

// 0 launches synchronously from the signal handler; raise it if the editor
// ever needs to wait for the screenshot UI to finish closing.
const LAUNCH_DELAY_MS = 0;

// Main.screenshotUI._currentMode values (private, see screenshot.js UIMode):
// SCREENSHOT = 0, SCREENCAST = 1, SCREENSHOT_ONLY = 2. The portal
// (InteractiveScreenshot) uses SCREENSHOT_ONLY, and the mode is never reset
// after open(), so only SCREENSHOT means "the user pressed Print".
const UI_MODE_SCREENSHOT = 0;

const SERVICE_NAME = 'info.katsarov.ScreenshotEditor.Shell';
const OBJECT_PATH = '/info/katsarov/ScreenshotEditor/Shell';

const MAX_PNG_BYTES = 64 * 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const SERVICE_XML = `
<node>
  <interface name="${SERVICE_NAME}">
    <method name="CopyImage">
      <arg name="png" type="ay" direction="in"/>
    </method>
  </interface>
</node>
`;

function invalidArgs(message) {
    return new GLib.Error(Gio.DBusError, Gio.DBusError.INVALID_ARGS, message);
}

// Accepts the Uint8Array that GJS unpacks 'ay' into, or a GLib.Bytes, and
// returns validated PNG data as GLib.Bytes.
function pngToBytes(png) {
    let bytes, data;
    if (png instanceof GLib.Bytes) {
        bytes = png;
        data = png.toArray();
    } else if (png instanceof Uint8Array) {
        bytes = new GLib.Bytes(png);
        data = png;
    } else {
        throw invalidArgs('CopyImage expects a byte array');
    }

    if (data.length > MAX_PNG_BYTES)
        throw invalidArgs(`Image is too large (${data.length} bytes, max ${MAX_PNG_BYTES})`);
    if (data.length < PNG_SIGNATURE.length || PNG_SIGNATURE.some((b, i) => data[i] !== b))
        throw invalidArgs('Data is not a PNG image');

    return bytes;
}

class ClipboardService {
    constructor() {
        this._dbusObject = Gio.DBusExportedObject.wrapJSObject(SERVICE_XML, this);
        this._dbusObject.export(Gio.DBus.session, OBJECT_PATH);
        this._nameId = Gio.DBus.session.own_name(
            SERVICE_NAME,
            Gio.BusNameOwnerFlags.NONE,
            null,
            () => console.warn(`Screenshot Editor lost D-Bus name ${SERVICE_NAME}`));
    }

    destroy() {
        if (this._nameId) {
            Gio.DBus.session.unown_name(this._nameId);
            this._nameId = 0;
        }

        this._dbusObject?.unexport();
        this._dbusObject = null;
    }

    // D-Bus method: CopyImage(in ay png). A thrown GLib.Error becomes the
    // error reply, so callers see why a copy was rejected.
    CopyImage(png) {
        const bytes = pngToBytes(png);
        St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);
    }
}

export default class ScreenshotEditorExtension extends Extension {
    enable() {
        this._pendingLaunches = new Set();
        this._warnedNoMode = false;

        Main.screenshotUI.connectObject(
            'screenshot-taken', (_ui, file) => this._onScreenshotTaken(file),
            this);

        try {
            this._service = new ClipboardService();
        } catch (e) {
            // The editor still opens without D-Bus; Copy falls back to wl-copy.
            console.error('Screenshot Editor: could not export D-Bus service', e);
            this._service = null;
        }
    }

    disable() {
        Main.screenshotUI.disconnectObject(this);

        for (const id of this._pendingLaunches)
            GLib.Source.remove(id);
        this._pendingLaunches = null;

        this._service?.destroy();
        this._service = null;
    }

    _onScreenshotTaken(file) {
        try {
            if (!file)
                return;

            const mode = Main.screenshotUI._currentMode;
            if (typeof mode !== 'number') {
                if (!this._warnedNoMode) {
                    console.warn('Screenshot Editor: screenshotUI._currentMode is unavailable; ' +
                                 'opening the editor for every screenshot, including portal ones');
                    this._warnedNoMode = true;
                }
            } else if (mode !== UI_MODE_SCREENSHOT) {
                return;
            }

            if (LAUNCH_DELAY_MS > 0) {
                const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LAUNCH_DELAY_MS, () => {
                    this._pendingLaunches?.delete(id);
                    this._launchEditorSafely(file);
                    return GLib.SOURCE_REMOVE;
                });
                this._pendingLaunches.add(id);
            } else {
                this._launchEditorSafely(file);
            }
        } catch (e) {
            console.error('Screenshot Editor: failed to handle screenshot', e);
        }
    }

    _launchEditorSafely(file) {
        try {
            this._launchEditor(file);
        } catch (e) {
            console.error('Screenshot Editor: failed to launch editor', e);
        }
    }

    _launchEditor(file) {
        // A screenshot taken from the overview would otherwise open the
        // editor behind it, unfocused.
        if (Main.overview.visible)
            Main.overview.hide();

        const appInfo = Gio.DesktopAppInfo.new(DESKTOP_ID);
        if (appInfo) {
            // The launch context carries the Wayland activation token, so the
            // editor window is focused instead of just raising a notification.
            appInfo.launch_uris([file.get_uri()], global.create_app_launch_context(0, -1));
            return;
        }

        // Desktop file not installed: run the bundled editor directly.
        const path = file.get_path();
        if (!path)
            throw new Error(`Screenshot is not a local file: ${file.get_uri()}`);

        Gio.Subprocess.new(
            ['gjs', '-m', GLib.build_filenamev([this.path, 'editor', 'main.js']), path],
            Gio.SubprocessFlags.NONE);
    }
}
