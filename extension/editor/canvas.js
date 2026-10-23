// The drawing surface: fits the document into the widget, maps pointer
// events to image coordinates for the active tool, and hosts the inline text
// entry and the crop action bar as overlays.

import Cairo from 'cairo';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import {AddShape, ModifyShape, RemoveShape} from './history.js';
import {TextShape, drawShape, fontPx, hexToRgb, measureText, renderShapes} from './shapes.js';
import {createTools} from './tools.js';

const PADDING = 24;
const HIT_TOLERANCE = 7; // logical pixels

export class Canvas {
    constructor(doc, state) {
        this.doc = doc;
        this.state = state;
        this.preview = null;
        this.selection = null;
        this._edit = null;
        this._fit = 1;
        this._ox = 0;
        this._oy = 0;
        this._baseCache = null;
        this._cursor = null;

        this.area = new Gtk.DrawingArea({
            hexpand: true,
            vexpand: true,
            focusable: true,
            css_classes: ['editor-canvas'],
        });
        this.area.set_draw_func((_a, cr, w, h) => this._draw(cr, w, h));
        this.area.connect('resize', () => this._placeEntry());

        this.widget = new Gtk.Overlay({child: this.area});
        this._buildCropBar();

        const drag = new Gtk.GestureDrag();
        drag.connect('drag-begin', (g, x, y) => this._dragBegin(g, x, y));
        drag.connect('drag-update', (g, dx, dy) => this._dragUpdate(g, dx, dy));
        drag.connect('drag-end', (g, dx, dy) => this._dragEnd(g, dx, dy));
        this.area.add_controller(drag);

        const click = new Gtk.GestureClick();
        click.connect('pressed', (_g, n, x, y) => {
            if (n === 2 && this.state.tool === 'select')
                this._editTextAt(x, y);
        });
        this.area.add_controller(click);

        const motion = new Gtk.EventControllerMotion();
        motion.connect('motion', (_c, x, y) => {
            this._setCursor(this._tool.hoverCursor(...this.toImage(x, y)));
        });
        this.area.add_controller(motion);

        this.tools = createTools(this);
        this._toolName = null;
        this._switchTool(state.tool);

        state.connect(changes => this._onStateChanged(changes));
        doc.onChange(() => {
            if (this.selection && !doc.shapes.includes(this.selection))
                this.selection = null;
            this.queueDraw();
        });
    }

    // --- coordinates -------------------------------------------------------

    get tolerance() {
        return HIT_TOLERANCE / this._fit;
    }

    _viewRect() {
        // While cropping, show the whole image so the crop can be adjusted.
        if (this._toolName === 'crop')
            return {x: 0, y: 0, w: this.doc.width, h: this.doc.height};
        return this.doc.view;
    }

    _updateTransform(w = this.area.get_width(), h = this.area.get_height()) {
        const v = this._viewRect();
        const fit = Math.min((w - 2 * PADDING) / v.w, (h - 2 * PADDING) / v.h, 1);
        this._fit = Math.max(fit, 0.01);
        // Keep the visible image's top-left on whole pixels so it stays crisp.
        this._ox = Math.round((w - v.w * this._fit) / 2) - v.x * this._fit;
        this._oy = Math.round((h - v.h * this._fit) / 2) - v.y * this._fit;
    }

    toImage(wx, wy) {
        this._updateTransform();
        return [(wx - this._ox) / this._fit, (wy - this._oy) / this._fit];
    }

    toWidget(x, y) {
        return [this._ox + x * this._fit, this._oy + y * this._fit];
    }

    // --- drawing -----------------------------------------------------------

    queueDraw() {
        this.area.queue_draw();
    }

