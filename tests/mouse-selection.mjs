// Drive the actual production pointer handlers; never write a requested range
// with set_selection() from a test. Only the production code may create it.
export function pointAt(text, index) {
    const [, x, y, height] = text.position_to_coords(index);
    const [ox, oy] = text._hitOrigin || [100, 200];
    const scale = text._hitScale || 1;
    return [ox + x * scale, oy + (y + height / 2) * scale];
}

export function pointerEvent(f, source, point, button = 1, state = 0) {
    const event = {get_button: () => button, get_coords: () => point, get_state: () => state,
        get_source: () => null, type: () => f.events.BUTTON_PRESS};
    f.registerEventActor(event, source);
    return event;
}

export function mouseSelect(f, window, label, start, end, {flush = true, source = label.get_clutter_text(), outsideRelease = false, modifiers = 0} = {}) {
    const text = label.get_clutter_text(), from = pointAt(text, start), to = pointAt(text, end);
    f.pointer([...from, 256]);
    const press = pointerEvent(f, source, from, 1, modifiers);
    const handled = window._resultContainer.emit('captured-event', press);
    if (handled !== f.Clutter.EVENT_STOP)
        source.emit('button-press-event', press);
    f.pointer([...to, 256]); f.frames();
    f.pointer([...to, 0]);
    if (outsideRelease) f.frames();
    else source.emit('button-release-event', pointerEvent(f, source, to));
    if (flush) f.flushIdles();
}
