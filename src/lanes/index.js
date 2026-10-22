/**
 * 统一车道层 —— 把三条来源不同的车道收敛成同一个调用接口。
 *
 * ## 有哪些车道
 *
 * | 车道 | 模型 id 形态 | 鉴权 | 备注 |
 * |---|---|---|---|
 * | **渠道包** | `provider/model` | 用户自己账号登录 | 12 家客户端的正规 API |
 * | **Kilo** | 裸名 | 免密 | 官方公开的免费池网关，无指纹闸门 |
 * | **聚合** | 裸名 | 用户自备 API Key | 各厂商自己的官方端点 |
 *
 * ## 为什么统一
 *
 * 网关对外只暴露一个 `/v1/responses`，但内部要走三种完全不同的调用形态：
 *
 * - 渠道包要发 `provider/model` 的 id，由 worker 里的适配器处理
 * - Kilo 走 `/api/gateway` 的 OpenAI 兼容端点
 * - 聚合走各 provider 自己的 base URL 与协议方言（chat / messages / responses）
 *
 * 三者最终都要吐出**同一种东西**：OpenAI 风格的流式 chunk。
 * 统一之后，路由层只需要面对「一个模型 → 一组候选车道」，
 * 不必知道每条车道背后是什么。
 *
 * ## 明确不在这里的
 *
 * - **免费聚合线**（opencode.ai 免密网关）：需伪装官方客户端指纹，已下线
 * - **EAC 共付车道**：依赖提取的 seal 凭据，已下线
 * - **opencode 渠道包通道**：同上，且在 `vendor/channels/business.mjs` 里硬性禁用
 *
 * ## 模型 id 的歧义
 *
 * Kilo 与聚合车道的模型 id 都是**裸名**（`kilo-auto/free`、`gpt-4o`），
 * 渠道包是 `provider/model`。裸名之间靠**目录**区分，不靠 id 形态：
 *
 * - 聚合目录来自用户的 provider 配置，条目带 `providerId`
 * - Kilo 目录来自它自己的 `/models` 清单
 *
 * 两者理论上可能撞名（用户自配了一个叫 `kilo-auto/free` 的 provider）。
 * 这时**聚合优先** —— 因为它带着具体的 provider 与 key，是用户明确配的；
 * Kilo 那个只是同名的免费条目。
 */

import { buildAggregateCatalog, isAggregateEntry, postAggregateStreamed } from '../../vendor/lanes/aggregate.js'
import { postKiloStreamed } from '../../vendor/lanes/kilo.js'
import { responsesToChat } from './responses-to-chat.js'
import { payloadToChunk } from './sse.js'

/** 车道标识。 */
export const LANE = Object.freeze({
  CHANNEL: 'channel',
  AGGREGATE: 'aggregate',
  KILO: 'kilo',
})

/**
 * 判断一个模型归哪条车道。
 *
 * ⚠️ **不能**简单按「第一个斜杠」切分 —— 渠道包的模型名本身可能含斜杠
 * （`cline/cline-free/mimo-v2.6-flash`）。要用**已注册的 provider 前缀**来认。
 *
 * @param {string} model
 * @param {readonly string[]} channelProviders 渠道包已注册的 provider 列表
 * @returns {string|null}
 */
export function laneOf(model, channelProviders) {
  const id = String(model ?? '')
  for (const provider of channelProviders) {
    if (id === provider || id.startsWith(`${provider}/`)) return LANE.CHANNEL
  }
  return null
}

/**
 * 创建车道运行时。
 *
 * @param {object} options
 * @param {object} options.channels  渠道包运行时（`src/channels/runtime.mjs`）
 * @param {object} options.settings  设置存储（读 `aggregate` 配置）
 * @param {object} [options.logger]
 */
