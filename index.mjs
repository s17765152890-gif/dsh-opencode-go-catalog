/**
 * dsh-opencode-go-catalog — keep the single OpenCode Go route current.
 *
 * OpenCode Go rotates models: new ones appear, retired ones drop out (their
 * docs say "The list of models may change as we test and add new ones"). The
 * pi-ai route serves exactly what configuration lists, but it resolves each
 * model's wire protocol from its *installed* catalog, and a model pi-ai has
 * never heard of has none.
 *
 * OpenCode Console translates every text model across its APIs, so this plugin
 * pins one protocol on the route — `openai-completions` at the OpenAI-compatible
 * base URL — which both keeps the menu a single group and lets brand-new model
 * ids join immediately. Every live catalog model is merged into that one route;
 * retired ids are pruned; metadata (name, context window, output cap, input
 * modalities) is refreshed.
 *
 * Writes go through `configEditor.edit`, the sanctioned path that persists the
 * profile patch and hot-reloads the Loader — no restart and no manual adoption.
 * The same plugin exposes `GET /x-opencode-go-catalog?refresh=1`, which the
 * model menu's one-click update button calls.
 */

const DEFAULTS = {
  /** Loader row that owns the pi-ai provider table. */
  entryId: 'llm-pi-ai',
  /** Fallback match when the row id drifted. */
  entryName: '@deepseek-ai/dsh-llm-pi-ai',
  /** The single provider route this plugin keeps current. */
  provider: 'opencode-go',
  /** Protocol pinned on the route; Console translates every text model. */
  api: 'openai-completions',
  /** OpenAI-compatible base URL behind that protocol. */
  baseURL: 'https://opencode.ai/inference/go/openai/v1',
  /** Public catalog endpoint. */
  catalogUrl: 'https://opencode.ai/inference/go/v1/models',
  /** Periodic refresh; 0 disables the timer (manual refresh still works). */
  intervalMinutes: 180,
  /** Delay before the first automatic sync. */
  startupDelaySeconds: 15,
  /** Drop models the catalog no longer lists. */
  prune: true,
  /** Model ids that are never pruned. */
  keep: [],
  /** Below this catalog size the answer is treated as truncated and ignored. */
  minimumCatalog: 5,
  /** Routes created by the previous split design; removed on migration. */
  obsoleteRoutes: ['opencode-go-latest'],
};

/** Only the LLM service is required; configEditor is looked up optionally. */
export const inject = ['llm'];

