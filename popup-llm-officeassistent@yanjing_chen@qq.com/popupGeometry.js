// Stage-independent resize math. Keep the opposite edge anchored, including
// negative-origin monitors, and never let the popup leave its work area.
export function resizeHit(x, y, width, height, border = 7) {
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0 ||
        x < 0 || y < 0 || x > width || y > height)
        return null;
    const west = x <= border, east = x >= width - border;
    const north = y <= border, south = y >= height - border;
    const corner = border * 2;
    if ((west && y <= corner) || (north && x <= corner)) return 'nw';
    if ((east && y <= corner) || (north && x >= width - corner)) return 'ne';
    if ((west && y >= height - corner) || (south && x <= corner)) return 'sw';
    if ((east && y >= height - corner) || (south && x >= width - corner)) return 'se';
    return west ? 'w' : east ? 'e' : north ? 'n' : south ? 's' : null;
}

export function resizedRect(original, edge, dx, dy, area, minWidth = 300, minHeight = 220) {
    const left = area.x + 8, top = area.y + 8;
    const right = area.x + area.width - 8, bottom = area.y + area.height - 8;
    const minW = Math.min(minWidth, Math.max(1, right - left));
    const minH = Math.min(minHeight, Math.max(1, bottom - top));
    let x1 = Math.max(left, original.x), y1 = Math.max(top, original.y);
    let x2 = Math.min(right, original.x + original.width), y2 = Math.min(bottom, original.y + original.height);
    if (x2 - x1 < minW) { x2 = Math.min(right, x1 + minW); x1 = x2 - minW; }
    if (y2 - y1 < minH) { y2 = Math.min(bottom, y1 + minH); y1 = y2 - minH; }
    if (edge.includes('w')) x1 = Math.max(left, Math.min(x2 - minW, original.x + dx));
    if (edge.includes('e')) x2 = Math.min(right, Math.max(x1 + minW, original.x + original.width + dx));
    if (edge.includes('n')) y1 = Math.max(top, Math.min(y2 - minH, original.y + dy));
    if (edge.includes('s')) y2 = Math.min(bottom, Math.max(y1 + minH, original.y + original.height + dy));
    return {x: Math.round(x1), y: Math.round(y1), width: Math.round(x2 - x1), height: Math.round(y2 - y1)};
}

export function resultFontSize(value) {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(8, Math.min(32, Math.round(value))) : 11;
}

// Compose valid St.Widget inline CSS whether the label has an existing style
// (QA message alignment) or no inline style at all (translation/OCR).
// Do not append another font-size on every live GSettings change.
export function resultFontStyle(baseStyle, size) {
    const declarations = String(baseStyle ?? '')
        .split(';')
        .map(part => part.trim())
        .filter(part => part && !/^font-size\s*:/i.test(part));
    declarations.push(`font-size: ${resultFontSize(size)}pt`);
    return `${declarations.join('; ')};`;
}
