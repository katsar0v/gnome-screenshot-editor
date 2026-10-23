// The tool bar under the header (tools, colors, size, blur mode) and the
// shared ToolState it edits. Icons are drawn with Cairo in the theme's
// foreground color, so no icon files are needed.

import Cairo from 'cairo';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {hexToRgb} from './shapes.js';

export const TOOLS = [
    ['select', 'Select and move', 'V'],
    ['crop', 'Crop', 'C'],
    ['arrow', 'Arrow', 'A'],
    ['line', 'Line', 'L'],
    ['rect', 'Rectangle', 'R'],
    ['ellipse', 'Ellipse', 'E'],
    ['pen', 'Pen', 'P'],
    ['highlight', 'Highlighter', 'H'],
    ['text', 'Text', 'T'],
    ['step', 'Step number', 'N'],
    ['redact', 'Blur / pixelate', 'B'],
];

export const TOOL_KEYS = Object.fromEntries(TOOLS.map(([name, , key]) => [key.toLowerCase(), name]));

const COLORS = [
    ['#e01b24', 'Red'],
    ['#f6d32d', 'Yellow'],
    ['#33d17a', 'Green'],
    ['#3584e4', 'Blue'],
    ['#000000', 'Black'],
    ['#ffffff', 'White'],
];

const STATE_FILE = GLib.build_filenamev([GLib.get_user_config_dir(), 'screenshot-editor', 'state.json']);

// Current tool and style. set() notifies listeners with the keys it was given,
// even if a value is unchanged, so re-picking a color still restyles the selection.
export class ToolState {
    constructor() {
        let saved = {};
        try {
            saved = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(STATE_FILE)[1]));
        } catch {
            // First run or unreadable file: use defaults.
        }
        const names = TOOLS.map(([n]) => n);
        this.tool = names.includes(saved.tool) && saved.tool !== 'crop' ? saved.tool : 'arrow';
        this.color = /^#[0-9a-f]{6}$/i.test(saved.color) ? saved.color : COLORS[0][0];
        this.level = [0, 1, 2].includes(saved.level) ? saved.level : 1;
        this.redactMode = saved.redactMode === 'blur' ? 'blur' : 'pixelate';
        this._listeners = [];
    }

    connect(cb) {
        this._listeners.push(cb);
    }

    set(changes) {
        const changed = Object.keys(changes).some(k => this[k] !== changes[k]);
        Object.assign(this, changes);
        if (changed)
            this._save();
        for (const cb of this._listeners)
            cb(changes);
    }

    _save() {
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(STATE_FILE), 0o700);
            GLib.file_set_contents(STATE_FILE, JSON.stringify({
                tool: this.tool === 'crop' ? 'arrow' : this.tool,
                color: this.color,
                level: this.level,
                redactMode: this.redactMode,
            }));
        } catch (e) {
            console.warn(`Could not save editor state: ${e.message}`);
        }
    }
}

// --- icons -------------------------------------------------------------------

