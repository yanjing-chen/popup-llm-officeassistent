import {makeTextMap} from '../popup-llm-officeassistent@yanjing_chen@qq.com/textSelection.js';
import {pointerEvent} from './mouse-selection.mjs';

// Model the documented Pango result: UTF-8 byte index + separate trailing
// CHARACTER count. Compact Clutter hits can land inside a multibyte character;
// the old floor-to-byte-boundary conversion loses the final Chinese glyph.
export function pangoSelection(f, window, label, value, {columns = 80, offsets = [0, 0], scale = 1, resourceScale = 1} = {}) {
    window._setResultText(value);
    const actor = label.get_clutter_text(), map = makeTextMap(value), rows = [];
    let row = {start: 0, end: 0, glyphs: []}, position = 0;
    for (const {segment} of new Intl.Segmenter('und', {granularity: 'grapheme'}).segment(value)) {
        const count = Array.from(segment).length;
        if (segment === '\n') {
            row.end = position; rows.push(row); position += count;
            row = {start: position, end: position, glyphs: []};
            continue;
        }
        if (row.glyphs.length === columns) {
            rows.push(row); row = {start: position, end: position, glyphs: []};
        }
        row.glyphs.push({start: position, end: position + count});
        position += count; row.end = position;
    }
    rows.push(row);
    const hits = [];
    const query = (x, y) => {
        const index = Math.max(0, Math.min(rows.length - 1, Math.floor(y / 20))), current = rows[index];
        if (!current.glyphs.length) return [false, map.bytes[current.start], 0];
        const column = Math.max(0, Math.min(current.glyphs.length - 1, Math.floor(x / 10)));
        const glyph = current.glyphs[column];
        const trailing = x >= column * 10 + 5 ? glyph.end - glyph.start : 0;
        return [x >= 0 && x < current.glyphs.length * 10 && y >= 0 && y < rows.length * 20,
            map.bytes[glyph.start], trailing];
    };
    actor._hitScale = scale;
    actor._hitResourceScale = resourceScale;
    actor.get_resource_scale = () => actor._hitResourceScale;
    actor.height = rows.length * 20 + offsets[1];
    actor.get_layout_offsets = () => offsets.map(value => value * actor._hitResourceScale);
    actor.get_layout = () => ({xy_to_index(x, y) {
        hits.push([x, y]);
        return query(x / 1024 / actor._hitResourceScale, y / 1024 / actor._hitResourceScale);
    }});
    actor.coords_to_position = (x, y) => {
        const [, index, trailing] = query(x - offsets[0], y - offsets[1]);
        return index + trailing;
    };
    actor.position_to_coords = index => {
        const lineIndex = rows.findLastIndex(line => index >= line.start);
        const line = rows[Math.max(0, lineIndex)];
        const column = line.glyphs.filter(glyph => glyph.end <= index).length;
        return [true, offsets[0] + column * 10, offsets[1] + Math.max(0, lineIndex) * 20, 20];
    };
    const point = (x, line = 0) => {
        const [ox, oy] = actor._hitOrigin || [100, 200];
        return [ox + (offsets[0] + x) * scale, oy + (offsets[1] + line * 20 + 10) * scale];
    };
    return {actor, rows, hits, map, point,
        start: point(0), end: point(rows.at(-1).glyphs.length * 10 + 35, rows.length - 1)};
}

export function dragPoints(f, window, label, from, to, {outsideRelease = false} = {}) {
    const actor = label.get_clutter_text();
    f.pointer([...from, 256]);
    window._resultContainer.emit('captured-event', pointerEvent(f, actor, from));
    f.pointer([...to, 256]); f.frames(); f.pointer([...to, 0]);
    if (outsideRelease) f.frames();
    else actor.emit('button-release-event', pointerEvent(f, actor, to));
    f.flushIdles();
}
