// SPDX-License-Identifier: GPL-2.0-or-later
//
// Screenshot Editor
//
// Opens a separate annotation editor on every screenshot taken with GNOME
// Shell's own screenshot UI (Print key, quick-settings button).
//
// Why this is safe for the shell:
//  - GNOME's screenshot code is not patched. The extension connects to the
//    public 'screenshot-taken' signal of Main.screenshotUI, which GNOME emits
//    after the PNG has been written to disk and put on the clipboard.
//  - The one override is optional: with the "play-sound" setting off,
//    Meta.SoundPlayer.play_from_theme() skips the 'screen-capture' sound.
//    InjectionManager restores the original on disable.
//  - The editor is a separate process (a desktop-file launch, or a plain
//    `gjs -m` subprocess as a fallback). No editor code runs inside the shell.
//  - D-Bus exports two methods for the editor: CopyImage(ay), which validates
//    its input and hands the PNG to St.Clipboard exactly as GNOME's own
//    _storeScreenshot() does, so a copy outlives the editor window; and
//    ClaimScreenshot(s), which tells the editor whether a file is a screenshot
//    this extension just handed to it (only those may be deleted on close
//    when "keep-screenshots" is off).
//  - Everything is undone in disable(): signal handler, pending timeout,
//    sound override, D-Bus object and bus name.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
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

// The sound GNOME plays in captureScreenshot() and the screenshot D-Bus API.
const SHUTTER_SOUND = 'screen-capture';

// Named explicitly rather than read from metadata.json, as in prefs.js.
const SCHEMA_ID = 'org.gnome.shell.extensions.screenshot-editor';

const SERVICE_NAME = 'info.katsarov.ScreenshotEditor.Shell';
const OBJECT_PATH = '/info/katsarov/ScreenshotEditor/Shell';

const MAX_PNG_BYTES = 64 * 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Screenshots handed to the editor but not claimed yet (e.g. it failed to
// start) are forgotten after this many, oldest first.
const MAX_PENDING_CLAIMS = 50;

const SERVICE_XML = `
<node>
  <interface name="${SERVICE_NAME}">
    <method name="CopyImage">
      <arg name="png" type="ay" direction="in"/>
    </method>
    <method name="ClaimScreenshot">
      <arg name="path" type="s" direction="in"/>
      <arg name="handed_off" type="b" direction="out"/>
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

class EditorService {
    constructor() {
        this._handedOff = new Set();
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
        this._handedOff.clear();
    }

    // Remembers a screenshot passed to the editor, for ClaimScreenshot().
    handOff(path) {
        this._handedOff.add(path);
        if (this._handedOff.size > MAX_PENDING_CLAIMS)
            this._handedOff.delete(this._handedOff.values().next().value);
    }

    // D-Bus method: CopyImage(in ay png). A thrown GLib.Error becomes the
    // error reply, so callers see why a copy was rejected.
    CopyImage(png) {
        const bytes = pngToBytes(png);
        St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);
    }

    // D-Bus method: ClaimScreenshot(in s path) -> b. True once per screenshot
    // this extension opened in the editor; false for any other file.
    ClaimScreenshot(path) {
        return this._handedOff.delete(path);
    }
}

export default class ScreenshotEditorExtension extends Extension {
    enable() {
        this._settings = this.getSettings(SCHEMA_ID);
        this._pendingLaunches = new Set();
        this._warnedNoMode = false;

        Main.screenshotUI.connectObject(
            'screenshot-taken', (_ui, file) => this._onScreenshotTaken(file),
            this);

        const settings = this._settings;
        this._injections = new InjectionManager();
        this._injections.overrideMethod(Meta.SoundPlayer.prototype, 'play_from_theme',
            original => function (name, ...args) {
                if (name === SHUTTER_SOUND && !settings.get_boolean('play-sound'))
                    return;
                original.call(this, name, ...args);
            });

        try {
            this._service = new EditorService();
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

        this._injections.clear();
        this._injections = null;

        this._service?.destroy();
        this._service = null;
        this._settings = null;
    }

    _onScreenshotTaken(file) {
        try {
            if (!file || !this._settings.get_boolean('open-editor'))
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

        const path = file.get_path();
        if (path)
            this._service?.handOff(path);

        const appInfo = Gio.DesktopAppInfo.new(DESKTOP_ID);
        if (appInfo) {
            // The launch context carries the Wayland activation token, so the
            // editor window is focused instead of just raising a notification.
            appInfo.launch_uris([file.get_uri()], global.create_app_launch_context(0, -1));
            return;
        }

        // Desktop file not installed: run the bundled editor directly.
        if (!path)
            throw new Error(`Screenshot is not a local file: ${file.get_uri()}`);

        Gio.Subprocess.new(
            ['gjs', '-m', GLib.build_filenamev([this.path, 'editor', 'main.js']), path],
            Gio.SubprocessFlags.NONE);
    }
}
