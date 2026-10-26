/**
 * 渠道运行时（Worker 侧）—— 账号渠道的实际宿主。
 *
 * ## 为什么用 Worker 线程
 *
 * 渠道包（`vendor/channels/business.mjs`）里有大量**模块级单例状态**
 * （凭据缓存、代理连接池、令牌账本、能力表）。如果多个实例共用一个进程，
 * 它们会互相串号 —— A 实例的账号缓存被 B 实例的请求读到。
 *
 * 上游用「一实例一 Worker」解决，这里沿用。
 *
 * ## 与上游的差异
 *
 * 1. **opencode 通道硬性移除**。那个通道的工作方式是**冒充官方 opencode 客户端**：
 *    派生 `git-remote:opencode/<sha1>` 形态的 project id、按官方时间铸造算法生成
 *    长度精确的 session id、伪装官方 UA —— 上游会校验这些形状，不对就是 403。
 *    它服务的不是「一个 API」，而是「让上游以为你是 opencode CLI」，故下线。
 *    `apply(ctx, { disableOpencode: true })` 让适配器不注册它，
 *    同时 RPC 层会拒绝 `opencode.*` 方法与 `account.create(provider=opencode)`。
 *
 * 2. **只依赖本地 vendor**，不 import 任何 `@deepseek-ai/*`。
 *    宿主能力（`llm` 注册表、凭据、附件）由这里用普通对象搭出来。
 */

import { parentPort, workerData } from 'node:worker_threads'
import { accountCredentialStatus } from './account-status.mjs'

import { createCredentials } from '../../vendor/channels/credentials.mjs'
import { attachments } from '../../vendor/channels/images.mjs'
import { toChatMessages, toToolDefs } from '../../vendor/channels/messages.js'
import {
  apply,
  collectGatewayEffortViews,
  collectGatewayModels,
  markGatewayChannel,
  normalizeReasoningEffort,
  responsesMaxOutputTokens,
  responsesReasoningEffort,
  toGenerateOptions,
  toOpenAiModels,
  toResponsesGenerateOptions,
} from '../../vendor/channels/business.mjs'

const cleanups = []
const adapters = new Map()
const routes = new Map()
const controllers = new Map()
let closed = false

const send = message => parentPort.postMessage(message)
const logger = Object.fromEntries(
  ['info', 'warn', 'error'].map(level => [level, message => send({ type: 'log', level, message: String(message) })]),
)
const credentials = createCredentials(workerData.dataDir, {
  onChange: () => { if (!closed) send({ type: 'changed' }) },
})

/**
 * 迷你宿主上下文。
 *
 * 只实现渠道包真正用到的那几个能力：`platform`（数据目录）、`credentials`、
 * `logger`、`attachments`、一个只注册路由的 `connection.fetch`，
 * 以及 `llm`（适配器注册表）。
 */
const ctx = {
  platform: { channelHome: workerData.dataDir },
  credentials,
  logger,
  attachments,
  connection: { fetch: { register(route) { routes.set(route.path, route) } } },
  get(name) { return this[name] },
  provide(name, value) {
    if (Object.hasOwn(this, name)) throw new Error(`服务重复注册：${name}`)
    this[name] = value
  },
  effect(body) {
    const cleanup = body()
    if (typeof cleanup === 'function') {
      if (closed) void cleanup()
      else cleanups.push(cleanup)
    }
    return cleanup
  },
  inject(names, body) { if (names.every(name => this[name] !== undefined)) return body(this) },
  emit() { send({ type: 'changed' }) },
  llm: {
    registerAdapter(providers, adapter) {
      for (const provider of providers) {
        if (adapters.has(provider)) throw new Error(`渠道重复注册：${provider}`)
        adapters.set(provider, adapter)
      }
    },
    listProviders() { return [...adapters.keys()].map(id => ({ id })) },
    async listModels(provider) { return (await adapters.get(provider)?.listModels(provider)) ?? [] },
    async resolveModel(provider, model, signal) {
      const adapter = adapters.get(provider)
      if (!adapter) throw Object.assign(new Error('渠道不存在'), { statusCode: 404 })
      return adapter.resolveModel(provider, model, signal)
    },
    async resolveModelInfo(provider, model, signal) { return this.resolveModel(provider, model, signal) },
    async *stream(options) {
      const adapter = adapters.get(options.provider)
      if (!adapter) throw Object.assign(new Error('渠道不存在'), { statusCode: 404 })
      const call = await adapter.prepareCall(options.provider, options.model, options.signal)
      yield* call.stream(options)
    },
  },
}

/** 采集模型目录，转成 OpenAI `/v1/models` 的行。 */
async function models() {
  const onError = (provider, error) => logger.warn(`${provider} 模型目录读取失败：${error.message}`)
  const groups = (await Promise.all([...adapters.keys()].map(provider => collectGatewayModels({
    listProviders: () => [{ id: provider }],
    listModels: id => ctx.llm.listModels(id),
  }, onError)))).flat()

  const infos = new Map()
  const views = await collectGatewayEffortViews({
    async resolveModelInfo(provider, model) {
      const info = await ctx.llm.resolveModel(provider, model)
      infos.set(`${provider}/${model}`, info)
      return info
    },
  }, groups, onError)

  return toOpenAiModels(groups, views).map(row => ({
    ...row,
    channel: row.owned_by,
    vision: row.input?.includes('image') === true,
    context_window: row.context_window ?? infos.get(row.id)?.context?.contextWindow,
    max_tokens: row.max_tokens ?? infos.get(row.id)?.defaultMaxTokens,
  }))
}

