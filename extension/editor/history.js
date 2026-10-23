// The document (base image, shapes, crop) and its undo/redo history.

import GdkPixbuf from 'gi://GdkPixbuf';

import {pixbufToSurface} from './shapes.js';

export class Document {
    constructor(file) {
        this.file = file;
        this.pixbuf = GdkPixbuf.Pixbuf.new_from_file(file.get_path());
        this.width = this.pixbuf.get_width();
        this.height = this.pixbuf.get_height();
        this.surface = pixbufToSurface(this.pixbuf);
        // Base size for strokes, fonts and markers, so annotations look the
        // same on a 1080p and a 4K screenshot.
        const unit = Math.max(this.width, this.height) / 700;
        this.unit = Math.round(Math.max(2, Math.min(8, unit)) * 10) / 10;

        this.shapes = [];
        this.crop = null;
        this.dirty = false;
        this._undo = [];
        this._redo = [];
        this._listeners = [];
    }

    // The visible region: the crop if set, otherwise the whole image.
    get view() {
        return this.crop ?? {x: 0, y: 0, w: this.width, h: this.height};
    }

    get hasEdits() {
        return this.shapes.length > 0 || this.crop !== null;
    }

    get canUndo() {
        return this._undo.length > 0;
    }

    get canRedo() {
        return this._redo.length > 0;
    }

    onChange(cb) {
        this._listeners.push(cb);
    }

    _changed() {
        this.dirty = true;
        this.renumber();
        for (const cb of this._listeners)
            cb();
    }

    // Applies a command and records it.
    execute(cmd) {
        cmd.apply(this);
        this.record(cmd);
    }

    // Records a command whose effect is already applied (e.g. a finished drag).
    record(cmd) {
        this._undo.push(cmd);
        this._redo = [];
        this._changed();
    }

    undo() {
        const cmd = this._undo.pop();
        if (!cmd)
            return;
        cmd.revert(this);
        this._redo.push(cmd);
        this._changed();
    }

    redo() {
        const cmd = this._redo.pop();
        if (!cmd)
            return;
        cmd.apply(this);
        this._undo.push(cmd);
        this._changed();
    }

    markClean() {
        this.dirty = false;
    }

    renumber() {
        let n = 1;
        for (const s of this.shapes) {
            if (s.type === 'step')
                s.number = n++;
        }
    }

    // Topmost visible shape under the point. Redactions are drawn underneath
    // everything else, so they are hit-tested last.
    hitTest(x, y, tol) {
        const ordered = [
            ...this.shapes.filter(s => !s.isRedaction),
            ...this.shapes.filter(s => s.isRedaction),
        ];
        for (let i = ordered.length - 1; i >= 0; i--) {
            const s = ordered[i];
            if (!s.hidden && s.hitTest(this, x, y, tol))
                return s;
        }
        return null;
    }

    dispose() {
        for (const s of this.shapes)
            s.invalidate();
        this.surface.finish();
    }
}

export class AddShape {
    constructor(shape) {
        this.shape = shape;
    }

    apply(doc) {
        doc.shapes.push(this.shape);
    }

    revert(doc) {
        doc.shapes.splice(doc.shapes.indexOf(this.shape), 1);
    }
}

export class RemoveShape {
    constructor(shape) {
        this.shape = shape;
        this.index = -1;
    }

    apply(doc) {
        this.index = doc.shapes.indexOf(this.shape);
        doc.shapes.splice(this.index, 1);
    }

    revert(doc) {
        doc.shapes.splice(this.index, 0, this.shape);
    }
}

export class ModifyShape {
    constructor(shape, before, after) {
        this.shape = shape;
        this.before = before;
        this.after = after;
    }

    apply() {
        this.shape.restore(this.after);
    }

    revert() {
        this.shape.restore(this.before);
    }
}

export class SetCrop {
    constructor(before, after) {
        this.before = before;
        this.after = after;
    }

    apply(doc) {
        doc.crop = this.after;
    }

    revert(doc) {
        doc.crop = this.before;
    }
}