export function createLanes({ channels, settings, logger = console }) {
  /** 聚合车道的目录：用户自备 Key 的 provider × 模型。 */
  function aggregateCatalog() {
    return buildAggregateCatalog(settings.get().aggregate ?? {})
  }

  /** Kilo 的模型清单。启动时刷新一次，之后按需更新。 */
  let kiloModels = new Set()

  /**
   * 全部车道的模型目录（OpenAI `/v1/models` 的行）。
   *
   * ⚠️ 按 id 去重，且**聚合车道覆盖渠道车道** —— 与 `resolve()` 的优先级一致。
   * `gemini` / `minimax` 在两个来源里都有条目；若不去重，同一个 id 会出现在
   * `/v1/models` 里两次，而客户端拿到的 `owned_by` 还可能是错的那个。
   */
  function modelRows() {
    const byId = new Map()

    // 渠道包先放（会被同 id 的聚合条目覆盖）
    for (const row of channels.publicModelRows()) byId.set(row.id, row)

    for (const entry of aggregateCatalog()) {
      byId.set(entry.id, {
        id: entry.id,
        object: 'model',
        created: 0,
        owned_by: entry.providerId ?? 'aggregate',
        ...(entry.contextWindow === undefined ? {} : { context_window: entry.contextWindow }),
        ...(entry.maxOutput === undefined ? {} : { max_tokens: entry.maxOutput }),
      })
    }

    for (const id of kiloModels) {
      if (byId.has(id)) continue
      byId.set(id, { id, object: 'model', created: 0, owned_by: 'kilo' })
    }

    return [...byId.values()]
  }

  /**
   * 找出这个模型对应的车道与具体路由信息。
   *
   * @param {string} model
   * @returns {{lane: string, entry?: object}|null}
   */
  function resolve(model) {
    // ⚠️ **聚合车道必须先判**，不能按「渠道包前缀在先」的顺序。
    //
    // `gemini` 与 `minimax` 这两个 id **同时**存在于渠道包和 provider 目录里。
    // `channels.handles()` 只看前缀，所以 `gemini/gemini-3.8-flash`（聚合条目）
    // 会被判成渠道模型，交给渠道包的 gemini 适配器 —— 它没有这个模型，直接 404。
    // 聚合条目是用户在设置页显式配的（带自己的 Key 和 baseURL），
    // 用**精确 id 全等**先认领，既不会误抢渠道的模型，也不会让聚合的模型走丢。
    const aggregate = aggregateCatalog().find(entry => entry.id === model)
    if (aggregate !== undefined && isAggregateEntry(aggregate)) {
      return { lane: LANE.AGGREGATE, entry: aggregate }
    }

    // 渠道包
    if (channels.handles(model)) return { lane: LANE.CHANNEL }

    // Kilo 免密车道
    if (kiloModels.has(model)) return { lane: LANE.KILO }

    return null
  }

  /**
   * 跑一轮补全。
   *
   * @param {object} request
   * @param {string} request.model 模型 id
   * @param {object} request.body   OpenAI 形态的请求体
   * @param {boolean} [request.responses] body 是不是 Responses 形态
   * @param {(chunk: object) => void} onChunk
   * @param {AbortSignal} [signal]
   */
  async function complete(request, onChunk, signal) {
    const { model, body, responses = false } = request
    const route = resolve(model)
    if (route === null) {
      // ⚠️ 字段名是 `status` 不是 `statusCode` —— 网关按 `status` 读，
      // 用错了会让「模型不存在」变成 502，客户端就分不清「模型没这个」
      // 与「网关坏了」。
      throw Object.assign(new Error(`模型不可用：${model}`), { status: 404 })
    }

    if (route.lane === LANE.CHANNEL) {
      // 渠道包原生懂 Responses：`toResponsesGenerateOptions` 会把
      // `input`/`instructions` 摊平成它内部的 message 形态。
      const outcome = await channels.complete({
        model,
        ...(responses ? { responses: true, responsesBody: body } : { openAi: body }),
        signal,
      }, onChunk)
      if (outcome.error !== undefined) {
        throw Object.assign(new Error(outcome.error), { status: 502 })
      }
      return outcome
    }

    // Kilo 与聚合车道吃的是 **Chat Completions** 形态：
    // Codex 发来的是 Responses 形态（`input`/`instructions`/`max_output_tokens`），
    // 直接转发会被上游 400。所以这里做一次**请求方向**的改写。
    //
    // ⚠️ **总是要求流式响应**：这两条车道的读取器只认 SSE。若 body 里没有
    // `stream: true`，上游会答一个完整的 JSON 文档 —— 那是「已经答完」，
    // 我们就拿不到增量，也就没法在出错时换路（failover 的提交规则依赖增量）。
    // 客户端要非流式，网关层自己把增量拼成完整响应。
    const chatBody = responses ? responsesToChat(body, dropped => {
      logger.warn?.(`忽略无法表达的工具类型：${dropped.type ?? 'unknown'}`)
    }) : body
    chatBody.stream = true

    if (route.lane === LANE.AGGREGATE) {
      await postAggregateStreamed({
        config: settings.get().aggregate ?? {},
        providerId: route.entry.providerId,
        modelId: route.entry.modelId,
        body: chatBody,
        signal,
        // 各家的流事件 → 统一 chunk。
        onData: payload => {
          const chunk = payloadToChunk(payload)
          if (chunk !== undefined) onChunk?.(chunk)
        },
      })
      return { text: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }
    }

    // Kilo
    await postKiloStreamed({
      body: chatBody,
      signal,
      onData: payload => {
        const chunk = payloadToChunk(payload)
        if (chunk !== undefined) onChunk?.(chunk)
      },
    })
    return { text: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }
  }

  return {
    LANE,
    modelRows,
    aggregateCatalog,
    complete,
    resolve,
    laneOf: model => laneOf(model, channels.providers),
    /** 更新 Kilo 的模型清单。 */
    setKiloModels(ids) {
      kiloModels = new Set((ids ?? []).map(id => String(id)))
    },
    get kiloModels() { return [...kiloModels] },
  }
}
