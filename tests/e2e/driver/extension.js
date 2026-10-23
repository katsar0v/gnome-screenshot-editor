// Test-only driver: exposes Eval(code) on the isolated test bus so the
// e2e script can inject input and inspect shell state.
import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const XML = `<node><interface name="test.Driver">
  <method name="Eval"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
</interface></node>`;
const AsyncFunction = (async () => {}).constructor;

export default class Driver extends Extension {
    enable() {
        const seat = Clutter.get_default_backend().get_default_seat();
        const ctx = {
            Main, Clutter, GdkPixbuf, Gio, GLib, Meta, Shell, St, global,
            kbd: seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE),
            ptr: seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE),
        };
        this._obj = Gio.DBusExportedObject.wrapJSObject(XML, {
            async EvalAsync([code], invocation) {
                try {
                    const fn = new AsyncFunction(...Object.keys(ctx), code);
                    const r = await fn(...Object.values(ctx));
                    invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(r ?? null)]));
                } catch (e) {
                    invocation.return_value(new GLib.Variant('(s)', [JSON.stringify({error: `${e}\n${e.stack}`})]));
                }
            },
        });
        this._obj.export(Gio.DBus.session, '/test/Driver');
        this._id = Gio.DBus.session.own_name('test.Driver', Gio.BusNameOwnerFlags.NONE, null, null);
    }

    disable() {
        Gio.DBus.session.unown_name(this._id);
        this._obj.unexport();
    }
}
