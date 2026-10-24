// The extension's settings, read from ../schemas (the editor ships inside the
// extension). Without a compiled schema the editor runs with the defaults.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const SCHEMA_ID = 'org.gnome.shell.extensions.screenshot-editor';
const SCHEMA_DIR = GLib.build_filenamev([
    GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), '..', 'schemas',
]);
const DEFAULTS = {
    'keep-screenshots': true,
    'close-after-copy': false,
};

let _settings;

function load() {
    try {
        const source = Gio.SettingsSchemaSource.new_from_directory(
            SCHEMA_DIR, Gio.SettingsSchemaSource.get_default(), false);
        const schema = source.lookup(SCHEMA_ID, false);
        if (schema)
            return new Gio.Settings({settings_schema: schema});
    } catch (e) {
        console.warn(`Screenshot Editor settings unavailable, using defaults: ${e.message}`);
    }
    return null;
}

// Current value of a boolean setting.
export function getSetting(key) {
    if (_settings === undefined)
        _settings = load();
    return _settings ? _settings.get_boolean(key) : DEFAULTS[key];
}
