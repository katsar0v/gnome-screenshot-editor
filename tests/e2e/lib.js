import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

Gio._promisify(Gio.DBusConnection.prototype, 'call');

export async function ev(code) {
    const r = await Gio.DBus.session.call('test.Driver', '/test/Driver', 'test.Driver', 'Eval',
        new GLib.Variant('(s)', [code]), new GLib.VariantType('(s)'), Gio.DBusCallFlags.NONE, 60000, null);
    const out = JSON.parse(r.deepUnpack()[0]);
    if (out?.error)
        throw new Error(out.error);
    return out;
}

export const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    r();
    return GLib.SOURCE_REMOVE;
}));

// Installs input/inspection helpers inside the shell as globalThis.T.
export const SETUP = `
const now = () => GLib.get_monotonic_time();
const pause = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
globalThis.T = {
  async key(keyval) { kbd.notify_keyval(now(), keyval, Clutter.KeyState.PRESSED); await pause(30); kbd.notify_keyval(now(), keyval, Clutter.KeyState.RELEASED); await pause(60); },
  async combo(mods, keyval) { for (const m of mods) kbd.notify_keyval(now(), m, Clutter.KeyState.PRESSED); await pause(30); await this.key(keyval); for (const m of mods.reverse()) kbd.notify_keyval(now(), m, Clutter.KeyState.RELEASED); await pause(80); },
  async type(text) { for (const ch of text) await this.key(Clutter.unicode_to_keysym(ch.codePointAt(0))); },
  async move(x, y) { ptr.notify_absolute_motion(now(), x, y); await pause(20); },
  async drag(x1, y1, x2, y2, steps = 12) { await this.move(x1, y1); ptr.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED); await pause(40);
    for (let i = 1; i <= steps; i++) await this.move(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps);
    ptr.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED); await pause(120); },
  async click(x, y, n = 1) { await this.move(x, y); for (let i = 0; i < n; i++) { ptr.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED); await pause(30); ptr.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED); await pause(n > 1 ? 60 : 150); } await pause(150); },
  windows() { return global.get_window_actors().map(a => { const w = a.meta_window; const r = w.get_frame_rect(); return {wmclass: w.get_wm_class(), title: w.get_title(), focus: w.has_focus(), x: r.x, y: r.y, w: r.width, h: r.height}; }); },
  async shot(path) { const s = new Shell.Screenshot(); const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Promise((res, rej) => s.screenshot(false, stream, (o, r) => { try { o.screenshot_finish(r); res(); } catch (e) { rej(e); } })); stream.close(null); return path; },
  clipboardPng() { return new Promise(res => St.Clipboard.get_default().get_content(St.ClipboardType.CLIPBOARD, 'image/png', (c, bytes) => {
    if (!bytes || bytes.get_size() === 0) { res(null); return; }
    const pb = GdkPixbuf.Pixbuf.new_from_stream(Gio.MemoryInputStream.new_from_bytes(bytes), null);
    res({size: bytes.get_size(), w: pb.get_width(), h: pb.get_height()}); })); },
};
return 'ok';
`;

export function run(main) {
    const loop = new GLib.MainLoop(null, false);
    let status = 0;
    main().catch(e => {
        printerr(`FAILED: ${e.message}\n${e.stack}`);
        status = 1;
    }).finally(() => loop.quit());
    loop.run();
    System.exit(status);
}