/** 管理 RPC（账号增删、排序、启停、备份…）。 */
async function rpc(call, signal) {
  const route = routes.get('/api/channel-pack')
  if (!route) throw new Error('渠道管理接口未注册')
  const response = await route.fetch(new Request('http://localhost/api/channel-pack', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({ type: 'client-request', rpcId: 'app', method: 'channel-pack', payload: call }),
  }))
  const reply = await response.json()
  const result = reply.result
  if (result?.ok && call.method === 'account.list') {
    result.value.accounts = await Promise.all((result.value?.accounts ?? []).map(async entry => ({
      ...entry,
      ...await accountCredentialStatus(credentials, entry),
    })))
  }
  if (result?.ok && ['account.create', 'account.delete', 'account.update', 'account.refresh', 'account.reorder'].includes(call.method)) {
    send({ type: 'changed' })
  }
  return result
}

/**
 * 把 harness/Anthropic 形态的请求摊平成 OpenAI body。
 *
 * `/v1/messages` 交来的是 harness messages + 扁平 tools，不是一个 `openAi` body；
 * 不做这一步，适配器会因为「没有 messages」而拒绝这一轮，并且静默丢掉
 * tools、max_tokens 与 temperature。
 */
function harnessBody(request) {
  const body = { messages: toChatMessages(Array.isArray(request.messages) ? request.messages : []) }
  if (Array.isArray(request.tools) && request.tools.length > 0) body.tools = toToolDefs(request.tools)
  if (typeof request.maxTokens === 'number') body.max_tokens = request.maxTokens
  if (typeof request.temperature === 'number') body.temperature = request.temperature
  if (typeof request.reasoningEffort === 'string' && request.reasoningEffort !== '') {
    body.reasoning_effort = request.reasoningEffort
  }
  return body
}

/** 跑一轮补全，把 chunk 流回主线程。 */
async function complete(request, id, signal) {
  const slash = request.model.indexOf('/')
  const provider = request.model.slice(0, slash)
  const model = request.model.slice(slash + 1)

  // 停用模型与供应商必须同时影响统一 API，不能只把页面藏起来。
  if (!(await ctx.llm.listModels(provider)).some(row => row.id === model)) {
    throw Object.assign(new Error('模型不存在或已停用'), { statusCode: 404 })
  }

  const body = { ...(request.responsesBody ?? request.openAi ?? harnessBody(request)), model: request.model }
  const resolved = await ctx.llm.resolveModel(provider, model, signal)

  const effort = normalizeReasoningEffort(
    request.responses ? responsesReasoningEffort(body) : body.reasoning_effort,
    resolved,
    provider,
    model,
    notice => logger.info(`${request.model}：思考档位 ${notice.requested} ${notice.applied ? `映射为 ${notice.applied}` : '使用模型默认'}`),
  )
  const requested = request.responses
    ? responsesMaxOutputTokens(body)
    : body.max_completion_tokens ?? body.max_tokens
  // 保留客户端的输出预算；不按历史模型名静默压成 64K。
  // 真正超出上游能力时让其明确报错，而不是替用户减少上下文/输出。
  const maxTokens = typeof requested === 'number' ? requested : undefined

  const convert = request.responses ? toResponsesGenerateOptions : toGenerateOptions
  const options = await convert(
    body,
    signal,
    effort,
    maxTokens,
    { bridge: attachments },
    dropped => logger.warn(`忽略无法表达的工具类型：${dropped.type}`),
  )
  options.sessionId = `app:${String(body.user ?? body.conversation ?? 'shared')}`

  for await (const chunk of ctx.llm.stream(markGatewayChannel(options))) {
    if (signal.aborted) throw new Error('请求已取消')
    send({ type: 'chunk', id, chunk })
  }
}

parentPort.on('message', async message => {
  if (message.type === 'cancel') { controllers.get(message.id)?.abort(); return }
  if (message.type === 'close') {
    closed = true
    for (const controller of controllers.values()) controller.abort()
    credentials.dispose()
    for (const cleanup of cleanups.reverse()) { try { await cleanup } catch { /* 清理失败不应阻止关闭 */ } }
    send({ type: 'closed' })
    return
  }

  const { id, type } = message
  const controller = new AbortController()
  controllers.set(id, controller)
  try {
    if (closed) throw new Error('渠道已停止')
    if (type === 'models') send({ type: 'result', id, value: await models() })
    else if (type === 'rpc') send({ type: 'result', id, value: await rpc(message.call, controller.signal) })
    else if (type === 'complete') { await complete(message.request, id, controller.signal); send({ type: 'result', id }) }
    else throw new Error('未知渠道操作')
  } catch (error) {
    send({ type: 'error', id, message: error.message, statusCode: error.statusCode ?? error.status })
  } finally {
    controllers.delete(id)
  }
})

// ⚠️ `disableOpencode: true` —— opencode 通道不注册（详见文件头）。
apply(ctx, { disableOpencode: true })
send({ type: 'ready', providers: [...adapters.keys()] })
