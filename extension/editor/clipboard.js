// Copies PNG bytes to the clipboard.
//
// The preferred path hands the bytes to the companion GNOME Shell extension,
// so the shell owns the clipboard and the image survives this app exiting.
// Without the extension, fall back to wl-copy (a background process keeps
// serving the data), then to the GTK clipboard (lost when this app quits).

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_async');

const BUS_NAME = 'info.katsarov.ScreenshotEditor.Shell';
const OBJECT_PATH = '/info/katsarov/ScreenshotEditor/Shell';
const INTERFACE = 'info.katsarov.ScreenshotEditor.Shell';

async function copyViaShell(bytes) {
    await Gio.DBus.session.call(BUS_NAME, OBJECT_PATH, INTERFACE, 'CopyImage',
        new GLib.Variant('(ay)', [bytes]), null,
        Gio.DBusCallFlags.NO_AUTO_START, 10000, null);
}

async function copyViaWlCopy(bytes) {
    const proc = Gio.Subprocess.new(['wl-copy', '--type', 'image/png'],
        Gio.SubprocessFlags.STDIN_PIPE);
    await proc.communicate_async(new GLib.Bytes(bytes), null);
    if (!proc.get_successful())
        throw new Error(`wl-copy exited with status ${proc.get_exit_status()}`);
}

// Returns which method worked: 'shell', 'wl-copy' or 'gtk'.
export async function copyImage(bytes, widget) {
    try {
        await copyViaShell(bytes);
        return 'shell';
    } catch (e) {
        console.warn(`Shell clipboard unavailable: ${e.message}`);
    }
    try {
        await copyViaWlCopy(bytes);
        return 'wl-copy';
    } catch (e) {
        console.warn(`wl-copy failed: ${e.message}`);
    }
    widget.get_clipboard().set_content(
        Gdk.ContentProvider.new_for_bytes('image/png', new GLib.Bytes(bytes)));
    return 'gtk';
}
