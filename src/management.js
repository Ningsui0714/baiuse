/**
 * 管理 API —— 给 app 自带的 Web 界面用。
 *
 * ## 为什么要有这一层
 *
 * 账号管理（13 家渠道登录、启停、排序）、模型浏览、设置编辑，
 * 都需要一个入口。GUI 壳（Electron）里就是一个网页，
 * 它通过这些接口操作 app。
 *
 * ## 鉴权
 *
 * 管理接口**只监听回环地址**，且要求 Bearer Key —— 与推理接口同一个 key。
 * 但它比推理接口更敏感（能读账号列表、改设置），所以额外要求
 * 请求来自回环地址：即使 key 泄露，局域网里的机器也用不了。
 *
 * ## 路由
 *
 * | 方法 | 路径 | 说明 |
 * |---|---|---|
 * | GET  | `/api/summary` | 总览：车道、账号数、模型数 |
 * | GET  | `/api/accounts` | 账号列表 |
 * | POST | `/api/accounts` | 新增账号（触发登录流程，返回登录链接） |
 * | POST | `/api/accounts/:id` | 改账号（启停、改名） |
 * | DELETE | `/api/accounts/:id` | 删账号 |
 * | POST | `/api/accounts/:id/refresh` | 刷新凭据 |
 * | GET  | `/api/models` | 模型目录 |
 * | GET  | `/api/settings` | 读设置 |
 * | POST | `/api/settings` | 改设置 |
 * | GET  | `/api/aggregate` | 聚合车道：provider 目录 + 已配置状态 |
 * | POST | `/api/aggregate` | 切换聚合车道总开关 |
 * | PUT  | `/api/aggregate/providers/:id` | 保存某 provider 的 Key / baseURL / 模型 |
 * | DELETE | `/api/aggregate/providers/:id` | 移除某 provider |
 * | POST | `/api/aggregate/providers/:id/test` | 用模型清单验一次 Key |
 * | POST | `/api/aggregate/providers/:id/discover` | 拉该 provider 的模型清单 |
 * | GET  | `/api/recipe` | 生成 Codex 接入配方 |
 */

import { connect as codexConnect, disconnect as codexDisconnect, getStatus as codexStatus, preview as codexPreview, PROVIDER_ID as CODEX_PROVIDER_ID } from './codex/config.mjs'
import { captureCurrentAuth, clearApiKeyAuth, listAccounts as listCodexAccounts, pollDeviceLogin, refreshAccount as refreshCodexAccount, removeAccount as removeCodexAccount, startDeviceLogin, switchAccount } from './codex/accounts.mjs'
import { activateProfile, listProfiles, purgeProviderConfig, removeProfile, restoreConfig, saveProfile } from './codex/profiles.mjs'
import { listProviderCounts, migrateThreads } from './codex/state-db.mjs'
import { fetchProviderModels, testProvider } from '../vendor/lanes/aggregate.js'
import { getProvider, listProviders } from '../vendor/providers/index.js'
import { listClients, clientPreview, connectClient, restoreClient } from './clients/config.mjs'
import { requestedIdentity } from './models.js'

