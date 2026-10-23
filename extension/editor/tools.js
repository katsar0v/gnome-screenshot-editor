// One small controller per tool. The canvas converts pointer events to image
// coordinates and forwards them here: begin/update/end for a drag (a click is
// a drag that didn't move), key for keyboard input while the canvas has focus.

import Cairo from 'cairo';
import Gdk from 'gi://Gdk?version=4.0';

import {AddShape, ModifyShape, RemoveShape, SetCrop} from './history.js';
import {BoxShape, LineShape, PathShape, RedactShape, StepShape} from './shapes.js';

const SHIFT = Gdk.ModifierType.SHIFT_MASK;

class Tool {
    constructor(canvas) {
        this.canvas = canvas;
    }

    get doc() {
        return this.canvas.doc;
    }

    get state() {
        return this.canvas.state;
    }

    get cursor() {
        return 'crosshair';
    }

    hoverCursor() {
        return this.cursor;
    }

    activate() {}

    deactivate() {}

    begin() {}

    update() {}

    end() {}

    // Returns true if the tool consumed the key.
    key() {
        return false;
    }

    drawOverlay() {}
}

// Two-point tools: arrow, line, rectangle, ellipse and pixelate/blur.
class DragShapeTool extends Tool {
    constructor(canvas, type) {
        super(canvas);
        this.type = type;
        this._start = null;
    }

    _make(x, y, mods) {
        const [x1, y1] = this._start;
        const {color, level} = this.state;
        if (this.type === 'arrow' || this.type === 'line') {
            if (mods & SHIFT) {
                // Snap to 45° steps.
                const len = Math.hypot(x - x1, y - y1);
                const angle = Math.round(Math.atan2(y - y1, x - x1) / (Math.PI / 4)) * (Math.PI / 4);
                x = x1 + len * Math.cos(angle);
                y = y1 + len * Math.sin(angle);
            }
            return new LineShape(this.type, {x1, y1, x2: x, y2: y, color, level});
        }

        let w = x - x1, h = y - y1;
        if (mods & SHIFT) {
            const side = Math.max(Math.abs(w), Math.abs(h));
            w = Math.sign(w || 1) * side;
            h = Math.sign(h || 1) * side;
        }
        const rect = {x: Math.min(x1, x1 + w), y: Math.min(y1, y1 + h), w: Math.abs(w), h: Math.abs(h)};
        if (this.type === 'redact')
            return new RedactShape({...rect, mode: this.state.redactMode, level});
        return new BoxShape(this.type, {...rect, color, level});
    }

    _bigEnough(shape) {
        const min = this.canvas.tolerance;
        if (shape instanceof LineShape)
            return shape.length >= min;
        return shape.w >= min / 2 && shape.h >= min / 2;
    }

    begin(x, y) {
        this._start = [x, y];
    }

    update(x, y, mods) {
        this.canvas.preview = this._make(x, y, mods);
    }

    end(x, y, mods) {
        const shape = this._make(x, y, mods);
        this.canvas.preview = null;
        this._start = null;
        if (this._bigEnough(shape))
            this.doc.execute(new AddShape(shape));
    }

    key(keyval) {
        if (keyval === Gdk.KEY_Escape && this._start) {
            this._start = null;
            this.canvas.preview = null;
            return true;
        }
        return false;
    }
}

// Freehand tools: pen and highlighter.
class PathTool extends Tool {
    constructor(canvas, type) {
        super(canvas);
        this.type = type;
        this._shape = null;
    }

    begin(x, y) {
        const {color, level} = this.state;
        this._shape = new PathShape(this.type, {points: [[x, y]], color, level});
        this.canvas.preview = this._shape;
    }

    update(x, y) {
        const pts = this._shape.points;
        const [lx, ly] = pts[pts.length - 1];
        // Skip sub-pixel jitter (in screen terms) to keep paths light.
        if (Math.hypot(x - lx, y - ly) >= this.canvas.tolerance / 4)
            pts.push([x, y]);
    }