const ICONS = {
    select(cr) {
        cr.moveTo(4, 1.5);
        cr.lineTo(4, 13);
        cr.lineTo(7, 10.3);
        cr.lineTo(9.3, 14.8);
        cr.lineTo(11.3, 13.8);
        cr.lineTo(9.1, 9.4);
        cr.lineTo(12.8, 9.2);
        cr.closePath();
        cr.fill();
    },
    crop(cr) {
        cr.setLineWidth(1.8);
        cr.moveTo(4, 0.5);
        cr.lineTo(4, 12);
        cr.lineTo(15.5, 12);
        cr.moveTo(0.5, 4);
        cr.lineTo(12, 4);
        cr.lineTo(12, 15.5);
        cr.stroke();
    },
    arrow(cr) {
        cr.setLineWidth(1.8);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.moveTo(2.5, 13.5);
        cr.lineTo(10, 6);
        cr.stroke();
        cr.moveTo(14, 2);
        cr.lineTo(12.6, 9);
        cr.lineTo(7, 3.4);
        cr.closePath();
        cr.fill();
    },
    line(cr) {
        cr.setLineWidth(1.8);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.moveTo(2.5, 13.5);
        cr.lineTo(13.5, 2.5);
        cr.stroke();
    },
    rect(cr) {
        cr.setLineWidth(1.6);
        cr.rectangle(1.8, 3.3, 12.4, 9.4);
        cr.stroke();
    },
    ellipse(cr) {
        cr.setLineWidth(1.6);
        cr.save();
        cr.translate(8, 8);
        cr.scale(6.4, 4.9);
        cr.arc(0, 0, 1, 0, 2 * Math.PI);
        cr.restore();
        cr.stroke();
    },
    pen(cr) {
        cr.setLineWidth(1.8);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.moveTo(1.5, 11);
        cr.curveTo(4, 3, 6.5, 3, 7.5, 8);
        cr.curveTo(8.5, 13, 11.5, 13, 14.5, 4);
        cr.stroke();
    },
    highlight(cr, c) {
        cr.setSourceRGBA(c.red, c.green, c.blue, 0.45);
        cr.setLineWidth(5.5);
        cr.moveTo(1, 8);
        cr.lineTo(15, 8);
        cr.stroke();
        cr.setSourceRGBA(c.red, c.green, c.blue, c.alpha);
        cr.setLineWidth(1.5);
        cr.moveTo(1, 13.5);
        cr.lineTo(15, 13.5);
        cr.stroke();
    },
    text(cr) {
        cr.rectangle(2.5, 2, 11, 2.2);
        cr.rectangle(6.9, 2, 2.2, 12);
        cr.fill();
    },
    step(cr) {
        cr.arc(8, 8, 7, 0, 2 * Math.PI);
        cr.fill();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.rectangle(7.1, 4, 1.9, 8.2);
        cr.moveTo(7.1, 4);
        cr.lineTo(5.2, 5.6);
        cr.lineTo(5.9, 6.6);
        cr.lineTo(7.1, 5.8);
        cr.closePath();
        cr.fill();
    },
    redact(cr, c) {
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                cr.setSourceRGBA(c.red, c.green, c.blue, (i + j) % 2 ? 0.35 : 1);
                cr.rectangle(i * 4, j * 4, 4, 4);
                cr.fill();
            }
        }
    },
};

function drawnIcon(draw, size = 16) {
    const area = new Gtk.DrawingArea({
        content_width: size,
        content_height: size,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
    });
    area.set_draw_func((a, cr) => {
        const c = a.get_color();
        cr.setSourceRGBA(c.red, c.green, c.blue, c.alpha);
        draw(cr, c);
        cr.$dispose();
    });
    return area;
}

