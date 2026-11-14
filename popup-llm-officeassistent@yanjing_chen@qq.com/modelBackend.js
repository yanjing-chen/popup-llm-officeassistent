import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {endpointUrls, isOllamaCatalog, isLMStudioCatalog, isLegacyLMStudioCatalog,
    parseModelList, lmInstanceToUnload, isRuntimePreferences} from './backendUtils.js';

// One connection only. Requests never follow redirects with the user's API token.
export class ModelBackend {
    constructor(endpoint, apiKey) {
        this.urls = endpointUrls(endpoint);
        this._apiKey = apiKey;
        this._session = new Soup.Session({timeout: 8});
        this._disposed = false;
        this._discovery = null;
    }

    dispose() {
        this._disposed = true;
        this._session.abort();
        this._apiKey = '';
    }

    async request(url, body = null) {
        if (this._disposed)
            throw new Error('连接已关闭');
        const message = Soup.Message.new(body === null ? 'GET' : 'POST', url);
        if (!message)
            throw new Error('接口地址无效');
        message.set_flags(message.get_flags() | Soup.MessageFlags.NO_REDIRECT);
        if (this._apiKey)
            message.request_headers.append('Authorization', `Bearer ${this._apiKey}`);
        if (body !== null) {
            message.set_request_body_from_bytes('application/json',
                new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body))));
        }
        return new Promise((resolve, reject) => {
            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    if (this._disposed)
                        throw new Error('连接已关闭');
                    if (message.status_code < 200 || message.status_code >= 300)
                        throw new Error(`HTTP ${message.status_code}`);
                    const text = new TextDecoder().decode(bytes.get_data());
                    resolve(text.trim() ? JSON.parse(text) : {});
                } catch (error) {
                    // Do not expose URLs, tokens, or response bodies through errors.
                    reject(new Error(/^HTTP \d+$/.test(error.message) ? error.message : '接口无响应、返回格式错误或连接已取消'));
                }
            });
        });
    }

    async discover() {
        if (!this._discovery)
            this._discovery = this._discover().catch(error => { this._discovery = null; throw error; });
        return this._discovery;
    }

    async _discover() {
        const optional = url => this.request(url).catch(() => null);
        const [standard, ollama, lm, runtime] = await Promise.all([
            optional(this.urls.models), optional(this.urls.ollamaTags), optional(this.urls.lmModels),
            optional(this.urls.runtimePreferences),
        ]);
        let kind = 'generic';
        let catalog = standard;
        let memoryStatus = '通用 OpenAI 兼容接口：未检测到受支持的显存卸载协议，定时释放不可用。';
        if (isRuntimePreferences(runtime)) {
            kind = 'runtime';
            memoryStatus = `已识别 Local AI Runtime 1.0 空闲策略接口：服务当前为 ${runtime.idle_unload_seconds} 秒（服务值 0 表示不自动释放）。正数设置需点击右侧按钮并确认应用，影响所有客户端；本插件的 0 秒立即释放不适用此后端。`;
        } else if (isOllamaCatalog(ollama)) {
            kind = 'ollama';
            catalog = ollama;
            memoryStatus = '已识别 Ollama：支持按本插件的空闲计时卸载模型。';
        } else if (isLMStudioCatalog(lm)) {
            kind = 'lmstudio';
            catalog = standard || lm;
            memoryStatus = '已识别 LM Studio：支持空闲卸载及 JIT 模型 TTL。';
        } else {
            const legacy = await optional(this.urls.lmLegacyModels);
            if (isLegacyLMStudioCatalog(legacy)) {
                kind = 'lmstudio-legacy';
                catalog = standard || legacy;
                memoryStatus = '已识别旧版 LM Studio：空闲时间通过 TTL 交给后端，仅适用于 JIT 自动加载模型；立即释放需新版卸载 API。';
            }
        }
        if (!catalog)
            throw new Error('无法获取模型列表，请检查后端是否启动、接口链接及 API 密钥。');
        return {kind, models: parseModelList(catalog), memoryStatus,
            runtimeIdleSeconds: kind === 'runtime' ? runtime.idle_unload_seconds : null};
    }

    async configureRuntimeIdle(seconds) {
        if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 86400)
            throw new Error('Runtime 共享空闲策略只接受 1–86400 秒；不把本插件的 0 秒误写为服务的“从不卸载”。');
        const info = await this.discover();
        if (info.kind !== 'runtime')
            throw new Error('未确认 Local AI Runtime 空闲策略接口。');
        const result = await this.request(this.urls.runtimePreferences, {idle_unload_seconds: seconds});
        if (result.idle_unload_seconds !== seconds)
            throw new Error('后端未确认新的空闲时间，请刷新检查。');
        this._discovery = null;
    }

    async unload(model) {
        const {kind} = await this.discover();
        if (kind === 'ollama') {
            await this.request(this.urls.ollamaUnload, {model, keep_alive: 0, stream: false});
        } else if (kind === 'lmstudio') {
            const catalog = await this.request(this.urls.lmModels);
            const instance = lmInstanceToUnload(catalog, model);
            if (instance)
                await this.request(this.urls.lmUnload, {instance_id: instance});
        } else if (kind === 'lmstudio-legacy') {
            throw new Error('旧版 LM Studio 不提供此卸载接口，请启用后端 JIT 和 TTL，或升级 LM Studio。');
        } else {
            throw new Error('当前后端没有受支持的模型卸载接口。');
        }
    }
}