    end(x, y) {
        const shape = this._shape;
        this._shape = null;
        this.canvas.preview = null;
        // A click without movement leaves a dot.
        if (shape.points.length === 1)
            shape.points.push([x + 0.01, y]);
        this.doc.execute(new AddShape(shape));
    }
}

class StepTool extends Tool {
    end(x, y) {
        const {color, level} = this.state;
        this.doc.execute(new AddShape(new StepShape({x, y, color, level})));
    }
}

class TextTool extends Tool {
    get cursor() {
        return 'text';
    }

    end(x, y) {
        this.canvas.startTextEdit(x, y, null);
    }
}

class SelectTool extends Tool {
    constructor(canvas) {
        super(canvas);
        this._drag = null;
    }

    get cursor() {
        return 'default';
    }

    hoverCursor(x, y) {
        return this.doc.hitTest(x, y, this.canvas.tolerance) ? 'move' : 'default';
    }

    deactivate() {
        this.canvas.setSelection(null);
    }

    begin(x, y) {
        const hit = this.doc.hitTest(x, y, this.canvas.tolerance);
        this.canvas.setSelection(hit);
        this._drag = hit ? {shape: hit, before: hit.snapshot(), last: [x, y], moved: false} : null;
    }

    update(x, y) {
        const d = this._drag;
        if (!d)
            return;
        d.shape.translate(x - d.last[0], y - d.last[1]);
        d.last = [x, y];
        d.moved = true;
    }

    end() {
        const d = this._drag;
        this._drag = null;
        if (d?.moved)
            this.doc.record(new ModifyShape(d.shape, d.before, d.shape.snapshot()));
    }

    key(keyval) {
        const sel = this.canvas.selection;
        if (!sel)
            return false;
        if (keyval === Gdk.KEY_Delete || keyval === Gdk.KEY_BackSpace) {
            this.canvas.setSelection(null);
            this.doc.execute(new RemoveShape(sel));
            return true;
        }
        if (keyval === Gdk.KEY_Escape) {
            this.canvas.setSelection(null);
            return true;
        }
        return false;
    }
}

// Non-destructive crop: drag a rectangle, move it, or drag a corner to resize;
// Enter applies, Esc cancels. While active, the canvas shows the full image.
class CropTool extends Tool {
    constructor(canvas) {
        super(canvas);
        this.pending = null;
        this._drag = null;
    }

    activate() {
        this.pending = this.doc.crop ? {...this.doc.crop} : null;
    }

    deactivate() {
        this.pending = null;
        this._drag = null;
    }

