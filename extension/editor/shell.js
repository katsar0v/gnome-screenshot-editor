// D-Bus calls to GNOME Shell: the companion extension's service, and the
// Extensions service that shows the preferences window.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.DBusConnection.prototype, 'call');

const UUID = 'screenshot-editor@katsarov.info';
const BUS_NAME = 'info.katsarov.ScreenshotEditor.Shell';
const OBJECT_PATH = '/info/katsarov/ScreenshotEditor/Shell';

// Calls a method of the extension's service. Throws if the extension is not
// running (NO_AUTO_START: the name is only owned while it is enabled).
export async function callExtension(method, params, replyType = null) {
    const reply = await Gio.DBus.session.call(BUS_NAME, OBJECT_PATH, BUS_NAME, method, params,
        replyType ? new GLib.VariantType(replyType) : null,
        Gio.DBusCallFlags.NO_AUTO_START, 10000, null);
    return reply?.deepUnpack();
}

// True if the extension just opened this screenshot in the editor. Only such
// files may be deleted on close when "keep-screenshots" is off; a file opened
// any other way is never deleted.
export async function claimScreenshot(path) {
    try {
        const [handedOff] = await callExtension('ClaimScreenshot', new GLib.Variant('(s)', [path]), '(b)');
        return handedOff;
    } catch {
        return false;
    }
}

// Asks the extension for a "Screenshot saved" notification. False if it is
// not running.
export async function notifySaved(path) {
    try {
        await callExtension('NotifySaved', new GLib.Variant('(s)', [path]));
        return true;
    } catch {
        return false;
    }
}

export async function openPreferences() {
    await Gio.DBus.session.call('org.gnome.Shell.Extensions', '/org/gnome/Shell/Extensions',
        'org.gnome.Shell.Extensions', 'OpenExtensionPrefs',
        new GLib.Variant('(ssa{sv})', [UUID, '', {}]), null,
        Gio.DBusCallFlags.NONE, 10000, null);
}
