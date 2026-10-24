import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import {ev, sleep, run, SETUP} from './lib.js';

// Set by run.sh: the throwaway directory holding this run's data, pictures and shots.
const E2E = GLib.getenv('E2E_DIR');
const ROOT = GLib.path_get_dirname(GLib.path_get_dirname(
    GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0])));
const SHOTS = `${E2E}/shots`;
const PICS = `${E2E}/pictures/Screenshots`;
const APP = 'info.katsarov.ScreenshotEditor';
let failures = 0;

function check(name, cond, info) {
    print(`${cond ? 'PASS' : 'FAIL'}  ${name}${info !== undefined ? `  ${JSON.stringify(info)}` : ''}`);
    if (!cond)
        failures++;
}
const pics = () => {
    const out = [];
    const en = Gio.File.new_for_path(PICS).enumerate_children('standard::name', 0, null);
    let i;
    while ((i = en.next_file(null)))
        out.push(i.get_name());
    return out.sort();
};
const dims = path => {
    const pb = GdkPixbuf.Pixbuf.new_from_file(path);
    return [pb.get_width(), pb.get_height()];
};
const key = name => ev(`await T.key(Clutter.KEY_${name}); return 1;`);
const combo = (mods, name) => ev(`await T.combo([${mods.map(m => `Clutter.KEY_${m}`)}], Clutter.KEY_${name}); return 1;`);
const editors = async () => (await ev('return T.windows();')).filter(w => w.wmclass === APP);
const shot = name => ev(`return T.shot('${SHOTS}/${name}.png');`);
async function waitFor(fn, ms = 10000) {
    for (let t = 0; t < ms; t += 200) {
        if (await fn())
            return true;
        await sleep(200);
    }
    return false;
}
const nameOwned = () => ev(`return Gio.DBus.session.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
    'org.freedesktop.DBus', 'NameHasOwner', new GLib.Variant('(s)', ['${APP}.Shell']), null, 0, -1, null).deepUnpack()[0];`);
const sh = argv => {
    const p = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
    p.wait(null);
    return p.get_exit_status();
};

// Print → screenshot UI → full-screen capture via Return.
async function printCapture(mode = null) {
    if (mode === null)
        await key('Print');
    else
        await ev(`Main.screenshotUI.open(${mode}); return 1;`);
    const opened = await waitFor(() => ev('return Main.screenshotUI.visible;'), 4000);
    await sleep(600);
    await ev('Main.screenshotUI._screenButton.checked = true; return 1;');
    await key('Return');
    return opened;
}

const overviewHidden = async () => !(await ev('return Main.overview.visible;'));

