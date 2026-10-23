// Annotation shapes. Everything here is in image-pixel coordinates;
// only canvas.js knows about widget coordinates.

import Cairo from 'cairo';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

// Size multipliers per S/M/L level, applied to the document unit.
const STROKE = [1, 2, 4];
const HIGHLIGHT = [5, 8, 12];
const FONT = [6, 9, 13];
const STEP_RADIUS = [5, 7, 10];
const PIXEL_BLOCK = [3, 4, 6];

export function strokeWidth(doc, level) {
    return doc.unit * STROKE[level];
}

export function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

function setColor(cr, hex, alpha = 1) {
    const [r, g, b] = hexToRgb(hex);
    cr.setSourceRGBA(r, g, b, alpha);
}

function isLight(hex) {
    const [r, g, b] = hexToRgb(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6;
}

export function pixbufToSurface(pixbuf) {
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32,
        pixbuf.get_width(), pixbuf.get_height());
    const cr = new Cairo.Context(surface);
    Gdk.cairo_set_source_pixbuf(cr, pixbuf, 0, 0);
    cr.paint();
    cr.$dispose();
    return surface;
}

function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function normRect(x1, y1, x2, y2) {
    return {x: Math.min(x1, x2), y: Math.min(y1, y2),
        w: Math.abs(x2 - x1), h: Math.abs(y2 - y1)};
}

class Shape {
    constructor(type, props) {
        this.type = type;
        this.hidden = false;
        Object.assign(this, props);
    }

    // Plain-data copy of the geometry and style, used by undo commands.
    snapshot() {
        const out = {};
        for (const k of this.constructor.PROPS)
            out[k] = JSON.parse(JSON.stringify(this[k]));
        return out;
    }

    restore(snap) {
        Object.assign(this, JSON.parse(JSON.stringify(snap)));
        this.invalidate();
    }

    invalidate() {}

    get isRedaction() {
        return false;
    }
}

export class LineShape extends Shape {
    static PROPS = ['x1', 'y1', 'x2', 'y2', 'color', 'level'];

    // type is 'arrow' or 'line'
    constructor(type, props) {
        super(type, props);
    }

    get length() {
        return Math.hypot(this.x2 - this.x1, this.y2 - this.y1);
    }

    _headLength(doc) {
        const w = strokeWidth(doc, this.level);
        return Math.min(this.length, w * 3 + doc.unit * 4);
    }

    draw(cr, doc) {
        const w = strokeWidth(doc, this.level);
        setColor(cr, this.color);
        cr.setLineWidth(w);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);

        const len = this.length;
        if (this.type !== 'arrow' || len < 1) {
            cr.moveTo(this.x1, this.y1);
            cr.lineTo(this.x2, this.y2);
            cr.stroke();
            return;
        }

        const ux = (this.x2 - this.x1) / len, uy = (this.y2 - this.y1) / len;
        const head = this._headLength(doc);
        const half = head * 0.55;
        const bx = this.x2 - ux * head, by = this.y2 - uy * head;

        // Stop the shaft inside the head so the round cap can't poke out of the tip.
        const stop = head * 0.6;
        cr.moveTo(this.x1, this.y1);
        cr.lineTo(this.x2 - ux * stop, this.y2 - uy * stop);
        cr.stroke();

        cr.moveTo(this.x2, this.y2);
        cr.lineTo(bx - uy * half, by + ux * half);
        cr.lineTo(bx + uy * half, by - ux * half);
        cr.closePath();
        cr.fill();
    }

    bounds(doc) {
        const pad = strokeWidth(doc, this.level) * 2;
        const r = normRect(this.x1, this.y1, this.x2, this.y2);
        return {x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad};
    }

    hitTest(doc, x, y, tol) {
        return distToSegment(x, y, this.x1, this.y1, this.x2, this.y2) <=
            strokeWidth(doc, this.level) / 2 + tol;
    }

    translate(dx, dy) {
        this.x1 += dx;
        this.y1 += dy;
        this.x2 += dx;
        this.y2 += dy;
    }
}

export class BoxShape extends Shape {
    static PROPS = ['x', 'y', 'w', 'h', 'color', 'level'];

    // type is 'rect' or 'ellipse'
    constructor(type, props) {
        super(type, props);
    }

    draw(cr, doc) {
        if (this.w < 1 || this.h < 1)
            return;
        setColor(cr, this.color);
        cr.setLineWidth(strokeWidth(doc, this.level));
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        if (this.type === 'rect') {
            cr.rectangle(this.x, this.y, this.w, this.h);
        } else {
            cr.save();
            cr.translate(this.x + this.w / 2, this.y + this.h / 2);
            cr.scale(this.w / 2, this.h / 2);
            cr.arc(0, 0, 1, 0, 2 * Math.PI);
            cr.restore();
        }
        cr.stroke();
    }

