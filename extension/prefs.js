// SPDX-License-Identifier: GPL-2.0-or-later
//
// Preferences window (Extensions app, `gnome-extensions prefs`, or the
// editor's menu). The editor reads the same settings from ./schemas.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Named explicitly rather than read from metadata.json: until the next login,
// the shell can still hand out metadata from an older version of the extension.
const SCHEMA_ID = 'org.gnome.shell.extensions.screenshot-editor';

export default class ScreenshotEditorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings(SCHEMA_ID);
        // Keep the settings object alive as long as the window.
        window._settings = settings;

        const page = new Adw.PreferencesPage();
        const addSwitch = (group, key, title, subtitle) => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
            return row;
        };

        const capture = new Adw.PreferencesGroup({
            title: 'Taking Screenshots',
            description: 'Print and the screenshot button in the top-bar menu keep working as usual.',
        });
        addSwitch(capture, 'open-editor', 'Open the Editor',
            'Annotate each screenshot right after it is taken');
        addSwitch(capture, 'play-sound', 'Shutter Sound',
            'Applies to all screenshots, including Shift+Print and Alt+Print');
        page.add(capture);

        const editor = new Adw.PreferencesGroup({title: 'Editor'});
        const keep = addSwitch(editor, 'keep-screenshots', 'Keep Screenshot Files',
            'When off, a screenshot is deleted from the Screenshots folder when you close the ' +
            'editor without saving. The copied image stays on the clipboard.');
        settings.bind('open-editor', keep, 'sensitive', Gio.SettingsBindFlags.GET);
        addSwitch(editor, 'close-after-copy', 'Close After Copying',
            'Copy (Ctrl+C) also closes the editor');
        page.add(editor);

        window.add(page);
    }
}