run(async () => {
    await ev(SETUP);
    // A fresh shell starts in the overview; begin from the plain desktop.
    await ev('Main.overview.hide(); return 1;');
    await waitFor(overviewHidden, 5000);
    check('shell D-Bus name owned by extension', await nameOwned());

    // --- 1. Print opens the editor --------------------------------------------
    let before = pics();
    check('Print opens the screenshot UI', await printCapture());
    check('editor window appears after capture', await waitFor(async () => (await editors()).length === 1));
    let added = pics().filter(n => !before.includes(n));
    check('GNOME saved the screenshot', added.length === 1, added);
    const shotName = added[0];
    await sleep(1200);
    let [win] = await editors();
    check('editor window is focused', win?.focus, win);
    await shot('01-editor-open');

    // --- 2. Annotate ----------------------------------------------------------
    const cx = win.x + win.w / 2, cy = win.y + win.h / 2 + 40;
    const drag = (x1, y1, x2, y2) => ev(`await T.drag(${x1}, ${y1}, ${x2}, ${y2}); return 1;`);
    const click = (x, y, n = 1) => ev(`await T.click(${x}, ${y}, ${n}); return 1;`);
    await key('a'); await drag(cx - 260, cy + 140, cx - 70, cy - 30);
    await key('r'); await drag(cx + 30, cy - 150, cx + 270, cy - 10);
    await key('e'); await drag(cx + 300, cy - 150, cx + 470, cy - 30);
    await key('b'); await drag(cx - 520, cy - 230, cx - 300, cy - 150);
    await key('h'); await drag(cx - 520, cy + 220, cx - 120, cy + 220);
    await key('p'); await drag(cx + 300, cy + 200, cx + 450, cy + 150);
    await key('l'); await drag(cx + 30, cy + 250, cx + 270, cy + 250);
    await key('n'); await click(cx + 330, cy + 60); await click(cx + 400, cy + 60); await click(cx + 470, cy + 60);
    await key('t'); await click(cx + 40, cy + 40);
    await ev(`await T.type('Hello'); return 1;`);
    await shot('02a-typing'); await key('Return');
    // Letters typed into a text entry must not switch tools; BackSpace edits the text.
    await click(cx - 520, cy + 60);
    await ev(`await T.type('rab'); return 1;`); await key('BackSpace'); await key('Return');
    await sleep(400);
    await shot('02-annotated');

    // Undo removes the last text ("ra"), redo brings it back.
    await combo(['Control_L'], 'z'); await sleep(300); await shot('03-after-undo');
    await combo(['Control_L', 'Shift_L'], 'z'); await sleep(300);

    // Select + move the rectangle, delete a step marker.
    await key('v'); await drag(cx + 30, cy - 80, cx + 60, cy - 40);
    await click(cx + 400, cy + 60); await key('Delete');
    await sleep(300);
    await shot('04-moved-deleted');

    // --- 3. Copy ------------------------------------------------------------------
    // GNOME already put the raw screenshot on the clipboard; clear it so the
    // check proves the editor's Copy worked.
    await ev(`St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, 'x'); return 1;`);
    check('clipboard cleared before Copy', (await ev('return await T.clipboardPng();')) === null);
    await combo(['Control_L'], 'c');
    await sleep(1500);
    const shotDims = dims(`${PICS}/${shotName}`);
    let clip = await ev('return await T.clipboardPng();');
    check('Copy puts the edited PNG on the clipboard at full size', clip && clip.w === shotDims[0] && clip.h === shotDims[1], {clip, shotDims});
    await shot('05-after-copy');

    // --- 4. Crop, copy, save --------------------------------------------------
    await key('c'); await sleep(300);
    await drag(cx - 300, cy - 200, cx + 300, cy + 150);
    await shot('06-crop-pending');
    await key('Return'); await sleep(400);
    await shot('07-cropped');
    await ev(`St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, 'x'); return 1;`);
    await combo(['Control_L'], 'c'); await sleep(1500);
    clip = await ev('return await T.clipboardPng();');
    check('cropped copy is smaller than the screenshot', clip && clip.w < shotDims[0] && clip.h < shotDims[1], clip);

    before = pics();
    await combo(['Control_L'], 's'); await sleep(1000);
    added = pics().filter(n => !before.includes(n));
    const edited = shotName.replace(/\.png$/, '-edited.png');
    check('Ctrl+S writes <name>-edited.png', added.length === 1 && added[0] === edited, added);
    const editedDims = added.length ? dims(`${PICS}/${added[0]}`) : null;
    check('saved file has the cropped size', editedDims && editedDims[0] === clip.w && editedDims[1] === clip.h, {editedDims, clip});
    before = pics();
    await combo(['Control_L'], 's'); await sleep(800);
    check('second save overwrites the same file', pics().length === before.length);

    // --- 5. Close (clean) and clipboard persistence ----------------------------
    await combo(['Control_L'], 'w');
    check('Ctrl+W closes a saved editor without asking', await waitFor(async () => (await editors()).length === 0, 4000));
    await sleep(500);
    const clipAfter = await ev('return await T.clipboardPng();');
    check('copied image survives closing the editor', clipAfter && clipAfter.w === clip.w && clipAfter.h === clip.h, clipAfter);

    // --- 6. Close confirmation ---------------------------------------------------
    await printCapture();
    check('second Print opens a new editor', await waitFor(async () => (await editors()).length === 1));
    await sleep(1200);
    [win] = await editors();
    check('second editor focused', win?.focus);
    await key('a'); await drag(win.x + 300, win.y + 400, win.x + 600, win.y + 300);
    await combo(['Control_L'], 'w'); await sleep(800);
    check('unsaved edits keep the window open', (await editors()).length === 1);
    await shot('08-close-confirm');
    await key('Escape'); await sleep(500);
    check('Cancel keeps the window', (await editors()).length === 1);
    await combo(['Control_L'], 'w'); await sleep(600);
    await combo(['Control_L'], 'w'); await sleep(600); // must not stack a second dialog
    await shot('09-close-confirm-again');
    // Return picks the default response (Save), which saves and closes.
    await key('Return'); await sleep(1000);
    const closed = await waitFor(async () => (await editors()).length === 0, 4000);
    check('dialog response closes the window', closed);
    if (!closed)
        await shot('10-dialog-stuck');

    // --- 7. Paths that must NOT open the editor ---------------------------------
    for (const [label, action] of [
        ['portal mode (SCREENSHOT_ONLY)', () => printCapture(2)],
        ['Shift+Print', () => combo(['Shift_L'], 'Print')],
        ['Alt+Print (window)', () => combo(['Alt_L'], 'Print')],
    ]) {
        before = pics();
        await action();
        await sleep(2500);
        const n = pics().filter(x => !before.includes(x)).length;
        check(`${label}: no editor`, (await editors()).length === 0, {newFiles: n});
    }

    // Real portal call: xdg-desktop-portal → InteractiveScreenshot (mode 2).
    const portal = Gio.Subprocess.new(['gdbus', 'call', '--session', '--dest', 'org.freedesktop.portal.Desktop',
        '--object-path', '/org/freedesktop/portal/desktop', '--method', 'org.freedesktop.portal.Screenshot.Screenshot',
        '', "{'interactive': <true>}"], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    const portalOpened = await waitFor(() => ev('return Main.screenshotUI.visible;'), 8000);
    if (portalOpened) {
        const mode = await ev('return Main.screenshotUI._currentMode;');
        await sleep(600);
        await ev('Main.screenshotUI._screenButton.checked = true; return 1;');
        await key('Return');
        await sleep(2500);
        check('real portal screenshot: UI opened in mode 2 and no editor', mode === 2 && (await editors()).length === 0, {mode});
    } else {
        print('SKIP  real portal screenshot (portal did not open the UI in the test session)');
    }
    portal.force_exit();

    // --- 8. Disable / re-enable --------------------------------------------------
    sh(['gnome-extensions', 'disable', 'screenshot-editor@katsarov.info']);
    await sleep(800);
    check('disable releases the D-Bus name', !(await nameOwned()));
    await printCapture(); await sleep(2500);
    check('disabled: Print does not open the editor', (await editors()).length === 0);
    sh(['gnome-extensions', 'enable', 'screenshot-editor@katsarov.info']);
    await sleep(800);
    check('re-enable owns the name again', await nameOwned());
    await printCapture();
    check('re-enabled: Print opens the editor', await waitFor(async () => (await editors()).length === 1));
    await sleep(1000);
    await combo(['Control_L'], 'w');
    await waitFor(async () => (await editors()).length === 0, 3000);

    // Print from the overview: the extension closes the overview so the
    // editor opens on top and focused.
    await ev('Main.overview.show(); return 1;');
    await waitFor(() => ev('return Main.overview.visible;'), 5000);
    await sleep(800);
    await printCapture();
    check('from the overview: editor opens', await waitFor(async () => (await editors()).length === 1));
    await sleep(1200);
    [win] = await editors();
    check('from the overview: overview closed and editor focused', (await overviewHidden()) && win?.focus, win);
    await combo(['Control_L'], 'w');
    await waitFor(async () => (await editors()).length === 0, 3000);

    // --- 9. Settings ------------------------------------------------------------
    const setKey = async (k, v) => {
        sh(['gsettings', '--schemadir', `${ROOT}/extension/schemas`, 'set',
            'org.gnome.shell.extensions.screenshot-editor', k, String(v)]);
        await sleep(800); // keyfile backend change notification
    };
    const sounds = () => ev(`return globalThis.soundLog.filter(n => n === 'screen-capture').length;`);
    const resetSounds = () => ev('globalThis.soundLog.length = 0; return 1;');
    const openEditor = async () => {
        await printCapture();
        const ok = await waitFor(async () => (await editors()).length === 1);
        await sleep(1200);
        return ok;
    };
    const focusEditor = () => ev(`global.get_window_actors().map(a => a.meta_window)
        .filter(w => w.get_wm_class() === '${APP}').forEach(w => w.activate(global.get_current_time())); return 1;`);
    const closeEditor = async () => {
        await focusEditor();
        await sleep(300);
        await combo(['Control_L'], 'w');
        return waitFor(async () => (await editors()).length === 0, 4000);
    };
    const uriOf = name => Gio.File.new_for_path(`${PICS}/${name}`).get_uri();
    const recentFiles = () => {
        try {
            return new TextDecoder().decode(GLib.file_get_contents(`${E2E}/data/recently-used.xbel`)[1]);
        } catch {
            return '';
        }
    };
    const sizeOf = path => Gio.File.new_for_path(path).query_info('standard::size', 0, null).get_size();

    check('shutter sound plays by default', (await sounds()) > 0);
    await setKey('play-sound', false);
    await resetSounds();
    check('sound off: editor still opens', await openEditor());
    await closeEditor();
    await combo(['Shift_L'], 'Print'); await sleep(1500);
    check('sound off: no shutter sound for Print or Shift+Print', (await sounds()) === 0);
    await setKey('play-sound', true);
    await combo(['Shift_L'], 'Print'); await sleep(1500);
    check('sound back on after re-enabling', (await sounds()) === 1);

    await setKey('keep-screenshots', false);
    before = pics();
    check('keep off: editor opens', await openEditor());
    let fresh = pics().filter(n => !before.includes(n));
    check('keep off: the file exists while editing', fresh.length === 1, fresh);
    check('keep off: GNOME listed it in recent files', recentFiles().includes(uriOf(fresh[0])));
    await shot('11-keep-off');
    check('keep off: closing without saving deletes it', (await closeEditor()) && !pics().includes(fresh[0]));
    check('keep off: removed from recent files', !recentFiles().includes(uriOf(fresh[0])));

    before = pics();
    await openEditor();
    fresh = pics().filter(n => !before.includes(n));
    const rawSize = sizeOf(`${PICS}/${fresh[0]}`);
    [win] = await editors();
    await key('a'); await ev(`await T.drag(${win.x + 300}, ${win.y + 400}, ${win.x + 700}, ${win.y + 300}); return 1;`);
    await combo(['Control_L'], 's'); await sleep(800);
    await closeEditor();
    const kept = pics().filter(n => !before.includes(n));
    check('keep off + Save: written over GNOME\'s file, kept, no -edited copy',
        kept.length === 1 && kept[0] === fresh[0] && sizeOf(`${PICS}/${kept[0]}`) !== rawSize, {kept, rawSize});

    // A file opened by hand is never deleted, whatever the setting.
    const manual = `${PICS}/opened-by-hand.png`;
    Gio.File.new_for_path(`${PICS}/${kept[0]}`).copy(Gio.File.new_for_path(manual), Gio.FileCopyFlags.OVERWRITE, null, null);
    Gio.Subprocess.new(['gjs', '-m', `${ROOT}/extension/editor/main.js`, manual],
        Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
    check('opened by hand: editor opens', await waitFor(async () => (await editors()).length === 1));
    await sleep(1500);
    check('opened by hand: closing keeps the file', (await closeEditor()) && GLib.file_test(manual, GLib.FileTest.EXISTS));
    await setKey('keep-screenshots', true);

    await setKey('open-editor', false);
    before = pics();
    await printCapture(); await sleep(2500);
    check('open-editor off: no editor, GNOME still saves', (await editors()).length === 0 && pics().length === before.length + 1);
    await setKey('open-editor', true);

    await setKey('close-after-copy', true);
    await openEditor();
    await combo(['Control_L'], 'c');
    check('close-after-copy: Copy closes the editor', await waitFor(async () => (await editors()).length === 0, 4000));
    await setKey('close-after-copy', false);

    await openEditor();
    // Right after an update the shell still has the old metadata.json (no
    // settings-schema) until the next login; preferences must open anyway.
    await ev(`delete Main.extensionManager.lookup('screenshot-editor@katsarov.info').metadata['settings-schema']; return 1;`);
    Gio.DBus.session.call_sync(APP, `/${APP.replaceAll('.', '/')}`, 'org.gtk.Actions', 'Activate',
        new GLib.Variant('(sava{sv})', ['preferences', [], {}]), null, Gio.DBusCallFlags.NONE, -1, null);
    const prefsWindow = async () => (await ev('return T.windows();'))
        .find(w => w.wmclass !== APP && w.title === 'Screenshot Editor');
    check('editor menu opens the preferences window', await waitFor(async () => !!(await prefsWindow()), 10000),
        await ev('return T.windows();'));
    await sleep(1500);
    await shot('12-preferences');
    await ev(`global.get_window_actors().map(a => a.meta_window)
        .filter(w => w.get_wm_class() !== '${APP}' && w.get_title() === 'Screenshot Editor')
        .forEach(w => w.delete(global.get_current_time())); return 1;`);
    await sleep(800);
    await closeEditor();

    const log = await ev(`return Main.extensionManager.lookup('screenshot-editor@katsarov.info')?.error ?? '';`);
    check('extension reports no error', !log, log);
    print(`\n${failures} failure(s)`);
    if (failures)
        throw new Error(`${failures} check(s) failed`);
});