    bounds(doc) {
        const pad = strokeWidth(doc, this.level);
        return {x: this.x - pad, y: this.y - pad, w: this.w + 2 * pad, h: this.h + 2 * pad};
    }

    // Outline-only hit test, so a big box doesn't swallow clicks on what it surrounds.
    hitTest(doc, x, y, tol) {
        const t = strokeWidth(doc, this.level) / 2 + tol;
        if (this.type === 'rect') {
            const inOuter = x >= this.x - t && x <= this.x + this.w + t &&
                y >= this.y - t && y <= this.y + this.h + t;
            const inInner = x > this.x + t && x < this.x + this.w - t &&
                y > this.y + t && y < this.y + this.h - t;
            return inOuter && !inInner;
        }
        const rx = this.w / 2, ry = this.h / 2;
        if (rx < 1 || ry < 1)
            return false;
        const nx = (x - this.x - rx) / rx, ny = (y - this.y - ry) / ry;
        return Math.abs(Math.hypot(nx, ny) - 1) * Math.min(rx, ry) <= t;
    }

    translate(dx, dy) {
        this.x += dx;
        this.y += dy;
    }
}

export class PathShape extends Shape {
    static PROPS = ['points', 'color', 'level'];

    // type is 'pen' or 'highlight'
    constructor(type, props) {
        super(type, props);
    }

    width(doc) {
        return doc.unit * (this.type === 'highlight' ? HIGHLIGHT : STROKE)[this.level];
    }

    draw(cr, doc) {
        const pts = this.points;
        if (pts.length < 2)
            return;
        setColor(cr, this.color, this.type === 'highlight' ? 0.35 : 1);
        cr.setLineWidth(this.width(doc));
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);

        // Smooth the polyline: curve through midpoints, using points as controls.
        cr.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length - 1; i++) {
            const [cx, cy] = pts[i];
            const mx = (cx + pts[i + 1][0]) / 2, my = (cy + pts[i + 1][1]) / 2;
            const [px, py] = i === 1 ? pts[0] : [(pts[i - 1][0] + cx) / 2, (pts[i - 1][1] + cy) / 2];
            cr.curveTo(px + 2 / 3 * (cx - px), py + 2 / 3 * (cy - py),
                mx + 2 / 3 * (cx - mx), my + 2 / 3 * (cy - my), mx, my);
        }
        const last = pts[pts.length - 1];
        cr.lineTo(last[0], last[1]);
        cr.stroke();
    }

    bounds(doc) {
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const [x, y] of this.points) {
            x1 = Math.min(x1, x);
            y1 = Math.min(y1, y);
            x2 = Math.max(x2, x);
            y2 = Math.max(y2, y);
        }
        const pad = this.width(doc) / 2;
        return {x: x1 - pad, y: y1 - pad, w: x2 - x1 + 2 * pad, h: y2 - y1 + 2 * pad};
    }

    hitTest(doc, x, y, tol) {
        const t = this.width(doc) / 2 + tol;
        const pts = this.points;
        for (let i = 1; i < pts.length; i++) {
            if (distToSegment(x, y, ...pts[i - 1], ...pts[i]) <= t)
                return true;
        }
        return false;
    }

    translate(dx, dy) {
        this.points = this.points.map(([x, y]) => [x + dx, y + dy]);
    }
}

// A 1x1 surface for measuring text when there is no draw context.
let _measureCr = null;

export function fontPx(doc, level) {
    return doc.unit * FONT[level];
}

function createLayout(cr, text, px) {
    const layout = PangoCairo.create_layout(cr);
    const desc = Pango.FontDescription.from_string('Sans Bold');
    desc.set_absolute_size(px * Pango.SCALE);
    layout.set_font_description(desc);
    layout.set_text(text, -1);
    return layout;
}

export function measureText(text, px) {
    if (!_measureCr)
        _measureCr = new Cairo.Context(new Cairo.ImageSurface(Cairo.Format.ARGB32, 1, 1));
    return createLayout(_measureCr, text, px).get_pixel_size();
}

export class TextShape extends Shape {
    static PROPS = ['x', 'y', 'text', 'color', 'level'];

    constructor(props) {
        super('text', props);
    }

    _size(doc) {
        return measureText(this.text, fontPx(doc, this.level));
    }

    draw(cr, doc) {
        const layout = createLayout(cr, this.text, fontPx(doc, this.level));
        // A thin contrasting halo keeps text readable on busy backgrounds.
        cr.moveTo(this.x, this.y);
        PangoCairo.layout_path(cr, layout);
        cr.setLineWidth(Math.max(1, doc.unit * 0.5));
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        if (isLight(this.color))
            cr.setSourceRGBA(0, 0, 0, 0.45);
        else
            cr.setSourceRGBA(1, 1, 1, 0.6);
        cr.strokePreserve();
        setColor(cr, this.color);
        cr.fill();
    }

    bounds(doc) {
        const [w, h] = this._size(doc);
        return {x: this.x, y: this.y, w, h};
    }

