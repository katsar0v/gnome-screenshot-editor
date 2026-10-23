// Renders the document at native resolution and writes PNG files or bytes.

import Cairo from 'cairo';
import GLib from 'gi://GLib';

import {renderDocument} from './shapes.js';

function renderToSurface(doc) {
    const v = doc.view;
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, v.w, v.h);
    const cr = new Cairo.Context(surface);
    cr.translate(-v.x, -v.y);
    renderDocument(cr, doc);
    cr.$dispose();
    surface.flush();
    return surface;
}

export function savePng(doc, path) {
    const surface = renderToSurface(doc);
    try {
        surface.writeToPNG(path);
    } finally {
        surface.finish();
    }
}

export function pngBytes(doc) {
    const tmp = GLib.build_filenamev([GLib.get_user_runtime_dir(),
        `screenshot-editor-${GLib.uuid_string_random()}.png`]);
    try {
        savePng(doc, tmp);
        return GLib.file_get_contents(tmp)[1];
    } finally {
        GLib.unlink(tmp);
    }
}

// "<dir>/<name>-edited.png", or "-edited-1", "-edited-2"… if taken.
export function freeEditedPath(file) {
    const dir = file.get_parent().get_path();
    const base = file.get_basename().replace(/\.[^.]+$/, '');
    for (let i = 0; ; i++) {
        const name = `${base}-edited${i ? `-${i}` : ''}.png`;
        const path = GLib.build_filenamev([dir, name]);
        if (!GLib.file_test(path, GLib.FileTest.EXISTS))
            return path;
    }
}
