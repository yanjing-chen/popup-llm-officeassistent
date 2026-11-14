// Clutter coords_to_position() uses UTF-8 byte positions; selection APIs use
// Unicode character positions. Pango attribute ranges are byte-based as well.
export function makeTextMap(value) {
    const characters = Array.from(value);
    const bytes = [0];
    for (const character of characters) {
        const cp = character.codePointAt(0);
        const length = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
        bytes.push(bytes.at(-1) + length);
    }
    return {characters, bytes};
}

export function characterAtByte(map, index) {
    if (!Number.isFinite(index))
        return null;
    if (index < 0)
        return map.characters.length;
    let low = 0, high = map.bytes.length - 1;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (map.bytes[middle] <= index)
            low = middle;
        else
            high = middle - 1;
    }
    return low;
}

export function selectionRange(map, anchor, focus) {
    const clamp = value => Math.max(0, Math.min(map.characters.length, Math.trunc(value)));
    const start = Math.min(clamp(anchor), clamp(focus));
    const end = Math.max(clamp(anchor), clamp(focus));
    return {start, end, byteStart: map.bytes[start], byteEnd: map.bytes[end],
        text: map.characters.slice(start, end).join('')};
}