    _corner(x, y) {
        const p = this.pending;
        if (!p)
            return null;
        const t = this.canvas.tolerance * 1.5;
        for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
            if (Math.abs(x - (p.x + cx * p.w)) <= t && Math.abs(y - (p.y + cy * p.h)) <= t)
                return [cx, cy];
        }
        return null;
    }

    _inside(x, y) {
        const p = this.pending;
        return p && x > p.x && x < p.x + p.w && y > p.y && y < p.y + p.h;
    }

    hoverCursor(x, y) {
        const c = this._corner(x, y);
        if (c)
            return c[0] === c[1] ? 'nwse-resize' : 'nesw-resize';
        return this._inside(x, y) ? 'move' : 'crosshair';
    }

    _clampPoint(x, y) {
        return [Math.max(0, Math.min(this.doc.width, x)), Math.max(0, Math.min(this.doc.height, y))];
    }

    begin(x, y) {
        [x, y] = this._clampPoint(x, y);
        const corner = this._corner(x, y);
        if (corner) {
            const p = this.pending;
            // Anchor the opposite corner.
            this._drag = {mode: 'new', ax: p.x + (1 - corner[0]) * p.w, ay: p.y + (1 - corner[1]) * p.h};
        } else if (this._inside(x, y)) {
            this._drag = {mode: 'move', start: [x, y], orig: {...this.pending}};
        } else {
            this._drag = {mode: 'new', ax: x, ay: y};
            this.pending = null;
        }
    }

    update(x, y) {
        const d = this._drag;
        if (!d)
            return;
        if (d.mode === 'move') {
            const o = d.orig;
            const nx = Math.max(0, Math.min(this.doc.width - o.w, o.x + x - d.start[0]));
            const ny = Math.max(0, Math.min(this.doc.height - o.h, o.y + y - d.start[1]));
            this.pending = {...o, x: nx, y: ny};
            return;
        }
        [x, y] = this._clampPoint(x, y);
        this.pending = {x: Math.min(d.ax, x), y: Math.min(d.ay, y),
            w: Math.abs(x - d.ax), h: Math.abs(y - d.ay)};
    }

    end() {
        this._drag = null;
        const p = this.pending;
        if (p && (p.w < this.canvas.tolerance || p.h < this.canvas.tolerance))
            this.pending = null;
    }

    apply() {
        let p = this.pending;
        if (p) {
            const x = Math.round(p.x), y = Math.round(p.y);
            p = {x, y, w: Math.round(p.x + p.w) - x, h: Math.round(p.y + p.h) - y};
            if (p.x === 0 && p.y === 0 && p.w === this.doc.width && p.h === this.doc.height)
                p = null;
        }
        const before = this.doc.crop;
        if (JSON.stringify(before) !== JSON.stringify(p))
            this.doc.execute(new SetCrop(before, p));
        this.canvas.leaveCrop();
    }

    reset() {
        this.pending = null;
        this.canvas.queueDraw();
    }

    key(keyval) {
        if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
            this.apply();
            return true;
        }
        if (keyval === Gdk.KEY_Escape) {
            this.canvas.leaveCrop();
            return true;
        }
        return false;
    }

    // Image-space overlay: dim everything outside the pending rectangle.
    drawOverlay(cr, fit) {
        const p = this.pending;
        cr.setFillRule(Cairo.FillRule.EVEN_ODD);
        cr.rectangle(0, 0, this.doc.width, this.doc.height);
        if (p)
            cr.rectangle(p.x, p.y, p.w, p.h);
        cr.setSourceRGBA(0, 0, 0, 0.55);
        cr.fill();
        cr.setFillRule(Cairo.FillRule.WINDING);
        if (!p)
            return;

        const lw = 1.5 / fit;
        cr.setLineWidth(lw);
        cr.setSourceRGBA(1, 1, 1, 0.9);
        cr.rectangle(p.x, p.y, p.w, p.h);
        cr.stroke();

        // Rule-of-thirds guides.
        cr.setSourceRGBA(1, 1, 1, 0.35);
        cr.setLineWidth(1 / fit);
        for (const f of [1 / 3, 2 / 3]) {
            cr.moveTo(p.x + p.w * f, p.y);
            cr.lineTo(p.x + p.w * f, p.y + p.h);
            cr.moveTo(p.x, p.y + p.h * f);
            cr.lineTo(p.x + p.w, p.y + p.h * f);
        }
        cr.stroke();

        // Corner handles.
        const len = 18 / fit;
        cr.setSourceRGBA(1, 1, 1, 1);
        cr.setLineWidth(4 / fit);
        for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
            const x = p.x + cx * p.w, y = p.y + cy * p.h;
            const sx = cx ? -1 : 1, sy = cy ? -1 : 1;
            cr.moveTo(x + sx * len, y);
            cr.lineTo(x, y);
            cr.lineTo(x, y + sy * len);
        }
        cr.stroke();
    }
}

export function createTools(canvas) {
    return {
        select: new SelectTool(canvas),
        crop: new CropTool(canvas),
        arrow: new DragShapeTool(canvas, 'arrow'),
        line: new DragShapeTool(canvas, 'line'),
        rect: new DragShapeTool(canvas, 'rect'),
        ellipse: new DragShapeTool(canvas, 'ellipse'),
        pen: new PathTool(canvas, 'pen'),
        highlight: new PathTool(canvas, 'highlight'),
        text: new TextTool(canvas),
        step: new StepTool(canvas),
        redact: new DragShapeTool(canvas, 'redact'),
    };
}
