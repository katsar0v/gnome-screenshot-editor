// Screenshot Editor: opens each image passed on the command line (or by the
// companion GNOME Shell extension) in its own annotation window.
// Run: gjs -m main.js <image>...

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

import {EditorWindow} from './window.js';

const APP_ID = 'info.katsarov.ScreenshotEditor';
const EDITOR_DIR = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);

const app = new Adw.Application({
    application_id: APP_ID,
    flags: Gio.ApplicationFlags.HANDLES_OPEN,
});

app.connect('startup', () => {
    const css = new Gtk.CssProvider();
    css.load_from_path(GLib.build_filenamev([EDITOR_DIR, 'style.css']));
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
});

function openFile(file) {
    try {
        new EditorWindow(app, file).present();
    } catch (e) {
        console.error(`Cannot open ${file.get_uri()}: ${e.message}`);
    }
}

app.connect('open', (_app, files) => files.forEach(openFile));

// Started without a file: ask for one.
app.connect('activate', () => {
    const active = app.get_active_window();
    if (active) {
        active.present();
        return;
    }
    const filter = new Gtk.FileFilter({name: 'Images'});
    filter.add_pixbuf_formats();
    const screenshots = GLib.build_filenamev([
        GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ?? GLib.get_home_dir(),
        'Screenshots',
    ]);
    const dialog = new Gtk.FileDialog({
        title: 'Open Screenshot',
        default_filter: filter,
        initial_folder: Gio.File.new_for_path(screenshots),
    });
    app.hold();
    dialog.open(null, null, (d, res) => {
        try {
            openFile(d.open_finish(res));
        } catch {
            // dismissed
        }
        app.release();
    });
});

await app.runAsync([System.programInvocationName, ...System.programArgs]);