export async function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...config };
  const keep = new Set(Array.isArray(settings.keep) ? settings.keep : []);
  const state = { running: false, last: null, lastWrite: null };

  /** Read the public catalog, refusing shapes that would wipe the list. */
  async function readCatalog() {
    const response = await fetch(settings.catalogUrl, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-opencode-go-catalog/0.3' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`catalog HTTP ${response.status}`);
    const body = await response.json();
    const list = Array.isArray(body) ? body
      : Array.isArray(body?.data) ? body.data
        : Array.isArray(body?.models) ? body.models
          : null;
    if (list === null) throw new Error('catalog shape is not a model list');
    const models = list.filter(model => typeof model?.id === 'string' && model.id.length > 0);
    if (models.length < Math.max(1, settings.minimumCatalog)) {
      throw new Error(`catalog looks truncated (${models.length} models)`);
    }
    return models;
  }

  /** Project catalog metadata onto a row entry, keeping operator-tuned fields. */
  function project(model, previous) {
    const entry = { ...(previous ?? {}) };
    entry.id = model.id;
    if (typeof model.name === 'string' && model.name !== '') entry.name = model.name;
    else if (typeof entry.name !== 'string' || entry.name === '') entry.name = model.id;
    const context = Number(model?.limit?.context);
    if (Number.isFinite(context) && context > 0) entry.contextWindow = context;
    const output = Number(model?.limit?.output);
    if (Number.isFinite(output) && output > 0) entry.maxTokens = output;
    const inputs = Array.isArray(model?.modalities?.input) ? model.modalities.input : [];
    const hasImage = inputs.some(modality => typeof modality === 'string' && modality.toLowerCase().startsWith('image/'));
    if (previous === undefined) entry.input = hasImage ? ['text', 'image'] : ['text'];
    return entry;
  }

  /** Merge the catalog into the route's model list. */
  function planModels(catalog, existing) {
    const byId = new Map(catalog.map(model => [model.id, model]));
    const existingById = new Map();
    for (const model of existing) if (typeof model?.id === 'string') existingById.set(model.id, model);
    const next = [];
    const added = [];
    const removed = [];
    const refreshed = [];
    for (const model of existing) {
      if (typeof model?.id !== 'string') { next.push(model); continue; }
      const upstream = byId.get(model.id);
      if (upstream === undefined) {
        if (keep.has(model.id)) next.push(model); else removed.push(model.id);
        continue;
      }
      const projected = project(upstream, model);
      if (JSON.stringify(projected) !== JSON.stringify(model)) refreshed.push(model.id);
      next.push(projected);
    }
    for (const model of catalog) {
      if (existingById.has(model.id)) continue;
      next.push(project(model, undefined));
      added.push(model.id);
    }
    return { next, added, removed, refreshed };
  }

  /** Resolve the Loader row that owns the provider table. */
  function findEntry(configEditor) {
    const entries = configEditor.entries();
    return entries.find(entry => entry.options?.id === settings.entryId)
      ?? entries.find(entry => entry.options?.name === settings.entryName);
  }

  async function sync(trigger) {
    if (state.running) return state.last;
    state.running = true;
    const startedAt = Date.now();
    try {
      const configEditor = ctx.get('configEditor');
      if (configEditor === undefined) throw new Error('configEditor service is not mounted');
      const entry = findEntry(configEditor);
      if (entry === undefined) throw new Error(`Loader row "${settings.entryId}" is not addressable`);
      const current = structuredClone(entry.options.config ?? {});
      const providers = current.providers ?? {};
      const primary = providers[settings.provider];
      if (primary === null || typeof primary !== 'object') {
        throw new Error(`row "${settings.entryId}" has no provider "${settings.provider}"`);
      }

      const catalog = await readCatalog();
      const plan = planModels(catalog, Array.isArray(primary.models) ? primary.models : []);
      if (plan.next.length === 0) throw new Error('refusing to write an empty model list');

      const nextPrimary = {
        ...primary,
        api: settings.api,
        baseURL: settings.baseURL,
        models: plan.next,
      };
      const nextProviders = { ...providers, [settings.provider]: nextPrimary };
      const removedRoutes = [];
      for (const route of settings.obsoleteRoutes) {
        if (nextProviders[route] !== undefined) {
          delete nextProviders[route];
          removedRoutes.push(route);
        }
      }

      const changed = JSON.stringify(nextPrimary) !== JSON.stringify(primary)
        || removedRoutes.length > 0;
      if (changed) {
        await configEditor.edit(entry, now => {
          // Object spread only adds keys, so obsolete routes must be deleted
          // from the merged copy explicitly; otherwise the previous split route
          // survives every write and the sync is never idempotent.
          const providers = { ...now.providers, ...nextProviders };
          for (const route of settings.obsoleteRoutes) delete providers[route];
          return { ...now, providers };
        });
        state.lastWrite = { at: Date.now(), added: plan.added, removed: plan.removed, refreshed: plan.refreshed, removedRoutes };
        ctx.logger?.info?.(`opencode-go-catalog: wrote ${plan.next.length} models (+${plan.added.length} -${plan.removed.length} ~${plan.refreshed.length})`);
      }

      state.last = {
        ok: true,
        trigger,
        at: startedAt,
        durationMs: Date.now() - startedAt,
        catalog: catalog.length,
        total: plan.next.length,
        changed,
        added: plan.added,
        removed: plan.removed,
        refreshed: plan.refreshed,
        removedRoutes,
      };
    } catch (error) {
      state.last = {
        ok: false,
        trigger,
        at: startedAt,
        durationMs: Date.now() - startedAt,
        error: String(error?.message ?? error),
      };
      ctx.logger?.warn?.(`opencode-go-catalog: sync failed (${state.last.error})`);
    } finally {
      state.running = false;
    }
    return state.last;
  }

  ctx.effect(() => {
    const timer = setTimeout(() => { void sync('startup'); }, Math.max(0, Number(settings.startupDelaySeconds) || 0) * 1000);
    return () => clearTimeout(timer);
  }, 'opencode-go-catalog: startup sync');

  const intervalMs = Math.max(0, Number(settings.intervalMinutes) || 0) * 60_000;
  if (intervalMs > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => { void sync('interval'); }, intervalMs);
      return () => clearInterval(timer);
    }, 'opencode-go-catalog: interval sync');
  }

  const webServer = ctx.get('webServer');
  const connection = ctx.get('connection');
  if (webServer !== undefined && connection !== undefined) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/x-opencode-go-catalog',
      handler: async (req, res) => {
        const send = (status, value) => {
          const body = Buffer.from(JSON.stringify(value), 'utf8');
          res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': String(body.byteLength),
            'cache-control': 'no-store',
          });
          res.end(body);
        };
        const rejection = connection.requestRejection(req);
        if (rejection !== undefined) { res.writeHead(rejection); res.end(); return }
        if (req.method !== 'GET') { send(405, { ok: false, error: 'GET only' }); return }
        const url = new URL(req.url ?? '/x-opencode-go-catalog', 'http://localhost');
        if (url.searchParams.has('refresh')) {
          send(200, { ok: true, sync: await sync('manual'), settings: publicSettings() });
          return;
        }
        send(200, { ok: true, last: state.last, lastWrite: state.lastWrite, settings: publicSettings() });
      },
    }), 'opencode-go-catalog: sync status route');
  }

  function publicSettings() {
    return {
      entryId: settings.entryId,
      provider: settings.provider,
      api: settings.api,
      baseURL: settings.baseURL,
      catalogUrl: settings.catalogUrl,
      intervalMinutes: settings.intervalMinutes,
      prune: settings.prune,
      keep: [...keep],
      minimumCatalog: settings.minimumCatalog,
    };
  }
}

