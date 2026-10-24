// One editor window per screenshot: header bar (undo/redo, Copy, Save, menu),
// tool bar, canvas, toasts, actions, shortcuts and the close confirmation.

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {Canvas} from './canvas.js';
import {copyImage} from './clipboard.js';
import {freeEditedPath, pngBytes, savePng} from './export.js';
import {Document} from './history.js';
import {getSetting} from './settings.js';
import {claimScreenshot} from './shell.js';
import {TOOL_KEYS, ToolState, Toolbar} from './toolbar.js';

const SHORTCUTS = [
    ['<Control>c', 'win.copy'],
    ['<Control>s', 'win.save'],
    ['<Control><Shift>s', 'win.save-as'],
    ['<Control>z', 'win.undo'],
    ['<Control><Shift>z', 'win.redo'],
    ['<Control>y', 'win.redo'],
    ['<Control>w', 'win.close'],
];

const BLOCKING_MODS = Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK |
    Gdk.ModifierType.SUPER_MASK;

// Modification time and size, to tell whether a file changed since it was opened.
function fileStamp(file) {
    try {
        const info = file.query_info('time::modified,standard::size', Gio.FileQueryInfoFlags.NONE, null);
        return `${info.get_modification_date_time()?.to_unix()}:${info.get_size()}`;
    } catch {
        return null;
    }
}

// Drops a deleted file from the recent files list, where GNOME added it.
function forgetRecentFile(uri) {
    const path = GLib.build_filenamev([GLib.get_user_data_dir(), 'recently-used.xbel']);
    const bookmarks = new GLib.BookmarkFile();
    try {
        bookmarks.load_from_file(path);
        if (bookmarks.has_item(uri)) {
            bookmarks.remove_item(uri);
            bookmarks.to_file(path);
        }
    } catch (e) {
        console.warn(`Could not update recent files: ${e.message}`);
    }
}

export class EditorWindow {
    constructor(app, file) {
        this.doc = new Document(file);
        this.state = new ToolState();
        this._saveTarget = null;
        this._forceClose = false;
        this._closeDialog = null;
        // Set once the extension confirms it opened this screenshot; only then
        // may the file be deleted on close (see _isTemporary).
        this._handedOff = false;
        this._savedOverOriginal = false;
        this._originalStamp = fileStamp(file);

        this.window = new Adw.ApplicationWindow({application: app, title: 'Screenshot Editor'});
        this._setDefaultSize();

        this.canvas = new Canvas(this.doc, this.state);
        this.toolbar = new Toolbar(this.state);

        this._title = new Adw.WindowTitle({title: 'Screenshot Editor', subtitle: file.get_basename()});
        const header = new Adw.HeaderBar({title_widget: this._title});
        header.pack_start(new Gtk.Button({icon_name: 'edit-undo-symbolic',
            action_name: 'win.undo', tooltip_text: 'Undo (Ctrl+Z)', focus_on_click: false}));
        header.pack_start(new Gtk.Button({icon_name: 'edit-redo-symbolic',
            action_name: 'win.redo', tooltip_text: 'Redo (Ctrl+Shift+Z)', focus_on_click: false}));

        const menu = new Gio.Menu();
        menu.append('Save As…', 'win.save-as');
        menu.append('Show in Files', 'win.show-in-files');
        menu.append('Preferences', 'app.preferences');
        header.pack_end(new Gtk.MenuButton({icon_name: 'open-menu-symbolic', menu_model: menu,
            tooltip_text: 'Menu', focus_on_click: false}));
        header.pack_end(new Gtk.Button({label: 'Copy', action_name: 'win.copy',
            css_classes: ['suggested-action'], tooltip_text: 'Copy to clipboard (Ctrl+C)', focus_on_click: false}));
        header.pack_end(new Gtk.Button({label: 'Save', action_name: 'win.save',
            tooltip_text: 'Save (Ctrl+S)', focus_on_click: false}));

        this._toasts = new Adw.ToastOverlay({child: this.canvas.widget});
        const view = new Adw.ToolbarView({content: this._toasts});
        view.add_top_bar(header);
        view.add_top_bar(this.toolbar.widget);
        this.window.set_content(view);

        this._addActions();
        this._addInputHandlers();
        this.window.connect('close-request', () => this._onCloseRequest());
        this.doc.onChange(() => this._syncActions());
        this._syncActions();

        this.canvas.area.grab_focus();

        claimScreenshot(file.get_path()).then(handedOff => {
            this._handedOff = handedOff;
            this._syncTitle();
        });
    }

    // With "keep-screenshots" off, the screenshot GNOME saved is temporary:
    // it is deleted when the editor closes, unless it was saved over.
    get _isTemporary() {
        return this._handedOff && !this._savedOverOriginal && !getSetting('keep-screenshots');
    }

    _syncTitle() {
        const name = this.doc.file.get_basename();
        this._title.subtitle = this._isTemporary ? `${name} · not kept unless saved` : name;
    }

    present() {
        this.window.present();
    }

    // Big enough for the image at its on-screen size, within the monitor.
    _setDefaultSize() {
        const monitor = Gdk.Display.get_default().get_monitors().get_item(0);
        const geom = monitor?.get_geometry();
        const scale = monitor?.get_scale_factor() ?? 1;
        const maxW = geom ? geom.width * 0.85 : 1400;
        const maxH = geom ? geom.height * 0.85 : 900;
        const w = Math.min(maxW, Math.max(900, this.doc.width / scale + 64));
        const h = Math.min(maxH, Math.max(560, this.doc.height / scale + 170));
        this.window.set_default_size(Math.round(w), Math.round(h));
    }