function rgbaToHex(rgba) {
    const h = v => Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${h(rgba.red)}${h(rgba.green)}${h(rgba.blue)}`;
}

// --- tool bar ------------------------------------------------------------------

export class Toolbar {
    constructor(state) {
        this.state = state;
        this._syncing = false;

        const box = new Gtk.Box({spacing: 12, halign: Gtk.Align.CENTER, css_classes: ['tool-bar']});

        // Tools
        const tools = new Gtk.Box({css_classes: ['linked']});
        this._toolButtons = {};
        let group = null;
        for (const [name, label, key] of TOOLS) {
            const b = new Gtk.ToggleButton({
                child: drawnIcon(ICONS[name]),
                tooltip_text: `${label} (${key})`,
                focus_on_click: false,
            });
            b.set_group(group);
            group ??= b;
            b.connect('toggled', () => {
                if (b.active && !this._syncing)
                    state.set({tool: name});
            });
            this._toolButtons[name] = b;
            tools.append(b);
        }
        box.append(tools);
        box.append(new Gtk.Separator({orientation: Gtk.Orientation.VERTICAL}));

        // Colors
        const colors = new Gtk.Box({spacing: 2});
        this._swatches = [];
        for (const [hex, name] of COLORS) {
            const swatch = drawnIcon((cr, fg) => {
                const [r, g, b] = hexToRgb(hex);
                cr.arc(11, 11, 7, 0, 2 * Math.PI);
                cr.setSourceRGB(r, g, b);
                cr.fillPreserve();
                cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.3);
                cr.setLineWidth(1);
                cr.stroke();
                if (state.color.toLowerCase() === hex) {
                    cr.arc(11, 11, 9.8, 0, 2 * Math.PI);
                    cr.setSourceRGBA(fg.red, fg.green, fg.blue, fg.alpha);
                    cr.setLineWidth(1.6);
                    cr.stroke();
                }
            }, 22);
            const b = new Gtk.Button({child: swatch, tooltip_text: name, focus_on_click: false,
                css_classes: ['flat', 'swatch']});
            b.connect('clicked', () => state.set({color: hex}));
            this._swatches.push(swatch);
            colors.append(b);
        }
        this._colorButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: false, title: 'Pick a Color'}),
            tooltip_text: 'Custom color',
            focus_on_click: false,
            valign: Gtk.Align.CENTER,
        });
        this._colorButton.connect('notify::rgba', () => {
            if (!this._syncing)
                state.set({color: rgbaToHex(this._colorButton.rgba)});
        });
        colors.append(this._colorButton);
        box.append(colors);
        box.append(new Gtk.Separator({orientation: Gtk.Orientation.VERTICAL}));

        // Size
        const sizes = new Gtk.Box({css_classes: ['linked']});
        this._sizeButtons = [];
        group = null;
        ['Small', 'Medium', 'Large'].forEach((label, level) => {
            const radius = [1.6, 2.9, 4.4][level];
            const b = new Gtk.ToggleButton({
                child: drawnIcon(cr => {
                    cr.arc(8, 8, radius, 0, 2 * Math.PI);
                    cr.fill();
                }),
                tooltip_text: `${label} size`,
                focus_on_click: false,
            });
            b.set_group(group);
            group ??= b;
            b.connect('toggled', () => {
                if (b.active && !this._syncing)
                    state.set({level});
            });
            this._sizeButtons.push(b);
            sizes.append(b);
        });
        box.append(sizes);

        // Blur mode, only shown for the blur tool
        this._modeBox = new Gtk.Box({css_classes: ['linked']});
        this._modeButtons = {};
        group = null;
        for (const [mode, label] of [['pixelate', 'Pixelate'], ['blur', 'Blur']]) {
            const b = new Gtk.ToggleButton({label, focus_on_click: false});
            b.set_group(group);
            group ??= b;
            b.connect('toggled', () => {
                if (b.active && !this._syncing)
                    state.set({redactMode: mode});
            });
            this._modeButtons[mode] = b;
            this._modeBox.append(b);
        }
        box.append(this._modeBox);

        this.widget = new Gtk.ScrolledWindow({
            child: box,
            hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            vscrollbar_policy: Gtk.PolicyType.NEVER,
            propagate_natural_height: true,
        });

        state.connect(() => this._sync());
        this._sync();
    }

    // Reflects the state in the widgets without feeding changes back.
    _sync() {
        const s = this.state;
        this._syncing = true;
        this._toolButtons[s.tool].active = true;
        this._sizeButtons[s.level].active = true;
        this._modeButtons[s.redactMode].active = true;
        this._modeBox.visible = s.tool === 'redact';
        if (rgbaToHex(this._colorButton.rgba) !== s.color.toLowerCase()) {
            const rgba = new Gdk.RGBA();
            rgba.parse(s.color);
            this._colorButton.rgba = rgba;
        }
        for (const sw of this._swatches)
            sw.queue_draw();
        this._syncing = false;
    }
}
