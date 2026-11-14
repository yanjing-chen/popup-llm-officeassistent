// Shared, GI-free helpers. Keep these usable in both prefs and Shell processes.
export function endpointUrls(endpoint) {
    const match = String(endpoint).trim().match(/^(https?):\/\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?$/i);
    if (!match || match[2].includes('@'))
        throw new Error('请填写有效的 HTTP(S) Chat Completions 地址，不要在地址中包含账号密码。');
    const origin = `${match[1]}://${match[2]}`;
    const path = (match[3] || '').replace(/\/+$/, '');
    let prefix;
    let models;
    if (/\/api\/v0\/chat\/completions$/.test(path)) {
        prefix = path.replace(/\/api\/v0\/chat\/completions$/, '');
        models = `${origin}${prefix}/api/v0/models`;
    } else if (/\/v1\/chat\/completions$/.test(path)) {
        prefix = path.replace(/\/v1\/chat\/completions$/, '');
        models = `${origin}${prefix}/v1/models`;
    } else if (/\/chat\/completions$/.test(path)) {
        prefix = path.replace(/\/chat\/completions$/, '');
        models = `${origin}${prefix}/models`;
    } else {
        throw new Error('接口链接应以 /v1/chat/completions 或 /chat/completions 结尾。');
    }
    return {
        models,
        ollamaTags: `${origin}${prefix}/api/tags`,
        ollamaUnload: `${origin}${prefix}/api/generate`,
        lmModels: `${origin}${prefix}/api/v1/models`,
        lmLegacyModels: `${origin}${prefix}/api/v0/models`,
        lmUnload: `${origin}${prefix}/api/v1/models/unload`,
        runtimePreferences: `${origin}${prefix}/v1/runtime/preferences`,
    };
}

export function isRuntimePreferences(value) {
    return typeof value?.preload_model === 'string' && typeof value.preload_enabled === 'boolean' &&
        typeof value.backend_preference === 'string' &&
        Number.isInteger(value.idle_unload_seconds) && value.idle_unload_seconds >= 0 &&
        value.idle_unload_seconds <= 86400;
}

export function isOllamaCatalog(value) {
    return Array.isArray(value?.models) &&
        value.models.every(m => typeof m.name === 'string' && typeof m.digest === 'string');
}

export function isLMStudioCatalog(value) {
    return Array.isArray(value?.models) && value.models.length > 0 &&
        value.models.every(m => typeof m.key === 'string' && Array.isArray(m.loaded_instances));
}

export function isLegacyLMStudioCatalog(value) {
    return Array.isArray(value?.data) && value.data.length > 0 &&
        value.data.every(m => typeof m.id === 'string' &&
            ['llm', 'vlm', 'embeddings'].includes(m.type) &&
            ['loaded', 'not-loaded'].includes(m.state));
}

export function parseModelList(value) {
    const rows = Array.isArray(value?.data) ? value.data : value?.models;
    if (!Array.isArray(rows))
        throw new Error('模型列表格式不受支持，接口应返回 data 或 models 数组。');
    const models = new Map();
    for (const row of rows) {
        if (['embedding', 'embeddings', 'reranker', 'decision'].includes(row.type))
            continue;
        const id = row.id || row.key || row.name || row.model;
        if (typeof id === 'string' && id.trim())
            models.set(id, {id, label: row.display_name ? `${row.display_name} — ${id}` : id});
    }
    return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// A status placeholder is not a model. Never display a saved/example ID unless
// the latest successful backend catalog actually contains that exact ID.
export function modelChoices(models, current, status = 'ready') {
    if (status !== 'ready') {
        const label = status === 'error' ? '无法获取模型列表' : '正在读取模型…';
        return {entries: [{id: null, label, available: false}], selected: 0};
    }
    const entries = models.map(m => ({...m, available: true}));
    if (entries.length === 0)
        return {entries: [{id: null, label: '尚未安装模型', available: false}], selected: 0};
    const selected = entries.findIndex(m => m.id === current);
    if (selected >= 0)
        return {entries, selected};
    // Require an explicit choice rather than silently switching a function to
    // another model. Do not recreate the missing model as an unavailable item.
    entries.unshift({id: null, label: '请选择模型', available: false});
    return {entries, selected: 0};
}

export function modelIdleSeconds(value) {
    return Number.isInteger(value) && value >= 0 && value <= 86400 ? value : 60;
}

export function migrateModelIdleTime(settings) {
    const seconds = modelIdleSeconds(settings.get_int('model-idle-time'));
    // Persist the effective value too: a new schema may already mask an old
    // out-of-range -1 with its default. Only this requested key is migrated.
    settings.set_int('model-idle-time', seconds);
    return seconds;
}

export function lmInstanceToUnload(catalog, model) {
    const row = catalog.models?.find(m => m.key === model ||
        m.loaded_instances?.some(instance => instance.id === model));
    if (!row)
        return null; // Already unloaded or no longer present.
    const exact = row.loaded_instances.find(instance => instance.id === model);
    if (exact)
        return exact.id;
    if (row.loaded_instances.length === 1)
        return row.loaded_instances[0].id;
    if (row.loaded_instances.length > 1)
        throw new Error('同一模型有多个已加载实例，无法安全确定本插件使用的实例，未执行卸载。');
    return null;
}

export function clampPopupPosition(x, y, width, height, monitor) {
    const margin = 8;
    const minX = monitor.x + margin;
    const minY = monitor.y + margin;
    return {
        x: Math.round(Math.min(Math.max(x, minX), Math.max(minX, monitor.x + monitor.width - width - margin))),
        y: Math.round(Math.min(Math.max(y, minY), Math.max(minY, monitor.y + monitor.height - height - margin))),
    };
}

// Stage-relative redraw damage for both old and new painted positions, including shadows.
export function popupDragDamage(from, to, width, height, padding = 48) {
    const x = Math.floor(Math.min(from.x, to.x) - padding);
    const y = Math.floor(Math.min(from.y, to.y) - padding);
    return {x, y,
        width: Math.ceil(Math.max(from.x, to.x) + width + padding) - x,
        height: Math.ceil(Math.max(from.y, to.y) + height + padding) - y};
}