    // The base image scaled to the current fit, rendered once per size so
    // pointer moves only redraw annotations.
    _scaledBase(v, scale) {
        const key = `${this._fit},${scale},${v.x},${v.y},${v.w},${v.h}`;
        if (this._baseCache?.key === key)
            return this._baseCache.surface;
        this._baseCache?.surface.finish();
        const k = this._fit * scale;
        const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32,
            Math.max(1, Math.ceil(v.w * k)), Math.max(1, Math.ceil(v.h * k)));
        const cr = new Cairo.Context(surface);
        cr.scale(k, k);
        cr.translate(-v.x, -v.y);
        cr.setSourceSurface(this.doc.surface, 0, 0);
        cr.paint();
        cr.$dispose();
        this._baseCache = {key, surface};
        return surface;
    }

    _draw(cr, w, h) {
        this._updateTransform(w, h);
        const v = this._viewRect();
        const fit = this._fit;
        const [vx, vy] = this.toWidget(v.x, v.y);
        const vw = v.w * fit, vh = v.h * fit;

        // Soft shadow behind the image.
        cr.setSourceRGBA(0, 0, 0, 0.18);
        cr.rectangle(vx + 1, vy + 2, vw, vh);
        cr.fill();

        const scale = this.area.get_scale_factor();
        cr.save();
        cr.translate(vx, vy);
        cr.scale(1 / scale, 1 / scale);
        cr.setSourceSurface(this._scaledBase(v, scale), 0, 0);
        cr.paint();
        cr.restore();

        cr.save();
        cr.rectangle(vx, vy, vw, vh);
        cr.clip();
        cr.translate(this._ox, this._oy);
        cr.scale(fit, fit);
        renderShapes(cr, this.doc);
        if (this.preview)
            drawShape(cr, this.preview, this.doc);
        cr.newPath();
        this._tool.drawOverlay(cr, fit);
        cr.restore();

        if (this.selection && !this.selection.hidden) {
            const b = this.selection.bounds(this.doc);
            const [x, y] = this.toWidget(b.x, b.y);
            cr.setLineWidth(1.5);
            cr.setDash([5, 4], 0);
            cr.setSourceRGBA(0.21, 0.52, 0.89, 1);
            cr.rectangle(Math.round(x) - 4.5, Math.round(y) - 4.5,
                Math.round(b.w * fit) + 9, Math.round(b.h * fit) + 9);
            cr.stroke();
        }

        cr.$dispose();
    }

    // --- input -------------------------------------------------------------

    _setCursor(name) {
        if (name !== this._cursor) {
            this._cursor = name;
            this.area.set_cursor_from_name(name);
        }
    }

    _dragBegin(gesture, x, y) {
        this.area.grab_focus();
        this._dragStart = [x, y];
        // A click while editing text only commits the text.
        this._swallow = this._edit !== null;
        if (this._swallow) {
            this.commitText();
            return;
        }
        this._tool.begin(...this.toImage(x, y), gesture.get_current_event_state());
        this.queueDraw();
    }

    _dragUpdate(gesture, dx, dy) {
        if (this._swallow)
            return;
        const [sx, sy] = this._dragStart;
        this._tool.update(...this.toImage(sx + dx, sy + dy), gesture.get_current_event_state());
        this.queueDraw();
    }

    _dragEnd(gesture, dx, dy) {
        if (this._swallow)
            return;
        const [sx, sy] = this._dragStart;
        this._tool.end(...this.toImage(sx + dx, sy + dy), gesture.get_current_event_state());
        this.queueDraw();
    }

    // Keys that reach the window while the canvas (not the text entry) has focus.
    handleKey(keyval) {
        const handled = this._tool.key(keyval);
        if (handled)
            this.queueDraw();
        return handled;
    }

    setSelection(shape) {
        this.selection = shape;
        this.queueDraw();
    }

    // --- tools and style ---------------------------------------------------

    _switchTool(name) {
        if (this._edit)
            this.commitText();
        if (name === this._toolName)
            return;
        this._tool?.deactivate();
        if (name === 'crop')
            this._toolBeforeCrop = this._toolName;
        this._toolName = name;
        this._tool = this.tools[name];
        this._tool.activate();
        this.preview = null;
        this._cropBar.visible = name === 'crop';
        this._setCursor(this._tool.cursor);
        this.queueDraw();
    }

    leaveCrop() {
        const back = this._toolBeforeCrop && this._toolBeforeCrop !== 'crop'
            ? this._toolBeforeCrop : 'arrow';
        this.state.set({tool: back});
    }

    _onStateChanged(changes) {
        if ('tool' in changes)
            this._switchTool(changes.tool);

        const style = {};
        for (const k of ['color', 'level', 'redactMode']) {
            if (k in changes)
                style[k] = changes[k];
        }
        if (!Object.keys(style).length)
            return;

        if (this._edit) {
            if (style.color)
                this._edit.color = style.color;
            if ('level' in style)
                this._edit.level = style.level;
            this._styleEntry();
        } else if (this.selection) {
            this._restyle(this.selection, style);
        }
        this.queueDraw();
    }

    // Applies a toolbar color/size change to the selected shape (undoable).
    _restyle(shape, style) {
        const before = shape.snapshot();
        if (style.color && 'color' in shape)
            shape.color = style.color;
        if ('level' in style)
            shape.level = style.level;
        if (style.redactMode && shape.isRedaction)
            shape.mode = style.redactMode;
        shape.invalidate();
        const after = shape.snapshot();
        if (JSON.stringify(before) !== JSON.stringify(after))
            this.doc.record(new ModifyShape(shape, before, after));
    }

    // --- crop bar ----------------------------------------------------------

    _buildCropBar() {
        const bar = new Gtk.Box({
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.START,
            margin_top: 12,
            spacing: 6,
            css_classes: ['toolbar', 'osd', 'crop-bar'],
            visible: false,
        });
        bar.append(new Gtk.Label({label: 'Drag to select · Enter to apply', margin_start: 6, margin_end: 6}));
        const button = (label, cb, cls = []) => {
            const b = new Gtk.Button({label, css_classes: cls, focus_on_click: false});
            b.connect('clicked', () => {
                cb();
                this.area.grab_focus();
            });
            bar.append(b);
        };
        button('Reset', () => this.tools.crop.reset());
        button('Cancel', () => this.leaveCrop());
        button('Apply', () => this.tools.crop.apply(), ['suggested-action']);
        this._cropBar = bar;
        this.widget.add_overlay(bar);
    }

    // --- text editing ------------------------------------------------------

    get isEditingText() {
        return this._edit !== null;
    }

    _editTextAt(wx, wy) {
        const hit = this.doc.hitTest(...this.toImage(wx, wy), this.tolerance);
        if (hit?.type === 'text')
            this.startTextEdit(hit.x, hit.y, hit);
    }

    // Opens an inline entry at image point (x, y), editing `shape` if given.
    startTextEdit(x, y, shape) {
        if (!shape) {
            const hit = this.doc.hitTest(x, y, this.tolerance);
            if (hit?.type === 'text')
                [x, y, shape] = [hit.x, hit.y, hit];
        }
        this.commitText();
        this.setSelection(null);

        const entry = new Gtk.Entry({
            halign: Gtk.Align.START,
            valign: Gtk.Align.START,
            width_chars: 1,
            max_width_chars: 1,
            css_classes: ['annot-entry'],
            text: shape?.text ?? '',
        });
        this._edit = {
            entry, shape, x, y,
            color: shape?.color ?? this.state.color,
            level: shape?.level ?? this.state.level,
        };
        if (shape)
            shape.hidden = true;

        entry.connect('activate', () => this.commitText());
        entry.connect('changed', () => this._placeEntry());
        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_c, keyval) => {
            if (keyval !== Gdk.KEY_Escape)
                return false;
            this.cancelText();
            return true;
        });
        entry.add_controller(keys);

        this.widget.add_overlay(entry);
        this._styleEntry();
        entry.grab_focus();
        this.queueDraw();
    }

    _styleEntry() {
        const e = this._edit;
        if (!e)
            return;
        const attrs = new Pango.AttrList();
        attrs.insert(Pango.attr_family_new('Sans'));
        attrs.insert(Pango.attr_weight_new(Pango.Weight.BOLD));
        attrs.insert(Pango.attr_size_new_absolute(
            Math.max(1, Math.round(fontPx(this.doc, e.level) * this._fit * Pango.SCALE))));
        const [r, g, b] = hexToRgb(e.color).map(c => Math.round(c * 65535));
        attrs.insert(Pango.attr_foreground_new(r, g, b));
        e.entry.set_attributes(attrs);
        this._placeEntry();
    }

    _placeEntry() {
        const e = this._edit;
        if (!e)
            return;
        this._updateTransform();
        const px = fontPx(this.doc, e.level) * this._fit;
        const [w, h] = measureText(`${e.entry.get_text()}MM`, px);
        const [wx, wy] = this.toWidget(e.x, e.y);
        e.entry.set_size_request(Math.ceil(w), Math.ceil(h));
        e.entry.margin_start = Math.max(0, Math.round(wx));
        e.entry.margin_top = Math.max(0, Math.round(wy));
    }

    _closeEntry() {
        const e = this._edit;
        this._edit = null;
        if (e.shape)
            e.shape.hidden = false;
        this.widget.remove_overlay(e.entry);
        this.area.grab_focus();
        this.queueDraw();
        return e;
    }

    commitText() {
        if (!this._edit)
            return;
        const e = this._closeEntry();
        const text = e.entry.get_text().trim();
        if (e.shape) {
            if (!text) {
                this.doc.execute(new RemoveShape(e.shape));
            } else {
                const before = e.shape.snapshot();
                Object.assign(e.shape, {text, color: e.color, level: e.level});
                const after = e.shape.snapshot();
                if (JSON.stringify(before) !== JSON.stringify(after))
                    this.doc.record(new ModifyShape(e.shape, before, after));
            }
        } else if (text) {
            this.doc.execute(new AddShape(new TextShape({x: e.x, y: e.y, text, color: e.color, level: e.level})));
        }
    }

    cancelText() {
        if (this._edit)
            this._closeEntry();
    }

    dispose() {
        this._baseCache?.surface.finish();
        this._baseCache = null;
    }
}