    _addActions() {
        this._actions = {};
        const add = (name, cb) => {
            const action = new Gio.SimpleAction({name});
            action.connect('activate', cb);
            this.window.add_action(action);
            this._actions[name] = action;
        };
        add('undo', () => {
            if (!this.canvas.isEditingText)
                this.doc.undo();
        });
        add('redo', () => {
            if (!this.canvas.isEditingText)
                this.doc.redo();
        });
        add('copy', () => this._copy().catch(logError));
        add('save', () => this._save());
        add('save-as', () => this._saveAs());
        add('show-in-files', () => this._showInFiles());
        add('close', () => this.window.close());
    }

    _syncActions() {
        this._actions.undo.enabled = this.doc.canUndo;
        this._actions.redo.enabled = this.doc.canRedo;
    }

    _addInputHandlers() {
        // Bubble phase: a focused text entry sees keys first, so typing,
        // Ctrl+C and Ctrl+Z inside it behave normally.
        const shortcuts = new Gtk.ShortcutController({propagation_phase: Gtk.PropagationPhase.BUBBLE});
        for (const [trigger, action] of SHORTCUTS) {
            shortcuts.add_shortcut(new Gtk.Shortcut({
                trigger: Gtk.ShortcutTrigger.parse_string(trigger),
                action: Gtk.NamedAction.new(action),
            }));
        }
        this.window.add_controller(shortcuts);

        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_c, keyval, _code, mods) => this._onKey(keyval, mods));
        this.window.add_controller(keys);
    }

    _onKey(keyval, mods) {
        if (this.canvas.isEditingText || mods & BLOCKING_MODS)
            return false;
        if (this.canvas.handleKey(keyval))
            return true;
        const ch = String.fromCodePoint(Gdk.keyval_to_unicode(Gdk.keyval_to_lower(keyval)) || 32);
        const tool = TOOL_KEYS[ch];
        if (!tool)
            return false;
        this.state.set({tool});
        return true;
    }

    _toast(title, showButton = false) {
        const toast = new Adw.Toast({title, timeout: 3});
        if (showButton) {
            toast.button_label = 'Show in Files';
            toast.action_name = 'win.show-in-files';
        }
        this._toasts.add_toast(toast);
    }

    async _copy() {
        this.canvas.commitText();
        try {
            const how = await copyImage(pngBytes(this.doc), this.window);
            this.doc.markClean();
            if (how !== 'gtk' && getSetting('close-after-copy')) {
                this.window.close();
                return;
            }
            this._toast(how === 'gtk'
                ? 'Copied. Keep this window open until you paste.'
                : 'Copied to clipboard');
        } catch (e) {
            this._toast(`Copy failed: ${e.message}`);
        }
    }

    _writeTo(path) {
        try {
            savePng(this.doc, path);
        } catch (e) {
            this._toast(`Could not save: ${e.message}`);
            return false;
        }
        this._saveTarget = path;
        if (path === this.doc.file.get_path())
            this._savedOverOriginal = true;
        this.doc.markClean();
        this._syncTitle();
        this._toast(`Saved as ${GLib.path_get_basename(path)}`, true);
        return true;
    }

    // The first save picks a free "-edited" name, or writes over a temporary
    // screenshot; later saves overwrite the same file.
    _savePath() {
        if (this._saveTarget)
            return this._saveTarget;
        return this._isTemporary ? this.doc.file.get_path() : freeEditedPath(this.doc.file);
    }

    _save() {
        this.canvas.commitText();
        return this._writeTo(this._savePath());
    }

    _saveAs() {
        this.canvas.commitText();
        const dialog = new Gtk.FileDialog({
            title: 'Save Screenshot As',
            initial_folder: this.doc.file.get_parent(),
            initial_name: GLib.path_get_basename(this._savePath()),
        });
        dialog.save(this.window, null, (d, res) => {
            let file;
            try {
                file = d.save_finish(res);
            } catch {
                return; // dismissed
            }
            this._writeTo(file.get_path());
        });
    }

    _showInFiles() {
        const file = this._saveTarget ? Gio.File.new_for_path(this._saveTarget) : this.doc.file;
        new Gtk.FileLauncher({file}).open_containing_folder(this.window, null, (l, res) => {
            try {
                l.open_containing_folder_finish(res);
            } catch (e) {
                this._toast(`Could not open the folder: ${e.message}`);
            }
        });
    }

    _onCloseRequest() {
        this.canvas.commitText();
        if (this._forceClose || !this.doc.dirty || !this.doc.hasEdits) {
            this._discardTemporary();
            this.canvas.dispose();
            this.doc.dispose();
            return false;
        }

        if (this._closeDialog)
            return true;
        const dialog = new Adw.AlertDialog({
            heading: 'Keep your annotations?',
            body: this._isTemporary
                ? 'This screenshot has edits that were not copied or saved. Discarding also deletes the screenshot file.'
                : 'This screenshot has edits that were not copied or saved.',
            default_response: 'save',
            close_response: 'cancel',
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('discard', 'Discard');
        dialog.add_response('save', 'Save');
        dialog.set_response_appearance('discard', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);
        dialog.connect('response', (_d, response) => {
            this._closeDialog = null;
            if (response === 'discard' || (response === 'save' && this._save())) {
                this._forceClose = true;
                this.window.close();
            }
        });
        this._closeDialog = dialog;
        dialog.present(this.window);
        return true;
    }

    // Deletes a temporary screenshot, unless it changed since it was opened.
    _discardTemporary() {
        if (!this._isTemporary)
            return;
        const file = this.doc.file;
        if (fileStamp(file) !== this._originalStamp)
            return;
        try {
            file.delete(null);
        } catch (e) {
            console.warn(`Could not delete ${file.get_path()}: ${e.message}`);
            return;
        }
        forgetRecentFile(file.get_uri());
    }
}