    hitTest(doc, x, y, tol) {
        const b = this.bounds(doc);
        return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;
    }

    translate(dx, dy) {
        this.x += dx;
        this.y += dy;
    }
}

export class StepShape extends Shape {
    static PROPS = ['x', 'y', 'color', 'level'];

    constructor(props) {
        super('step', props);
        this.number = 1; // assigned by Document.renumber()
    }

    radius(doc) {
        return doc.unit * STEP_RADIUS[this.level];
    }

    draw(cr, doc) {
        const r = this.radius(doc);
        cr.arc(this.x, this.y, r, 0, 2 * Math.PI);
        setColor(cr, this.color);
        cr.fillPreserve();
        cr.setLineWidth(Math.max(1, r * 0.12));
        cr.setSourceRGBA(1, 1, 1, 0.9);
        cr.stroke();

        const layout = createLayout(cr, String(this.number), r * 1.15);
        const [, logical] = layout.get_pixel_extents();
        cr.moveTo(this.x - logical.width / 2 - logical.x, this.y - logical.height / 2 - logical.y);
        if (isLight(this.color))
            cr.setSourceRGB(0, 0, 0);
        else
            cr.setSourceRGB(1, 1, 1);
        PangoCairo.show_layout(cr, layout);
    }

    bounds(doc) {
        const r = this.radius(doc);
        return {x: this.x - r, y: this.y - r, w: 2 * r, h: 2 * r};
    }

    hitTest(doc, x, y, tol) {
        return Math.hypot(x - this.x, y - this.y) <= this.radius(doc) + tol;
    }

    translate(dx, dy) {
        this.x += dx;
        this.y += dy;
    }
}

// Pixelate/blur samples only the base image and is always drawn below other
// annotations, so the original pixels in the region never reach the export.
export class RedactShape extends Shape {
    static PROPS = ['x', 'y', 'w', 'h', 'mode', 'level'];

    constructor(props) {
        super('redact', props);
        this._cache = null;
    }

    get isRedaction() {
        return true;
    }

    invalidate() {
        this._cache = null;
    }

    _clamped(doc) {
        const x = Math.max(0, Math.floor(this.x));
        const y = Math.max(0, Math.floor(this.y));
        const x2 = Math.min(doc.width, Math.ceil(this.x + this.w));
        const y2 = Math.min(doc.height, Math.ceil(this.y + this.h));
        return {x, y, w: x2 - x, h: y2 - y};
    }

    _surface(doc) {
        const r = this._clamped(doc);
        if (r.w < 1 || r.h < 1)
            return null;
        const block = doc.unit * PIXEL_BLOCK[this.level];
        const key = `${r.x},${r.y},${r.w},${r.h},${this.mode},${block}`;
        if (this._cache?.key === key)
            return this._cache;

        const sub = doc.pixbuf.new_subpixbuf(r.x, r.y, r.w, r.h);
        const factor = this.mode === 'blur' ? block * 1.5 : block;
        const small = sub.scale_simple(Math.max(1, Math.round(r.w / factor)),
            Math.max(1, Math.round(r.h / factor)), GdkPixbuf.InterpType.TILES);
        const big = small.scale_simple(r.w, r.h, this.mode === 'blur'
            ? GdkPixbuf.InterpType.BILINEAR : GdkPixbuf.InterpType.NEAREST);
        this._cache?.surface.finish();
        this._cache = {key, rect: r, surface: pixbufToSurface(big)};
        return this._cache;
    }

    draw(cr, doc) {
        const c = this._surface(doc);
        if (!c)
            return;
        cr.setSourceSurface(c.surface, c.rect.x, c.rect.y);
        cr.rectangle(c.rect.x, c.rect.y, c.rect.w, c.rect.h);
        cr.fill();
    }

    bounds() {
        return {x: this.x, y: this.y, w: this.w, h: this.h};
    }

    hitTest(doc, x, y, tol) {
        return x >= this.x - tol && x <= this.x + this.w + tol &&
            y >= this.y - tol && y <= this.y + this.h + tol;
    }

    translate(dx, dy) {
        this.x += dx;
        this.y += dy;
        this.invalidate();
    }
}

// Each shape starts from an empty path, so leftovers (e.g. the current point
// after drawing text) never join shapes together.
export function drawShape(cr, shape, doc) {
    cr.newPath();
    shape.draw(cr, doc);
    cr.newPath();
}

// Draws the base image and all visible shapes.
export function renderDocument(cr, doc) {
    cr.setSourceSurface(doc.surface, 0, 0);
    cr.paint();
    renderShapes(cr, doc);
}

// Redactions go first so they sit under every other annotation regardless of
// creation order.
export function renderShapes(cr, doc) {
    for (const s of doc.shapes) {
        if (s.isRedaction && !s.hidden)
            drawShape(cr, s, doc);
    }
    for (const s of doc.shapes) {
        if (!s.isRedaction && !s.hidden)
            drawShape(cr, s, doc);
    }
}
