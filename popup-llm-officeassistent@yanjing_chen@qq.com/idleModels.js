import {modelIdleSeconds} from './backendUtils.js';

// Dependency-injected timer logic, shared by the extension and regression tests.
export class IdleModels {
    constructor({schedule, cancel, now, unload, report}) {
        Object.assign(this, {schedule, cancel, now, unload, report});
        this.seconds = 60;
        this.models = new Map();
        this.disposed = false;
    }

    setSeconds(seconds) {
        this.seconds = modelIdleSeconds(seconds);
        for (const [model, state] of this.models)
            this._arm(model, state);
    }

    begin(model) {
        const state = this.models.get(model) || {active: 0, timer: null, finished: this.now(), unloading: null};
        this._cancel(state);
        state.active++;
        this.models.set(model, state);
        // A prior unload must finish before the next inference is sent.
        return state.unloading || Promise.resolve();
    }

    finish(model) {
        const state = this.models.get(model);
        if (!state || this.disposed)
            return;
        state.active = Math.max(0, state.active - 1);
        state.finished = this.now();
        this._arm(model, state);
    }

    _cancel(state) {
        if (state.timer !== null)
            this.cancel(state.timer);
        state.timer = null;
    }

    _arm(model, state) {
        this._cancel(state);
        if (this.disposed || state.active > 0 || state.unloading)
            return;
        const remaining = Math.max(0, this.seconds * 1000 - (this.now() - state.finished));
        state.timer = this.schedule(remaining, () => {
            state.timer = null;
            if (this.disposed || state.active > 0)
                return;
            state.unloading = Promise.resolve().then(() => this.unload(model))
                .catch(error => { if (!this.disposed) this.report(error); })
                .finally(() => {
                    state.unloading = null;
                    // No repeated unload retries; new use will arm a new timer.
                    if (state.active === 0)
                        this.models.delete(model);
                });
        });
    }

    dispose() {
        this.disposed = true;
        for (const state of this.models.values())
            this._cancel(state);
        this.models.clear();
    }
}