/** 管理接口只接受回环来源。 */
function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * 创建管理 HTTP 处理器。
 *
 * @param {object} options
 * @param {object} options.app    应用句柄（`src/app.js`）
 * @param {string} options.apiKey 鉴权用的 key
 * @returns {(req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>}
 *          返回 true 表示「已处理」
 */
export function createManagementHandler({ app, apiKey }) {
  // `app` 可能是 getter —— 网关先于 app 句柄建好（app 句柄要拿网关），
  // 所以这里**每次用时才取**，不能在创建时解构成局部常量。
  const getApp = typeof app === 'function' ? app : () => app
  const clientModels = () => getApp().lanes.clientModelRows?.() ?? getApp().lanes.modelRows()

  /**
   * 调渠道包 RPC 并**拆掉它的信封**。
   *
   * ⚠️ 渠道包的 RPC 统一返回 `{ok, value}` 或 `{ok:false, error}`，
   * 而 `app.channels.rpc()` 只把这一层原样带回来。直接读 `result.accounts`
   * 会永远拿到 undefined —— 表现就是「账号明明存在，列表却是空的」。
   *
   * 这里做两件事：
   *  1. `ok:false` → 抛异常（否则调用方会把失败当成功）
   *  2. 成功 → 返回 `value`，让调用方拿到真正的数据
   */
  async function callRpc(method, payload) {
    const result = await getApp().channels.rpc({ method, payload })
    if (result !== null && typeof result === 'object' && result.ok === false) {
      const error = new Error(result.error?.message ?? `渠道操作失败：${method}`)
      error.status = 400
      throw error
    }
    // 兼容：有些调用方拿到的已经是拆过的值
    return result !== null && typeof result === 'object' && 'value' in result ? result.value : result
  }

  /** 读账号列表（走渠道包 RPC）。 */
  async function listAccounts() {
    const app = getApp()
    const accounts = []
    for (const provider of app.channels.providers) {
      try {
        const value = await callRpc('account.list', { provider })
        for (const entry of value?.accounts ?? []) {
          accounts.push({
            id: entry.id,
            provider: entry.provider,
            nickname: entry.nickname ?? entry.id,
            enabled: entry.enabled !== false,
            refreshable: entry.refreshable === true,
            authenticated: entry.authenticated === true,
            credentialState: entry.credentialState ?? 'unknown',
            expiresAt: entry.expiresAt ?? null,
            // 限流信息：模型 → 解禁时刻
            rateLimited: Object.entries(entry.modelRateLimits ?? {})
              .map(([model, resetAt]) => ({ model, resetAt }))
              .filter(row => row.resetAt > Date.now()),
          })
        }
      } catch {
        // 某个 provider 读失败不影响其它
      }
    }
    return accounts
  }

  /** 设置的聚合车道段（结构：`{enabled, providers:{id:{...}}}`）。 */
  function aggregateSection() {
    const value = getApp().settings.get().aggregate
    if (value === null || typeof value !== 'object') return { providers: {} }
    return {
      ...value,
      providers: value.providers !== null && typeof value.providers === 'object' ? value.providers : {},
    }
  }

  /**
   * 写回聚合车道段。
   *
   * ⚠️ 只走这个专用入口 —— 通用的 `POST /api/settings` 会**忽略** aggregate 字段。
   * 否则前端把掩码后的 `••••••••` 回传，就会把真实 Key 覆盖成圆点。
   */
  function writeAggregate(next) {
    getApp().settings.update({ aggregate: next })
    return next
  }

  /** 把一个 provider 的配置掩码后返回（Key 只给「配了没」的提示）。 */
  function redactProviderSetting(setting) {
    if (setting === null || typeof setting !== 'object') return null
    return {
      enabled: setting.enabled === true,
      hasKey: typeof setting.apiKey === 'string' && setting.apiKey !== '',
      keyHint: typeof setting.apiKey === 'string' && setting.apiKey !== ''
        ? `${setting.apiKey.slice(0, 4)}…${setting.apiKey.slice(-4)}`
        : '',
      baseUrl: typeof setting.baseUrl === 'string' ? setting.baseUrl : '',
      models: Array.isArray(setting.models) ? setting.models : [],
      discovered: Array.isArray(setting.discovered) ? setting.discovered : [],
    }
  }

  /**
   * 设置里去掉敏感字段。
   *
   * ⚠️ `aggregate` 的结构是 `{enabled, providers}`，**不是** `{providerId: {...}}`。
   * 早先按后者遍历，等于对 `enabled: true` 做 `{...true}`，产出 `{}` ——
   * 掩码没生效，还丢掉了开关状态。
   */
  function redactSettings(settings) {
    const { aggregate, ...rest } = settings ?? {}
    const section = aggregate !== null && typeof aggregate === 'object' ? aggregate : {}
    const providers = section.providers !== null && typeof section.providers === 'object' ? section.providers : {}

    return {
      ...rest,
      aggregate: {
        enabled: section.enabled !== false,
        providers: Object.fromEntries(
          Object.entries(providers).map(([id, setting]) => [id, redactProviderSetting(setting)]),
        ),
      },
    }
  }



  /** 自定义 provider 的 id 规则：模型 id 会拼成 `<id>/<model>`，所以必须干净。 */
  function normalizeCustomId(raw) {
    const id = String(raw ?? '').trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(id)) {
      throw Object.assign(new Error('厂商 ID 只能用小写字母、数字、- 和 _，长度 2~32'), { status: 400 })
    }
    return id
  }

  /**
   * 保存一个自定义厂商。
   *
   * 定义（name / baseUrl / format / models）与凭据（apiKey）分开存：
   * 前者在 `customProviders`，后者在 `providers` —— 这样清空 Key 不会连着把
   * 厂商定义也删了。
   */
  function saveCustomProvider(body) {
    const section = aggregateSection()
    const customProviders = { ...(section.customProviders ?? {}) }

    // 编辑已有厂商时允许不传 id（用 originalId 定位）
    const id = normalizeCustomId(body.id ?? body.originalId)
    if (body.originalId !== undefined && String(body.originalId) !== id) {
      delete customProviders[String(body.originalId)]
    }

    const baseUrl = String(body.baseUrl ?? '').trim()
    if (baseUrl === '') throw Object.assign(new Error('Base URL 必填'), { status: 400 })

    const format = String(body.format ?? 'openai-chat')
    if (!['openai-chat', 'openai-responses', 'anthropic-messages'].includes(format)) {
      throw Object.assign(new Error('协议只能是 openai-chat / openai-responses / anthropic-messages'), { status: 400 })
    }

    const models = [...new Set((Array.isArray(body.models) ? body.models : [])
      .map(value => String(value).trim())
      .filter(Boolean))]
    if (models.length === 0) throw Object.assign(new Error('至少要填一个模型 ID'), { status: 400 })

    customProviders[id] = {
      name: String(body.name ?? '').trim() || id,
      baseUrl,
      format,
      models,
    }

    const providers = { ...section.providers }
    const existing = providers[id] ?? {}
    const next = { ...existing, enabled: true }
    if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') next.apiKey = body.apiKey.trim()
    providers[id] = next

    writeAggregate({ ...section, customProviders, providers })
  }

  /** 删除自定义厂商（定义 + 凭据一起删）。 */
  function removeCustomProvider(id) {
    const section = aggregateSection()
    const customProviders = { ...(section.customProviders ?? {}) }
    const providers = { ...section.providers }
    delete customProviders[id]
    delete providers[id]
    writeAggregate({ ...section, customProviders, providers })
  }

  /** 聚合车道的视图：目录 + 每个 provider 的配置状态。 */
  function buildAggregateView() {
    const section = aggregateSection()
    const custom = section.customProviders !== null && typeof section.customProviders === 'object'
      ? section.customProviders
      : {}

    const registry = listProviders().map(provider => ({
      id: provider.id,
      name: provider.name,
      category: provider.category ?? '',
      format: provider.format ?? '',
      authKind: provider.auth?.kind ?? 'none',
      // 只有 apiKey 类能在这条车道里配；oauth / adc 需要各自的登录流程
      configurable: provider.auth?.kind !== 'oauth' && provider.auth?.kind !== 'adc',
      baseUrl: provider.baseUrl ?? '',
      env: provider.auth?.env ?? '',
      website: provider.auth?.url ?? provider.website ?? '',
      models: (provider.models ?? []).map(model => model.id),
      setting: redactProviderSetting(section.providers[provider.id]),
    }))

    // 自定义厂商：定义本身也在 settings 里，所以它的「可用模型」优先看用户填的
    const customs = Object.entries(custom).map(([id, entry]) => ({
      id,
      name: String(entry?.name ?? id),
      category: 'custom',
      format: String(entry?.format ?? 'openai-chat'),
      authKind: 'apiKey',
      configurable: true,
      baseUrl: String(entry?.baseUrl ?? ''),
      env: '',
      website: '',
      models: Array.isArray(entry?.models) ? entry.models : [],
      custom: true,
      setting: redactProviderSetting(section.providers[id]),
    }))

    return {
      enabled: section.enabled !== false,
      providers: [...customs, ...registry],
      customCount: customs.length,
    }
  }

  /** 保存一个 provider 的配置。空字符串表示「清掉这个覆盖」。 */
  function saveAggregateProvider(provider, body) {
    const section = aggregateSection()
    const existing = section.providers[provider.id] ?? {}
    const next = { ...existing, enabled: body.enabled !== false }

    if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') {
      next.apiKey = body.apiKey.trim()
    }
    if (body.clearKey === true) delete next.apiKey

    if (typeof body.baseUrl === 'string') {
      const url = body.baseUrl.trim()
      if (url === '') delete next.baseUrl
      else next.baseUrl = url
    }

    if (Array.isArray(body.models)) {
      const models = [...new Set(body.models.map(value => String(value).trim()).filter(Boolean))]
      if (models.length > 0) next.models = models
      else delete next.models
    }

    writeAggregate({ ...section, providers: { ...section.providers, [provider.id]: next } })
  }

  /**
   * 造一份「用于探测」的配置。
   *
   * 允许把**还没保存**的 Key / baseURL 覆盖进去 —— 用户点「测试连接」时
   * 期望验的是输入框里那个值，而不是上次保存的旧值。
   */
  function configForProbe(provider, body) {
    const section = aggregateSection()
    const override = { ...(section.providers[provider.id] ?? {}), enabled: true }
    if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') override.apiKey = body.apiKey.trim()
    if (typeof body.baseUrl === 'string' && body.baseUrl.trim() !== '') override.baseUrl = body.baseUrl.trim()
    return { ...section, providers: { ...section.providers, [provider.id]: override } }
  }


  /** 默认写进 config.toml 的模型：取目录里的第一个。 */
  function defaultModel() {
    return getApp().lanes.modelRows()[0]?.id ?? ''
  }


  /** 供应商档案需要的那几个上下文值。 */
  function profileContext() {
    const app = getApp()
    return {
      settings: app.settings,
      gatewayUrl: `${app.url}/v1`,
      gatewayKey: app.apiKey,
      gatewayModel: defaultModel(),
    }
  }

  /** 档案列表（带 active 标记）。 */
  function profileList() {
    const app = getApp()
    return listProfiles({ ...profileContext(), dataDir: app.dataDir })
  }

  /** Codex 接管视图：配置状态 + 历史会话分布。 */
  function codexView() {
    const app = getApp()
    const status = codexStatus({ dataDir: app.dataDir })
    let threadCounts = []
    try { threadCounts = listProviderCounts(status.paths.stateDbPath) } catch { threadCounts = [] }
    let accounts = []
    try { accounts = listCodexAccounts({ dataDir: app.dataDir }) } catch { accounts = [] }
    let profiles = []
    try { profiles = profileList() } catch { profiles = [] }
    return { ...status, gatewayUrl: `${app.url}/v1`, threadCounts, accounts, profiles }
  }

  /** 生成 Codex 接入配方。 */
  function buildRecipe() {
    const app = getApp()
    return [
      '# 加进 ~/.codex/config.toml',
      'model_provider = "ofm"',
      '',
      '[model_providers.ofm]',
      'name = "BaiUse"',
      `base_url = "${app.url}/v1"`,
      'wire_api = "responses"',
      'env_key = "OFM_API_KEY"',
      '',
      '# 然后：',
      `export OFM_API_KEY="${app.apiKey}"`,
      '',
    ].join('\n')
  }

  /** 读 JSON 请求体。 */
  async function readJson(req) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8')
    if (text.trim() === '') return {}
    try {
      return JSON.parse(text)
    } catch {
      throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 })
    }
  }

  /** 路由分发。 */
  async function route(req, res, url, body) {
    const app = getApp()
    const path = url.pathname

    const clientContext = () => ({ ...app.clientOptions, dataDir: app.dataDir, gatewayUrl: app.url, apiKey: app.apiKey, desktopModel: app.settings.get().desktopModel, desktopActivity: app.gateway?.desktopStatus })
    const clientRecords = () => listClients(clientContext()).map(client => ({ ...client,
      logicalModel: client.model ? requestedIdentity(client.model, app.lanes.modelRows()) : '',
    }))
    if (path === '/api/clients' && req.method === 'GET') {
      sendJson(res, 200, { clients: clientRecords() })
      return true
    }
    const clientMatch = /^\/api\/clients\/([a-z-]+)\/(preview|connect|restore)$/.exec(path)
    if (clientMatch && req.method === 'POST') {
      const [, id, action] = clientMatch
      const options = { ...clientContext(), model: body?.model }
      if (action !== 'restore' && app.lanes.clientModelRows) options.model = requestedIdentity(String(options.model ?? ''), app.lanes.modelRows())
      if (action !== 'restore' && !clientModels().some(row => row.id === options.model)) {
        throw Object.assign(new Error('模型已不在可用目录中，请刷新后重新选择'), { status: 400 })
      }
      let result
      if (action === 'preview') result = clientPreview(id, options)
      else if (action === 'restore') result = restoreClient(id, options)
      else result = connectClient(id, options)
      if (id === 'claude-desktop' && action !== 'preview') {
        app.settings.update({ desktopModel: action === 'connect' ? options.model : '' })
      }
      // Secrets are opt-in for copying; normal screen previews are always masked.
      if (action === 'preview' && body?.reveal !== true) {
        result.files = result.files.map(file => ({ ...file, content: (app.apiKey ? file.content.replaceAll(app.apiKey, '••••••••') : file.content)
          .replace(/("[^"\n]*(?:key|token|secret|password)[^"\n]*"\s*:\s*)"[^"\n]*"/gi, '$1"••••••••"')
          .replace(/^(\s*(?:export\s+)?[\w.-]*(?:key|token|secret|password)[\w.-]*\s*=\s*)(?:"(?:\\.|[^"\n])*"|'[^'\n]*'|[^\s#]+)/gim, '$1"••••••••"') }))
      }
      sendJson(res, 200, { ...result, clients: clientRecords() })
      return true
    }

    // ── 总览 ──────────────────────────────────────────────────────────────
    if (path === '/api/summary' && req.method === 'GET') {
      sendJson(res, 200, {
        version: app.version ?? '0.1.0',
        dataDir: app.dataDir,
        url: app.url,
        lanes: {
          channels: app.channels.providers,
          kilo: app.lanes.kiloModels.length,
          aggregate: app.lanes.aggregateCatalog().length,
        },
        accounts: await listAccounts(),
        models: clientModels().length,
        routes: app.lanes.modelRows().length,
      })
      return true
    }

    // ── 账号 ──────────────────────────────────────────────────────────────
    if (path === '/api/account-actions' && req.method === 'GET') {
      sendJson(res,200,await app.accountActions.snapshot())
      return true
    }
    const actionsMatch = /^\/api\/account-actions\/(test|claim|balance|login-reward|auto)$/.exec(path)
    if (actionsMatch && req.method === 'POST') {
      const kind=actionsMatch[1]
      const value=kind==='auto'?await app.accountActions.setAuto(body?.enabled):await app.accountActions.start(kind,body??{})
      sendJson(res,kind==='auto'?200:202,value)
      return true
    }

    if (path === '/api/accounts' && req.method === 'GET') {
      sendJson(res, 200, { accounts: await listAccounts() })
      return true
    }

    if (path === '/api/accounts' && req.method === 'POST') {
      const { provider } = body ?? {}
      if (typeof provider !== 'string' || provider === '') {
        throw Object.assign(new Error('缺少 provider'), { status: 400 })
      }
      // `account.create` 启动登录流程，返回 `{accountId, loginUrl}`。
      const account = await callRpc('account.create', { provider })
      sendJson(res, 200, { account })
      return true
    }

    const accountMatch = /^\/api\/accounts\/([^/]+)(?:\/(\w+))?$/.exec(path)
    if (accountMatch !== null) {
      const [, accountId, action] = accountMatch

      if (req.method === 'DELETE' && action === undefined) {
        // ⚠️ 方法名是 `account.delete`，不是 `account.remove` ——
        // 写错会落到 default 分支报 unknown method，删除功能完全失效。
        await callRpc('account.delete', { accountId })
        sendJson(res, 200, { ok: true })
        return true
      }

      if (req.method === 'POST' && action === 'refresh') {
        await callRpc('account.refresh', { accountId })
        sendJson(res, 200, { ok: true })
        return true
      }

      if (req.method === 'POST' && action === undefined) {
        // ⚠️ `account.update` 要的是 `{accountId, patch}`。
        // 把字段平铺在顶层会读到 `req.patch === undefined`，
        // 于是 `{...entry, ...undefined}` 变成空操作 —— **不报错，但什么都没改**。
        const patch = { ...(body ?? {}) }
        await callRpc('account.update', { accountId, patch })
        sendJson(res, 200, { ok: true })
        return true
      }
    }

    // ── 模型 ──────────────────────────────────────────────────────────────
    if (path === '/api/models/refresh' && req.method === 'POST') {
      await app.channels.refresh()
      sendJson(res, 200, { models: clientModels() })
      return true
    }

    if (path === '/api/models' && req.method === 'GET') {
      sendJson(res, 200, { models: clientModels() })
      return true
    }

    // ── 聚合车道（自备 Key） ──────────────────────────────────────────────
    if (path === '/api/aggregate' && req.method === 'GET') {
      sendJson(res, 200, buildAggregateView())
      return true
    }

    if (path === '/api/aggregate' && req.method === 'POST') {
      const section = aggregateSection()
      writeAggregate({ ...section, enabled: body?.enabled !== false })
      sendJson(res, 200, buildAggregateView())
      return true
    }

    // 新增 / 更新自定义厂商（不在内置目录里的任意端点）
    if (path === '/api/aggregate/custom' && req.method === 'POST') {
      saveCustomProvider(body ?? {})
      sendJson(res, 200, buildAggregateView())
      return true
    }

    const customMatch = /^\/api\/aggregate\/custom\/([^/]+)$/.exec(path)
    if (customMatch !== null && req.method === 'DELETE') {
      removeCustomProvider(decodeURIComponent(customMatch[1]))
      sendJson(res, 200, buildAggregateView())
      return true
    }

    const aggregateMatch = /^\/api\/aggregate\/providers\/([^/]+)(?:\/(\w+))?$/.exec(path)
    if (aggregateMatch !== null) {
      const providerId = decodeURIComponent(aggregateMatch[1])
      const action = aggregateMatch[2]
      const provider = getProvider(providerId)
      if (provider === null) {
        throw Object.assign(new Error(`未知 provider：${providerId}`), { status: 404 })
      }

      // 保存
      if (req.method === 'PUT' && action === undefined) {
        saveAggregateProvider(provider, body ?? {})
        sendJson(res, 200, buildAggregateView())
        return true
      }

      // 移除
      if (req.method === 'DELETE' && action === undefined) {
        const section = aggregateSection()
        const providers = { ...section.providers }
        delete providers[provider.id]
        writeAggregate({ ...section, providers })
        sendJson(res, 200, buildAggregateView())
        return true
      }

      // 验 Key
      if (req.method === 'POST' && action === 'test') {
        const result = await testProvider(configForProbe(provider, body ?? {}), provider.id)
        sendJson(res, 200, { result })
        return true
      }

      // 拉模型清单，成功后写回 `discovered` 缓存
      if (req.method === 'POST' && action === 'discover') {
        const ids = await fetchProviderModels(configForProbe(provider, body ?? {}), provider.id)
        if (ids === null) {
          sendJson(res, 200, {
            ok: false,
            models: [],
            message: '这个 provider 没有可用的模型清单接口，请手动填写模型 ID',
          })
          return true
        }
        const section = aggregateSection()
        const existing = section.providers[provider.id] ?? { enabled: true }
        writeAggregate({
          ...section,
          providers: {
            ...section.providers,
            [provider.id]: { ...existing, enabled: true, discovered: ids },
          },
        })
        sendJson(res, 200, { ok: true, models: ids, message: `发现 ${ids.length} 个模型` })
        return true
      }
    }

    // ── 设置 ──────────────────────────────────────────────────────────────
    if (path === '/api/settings' && req.method === 'GET') {
      sendJson(res, 200, { settings: redactSettings(app.settings.get()) })
      return true
    }

    if (path === '/api/settings' && req.method === 'POST') {
      const patch = { ...(body ?? {}) }
      // ⚠️ API Key 不走这个接口改 —— 它是给 Codex 用的，改了客户端就连不上了。
      delete patch.apiKey
      // ⚠️ 聚合车道也不走这里：GET 返回的是掩码（`sk-1…abcd`），
      // 前端若把它连同其它设置一起回传，真实 Key 就被圆点覆盖了。
      // 它有自己的 PUT /api/aggregate/providers/:id。
      delete patch.aggregate
      const settings = app.settings.update(patch)
      sendJson(res, 200, { settings: redactSettings(settings) })
      return true
    }

    // ── Codex 接管 ────────────────────────────────────────────────────────
    if (path === '/api/codex' && req.method === 'GET') {
      sendJson(res, 200, codexView())
      return true
    }

    if (path === '/api/codex/preview' && req.method === 'GET') {
      sendJson(res, 200, codexPreview({
        dataDir: app.dataDir,
        baseUrl: `${app.url}/v1`,
        apiKey: app.apiKey,
        model: body?.model ?? defaultModel(),
      }))
      return true
    }

    if (path === '/api/codex/connect' && req.method === 'POST') {
      const result = codexConnect({
        dataDir: app.dataDir,
        baseUrl: `${app.url}/v1`,
        apiKey: app.apiKey,
        model: body?.model ?? defaultModel(),
      })
      sendJson(res, 200, { ...result, view: codexView() })
      return true
    }

    if (path === '/api/codex/disconnect' && req.method === 'POST') {
      const before = codexStatus({ dataDir: app.dataDir })
      const result = codexDisconnect({ dataDir: app.dataDir })

      // 撤销后不能让「接管期间新建的会话」指向一个已不存在的 provider。
      // 只迁 ofm → 原 provider，别的行一律不碰。
      const migration = migrateThreads(
        result.status.paths.stateDbPath,
        CODEX_PROVIDER_ID,
        before.previousProvider ?? 'openai',
      )

      sendJson(res, 200, { ...result, migration, view: codexView() })
      return true
    }

    if (path === '/api/codex/migrate' && req.method === 'POST') {
      const dbPath = codexStatus({ dataDir: app.dataDir }).paths.stateDbPath
      const to = String(body?.to ?? '')
      if (to === '') throw Object.assign(new Error('缺少 to'), { status: 400 })

      // 不传 from 就迁「所有不等于 to 的来源」——
      // 旧会话被钉在原先的 provider 上，用户切了供应商之后它们仍会去打老地址。
      const from = String(body?.from ?? '')
      const sources = from !== ''
        ? [from]
        : listProviderCounts(dbPath).map(row => row.provider).filter(provider => provider !== to)

      const results = sources.map(source => migrateThreads(dbPath, source, to))
      const updated = results.reduce((sum, row) => sum + row.updated, 0)
      const failed = results.find(row => row.ok !== true)

      sendJson(res, 200, {
        migration: {
          ok: failed === undefined,
          updated,
          message: failed !== undefined
            ? failed.message
            : (updated === 0 ? '没有需要迁移的会话' : `已迁移 ${updated} 个会话到 ${to}`),
        },
        view: codexView(),
      })
      return true
    }

    // ── Codex 供应商档案（卡片 + 切换） ───────────────────────────────────
    if (path === '/api/codex/profiles' && req.method === 'GET') {
      sendJson(res, 200, { profiles: profileList() })
      return true
    }

    if (path === '/api/codex/profiles' && req.method === 'POST') {
      const profiles = saveProfile({
        ...profileContext(),
        dataDir: app.dataDir,
        profile: body ?? {},
      })
      sendJson(res, 200, { profiles })
      return true
    }

    const profileMatch = /^\/api\/codex\/profiles\/([^/]+)(?:\/(\w+))?$/.exec(path)
    if (profileMatch !== null) {
      const profileId = decodeURIComponent(profileMatch[1])
      const action = profileMatch[2]

      if (req.method === 'DELETE' && action === undefined) {
        sendJson(res, 200, {
          profiles: removeProfile({ ...profileContext(), dataDir: app.dataDir, id: profileId }),
        })
        return true
      }

      if (req.method === 'POST' && action === 'activate') {
        const result = activateProfile({
          ...profileContext(),
          dataDir: app.dataDir,
          profileId,
        })
        sendJson(res, result.ok ? 200 : 400, { ...result, profiles: profileList() })
        return true
      }
    }

    if (path === '/api/codex/purge-providers' && req.method === 'POST') {
      const result = purgeProviderConfig({
        settings: app.settings,
        dataDir: app.dataDir,
      })
      sendJson(res, 200, { ...result, view: codexView() })
      return true
    }

    if (path === '/api/codex/restore' && req.method === 'POST') {
      const result = restoreConfig({ dataDir: app.dataDir })
      sendJson(res, 200, { ...result, profiles: profileList() })
      return true
    }

    // ── Codex 账号 ────────────────────────────────────────────────────────
    if (path === '/api/codex/accounts' && req.method === 'GET') {
      sendJson(res, 200, { accounts: listCodexAccounts({ dataDir: app.dataDir }) })
      return true
    }

    if (path === '/api/codex/auth/clear-api-key' && req.method === 'POST') {
      const result = clearApiKeyAuth({ dataDir: app.dataDir })
      sendJson(res, result.ok === false ? 400 : 200, { ...result, view: codexView() })
      return true
    }

    if (path === '/api/codex/accounts/capture' && req.method === 'POST') {
      const result = captureCurrentAuth({ dataDir: app.dataDir, label: String(body?.label ?? '') })
      sendJson(res, result.ok ? 200 : 400, result)
      return true
    }

    if (path === '/api/codex/accounts/login/start' && req.method === 'POST') {
      sendJson(res, 200, await startDeviceLogin())
      return true
    }

    if (path === '/api/codex/accounts/login/poll' && req.method === 'POST') {
      const deviceAuthId = String(body?.deviceAuthId ?? '')
      const userCode = String(body?.userCode ?? '')
      if (deviceAuthId === '' || userCode === '') {
        throw Object.assign(new Error('缺少 deviceAuthId / userCode'), { status: 400 })
      }
      sendJson(res, 200, await pollDeviceLogin({ deviceAuthId, userCode, dataDir: app.dataDir }))
      return true
    }

    const codexAccountMatch = /^\/api\/codex\/accounts\/([^/]+)(?:\/(\w+))?$/.exec(path)
    if (codexAccountMatch !== null) {
      const accountId = decodeURIComponent(codexAccountMatch[1])
      const action = codexAccountMatch[2]

      if (req.method === 'POST' && action === 'switch') {
        const result = switchAccount({ dataDir: app.dataDir, accountId })
        sendJson(res, result.ok ? 200 : 400, result)
        return true
      }

      if (req.method === 'POST' && action === 'refresh') {
        sendJson(res, 200, await refreshCodexAccount({ dataDir: app.dataDir, accountId }))
        return true
      }

      if (req.method === 'DELETE' && action === undefined) {
        const result = removeCodexAccount({ dataDir: app.dataDir, accountId })
        sendJson(res, result.ok ? 200 : 400, result)
        return true
      }
    }

    // ── Codex 配方 ────────────────────────────────────────────────────────
    if (path === '/api/recipe' && req.method === 'GET') {
      sendJson(res, 200, { recipe: buildRecipe() })
      return true
    }

    return false
  }

  return async function handleManagement(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    if (!url.pathname.startsWith('/api/')) return false

    // 回环限制：即使 key 泄露，局域网也用不了管理接口
    if (!isLoopbackRequest(req)) {
      sendJson(res, 403, { error: { message: '管理接口只接受本机访问', type: 'permission_error' } })
      return true
    }

    // 鉴权
    const header = req.headers.authorization ?? ''
    const match = /^Bearer\s+(.+)$/i.exec(header)
    if (apiKey !== '' && (match === null || match[1].trim() !== apiKey)) {
      sendJson(res, 401, { error: { message: '缺少或错误的 API Key', type: 'authentication_error' } })
      return true
    }

    try {
      const body = req.method === 'GET' ? undefined : await readJson(req)
      const handled = await route(req, res, url, body)
      if (!handled) {
        sendJson(res, 404, { error: { message: `未知的管理接口：${url.pathname}`, type: 'not_found' } })
      }
    } catch (error) {
      sendJson(res, error.status ?? 500, {
        error: { message: error.message, type: error.errorType ?? 'server_error' },
      })
    }
    return true
  }
}

/** 发 JSON 响应。 */
function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}
