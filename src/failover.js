/**
 * 故障转移执行器 —— 把一次完成调用包成「可换路」的版本。
 *
 * ## 它解决什么
 *
 * 同一个模型可能存在于多个渠道（`trae/glm-5` 与 `cline/glm-5`）。
 * 首选那条路失败时，自动换到下一条，而不是把错误抛给用户。
 *
 * ## 关键：提交规则
 *
 * 上游一旦开始吐**正文**，切换 provider 就会让用户看到「两段回答拼在一起」——
 * 那是不可接受的。所以只有在**还没向客户端提交任何内容**时才允许换路。
 *
 * 但**不能**把 reasoning 也算作提交：Codex 会先吐 reasoning，
 * 「模型想了一分钟，然后撞上配额墙」恰恰是最该换路的场景。
 * 因此提交点定义为**答案性增量**（正文或工具调用参数）。
 *
 * ⚠️ 这与 dsh 的 `src/forward.js:650` 的 `hasContent` 判据**故意不同**：
 * 那边把 reasoning 算进去，用途是「何时提交 HTTP 响应头」（发出去就不能再换路）；
 * 这边不算，用途是「何时允许换路」（还没真正开始回答就还能换）。
 * 两处判据的差异在 `isAnswerBearing` 的注释里写明了原因 ——
 * 避免后人「顺手对齐」，那会把最有价值的 failover 场景废掉。
 */

import {
  CooldownLedger,
  RotationCursor,
  SessionAffinity,
  buildCandidates,
  classifyCooldownReason,
  selectCandidate,
  shouldFailover,
} from './route.js'

/**
 * 答案性增量：只有这类内容到达才算「已提交」。
 *
 * ⚠️ **reasoning-delta 刻意不算**：Codex 会先吐 reasoning，
 * 「模型想了一分钟，然后撞上配额墙」恰恰是最该换路的场景。
 * 若把 reasoning 当提交点，这一路就再也不能换路，用户只能看着一段思考过程然后报错。
 *
 * 与上游 dsh `src/forward.js:650` 的 `hasContent` 判据的差别：
 * 上游那处用于「何时提交 HTTP 响应头」（发出去就不该再换路），
 * 这里用于「何时允许换路」（还没真正开始回答就还能换）—— 两者用途不同，判据也不同。
 */
function isAnswerBearing(chunk) {
  if (chunk?.type === 'text-delta') {
    return typeof chunk.text === 'string' && chunk.text.length > 0
  }
  if (chunk?.type === 'tool-call-delta') {
    return typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta.length > 0
  }
  return false
}

/**
 * 把失败结构归一成 Error。
 *
 * 两条来源：
 *  - 抛异常（车道层、渠道包都是这样）
 *  - 返回 `{ error: '消息', failure: { code, status, retryAfterMs } }`
 *    —— 这是 dsh 的失败风格。**本 app 的车道层已经统一抛异常**，
 *    所以这个分支是兼容性兜底；但留着无害，且对将来接新来源有用。
 *
 * 两者都要能拿到 `message` / `status` / `code`，否则分类与冷却就失效了。
 */
function toError(value) {
  if (value instanceof Error) return value
  if (value && typeof value === 'object') {
    const failure = value.failure ?? {}
    const message = value.error ?? failure.message ?? '未知错误'
    const error = new Error(String(message))
    const status = failure.status ?? value.status ?? value.statusCode
    if (status !== undefined) error.status = Number(status)
    if (failure.code !== undefined) error.code = failure.code
    if (failure.retryAfterMs !== undefined) error.retryAfterMs = failure.retryAfterMs
    return error
  }
  return new Error(String(value ?? '未知错误'))
}

/**
 * 创建一个带故障转移的完成函数。
 *
 * @param {object} options
 * @param {(request: object, onChunk: (chunk: object) => void) => Promise<object>} options.baseComplete
 *        完成函数（车道层提供），失败时抛异常
 * @param {() => Promise<readonly object[]>} options.modelRows
 *        取内部真实路由目录（不是对外合并后的模型池），用于构建候选集
 * @param {object} [options.cooldowns] 冷却账本（复用同一个实例可跨请求共享冷却状态）
 * @param {object} [options.affinity]   会话粘性
 * @param {object} [options.cursor]     轮询游标
 * @param {number} [options.maxAttempts] 最大尝试次数，默认各候选最多一次
 * @param {(info: object) => void} [options.onAttempt] 每次尝试的回调（用于日志/观测）
 * @returns {(request: object, onChunk: (chunk: object) => void) => Promise<object>}
 */
export function createFailoverComplete({
  baseComplete,
  modelRows,
  cooldowns = new CooldownLedger(),
  affinity = new SessionAffinity(),
  cursor = new RotationCursor(),
  maxAttempts = Infinity,
  onAttempt,
}) {
  return async function completeWithFailover(request, onChunk) {
    const wanted = request?.model
    if (typeof wanted !== 'string' || wanted === '') {
      return baseComplete(request, onChunk)
    }

    // 单条路（没有备选）时不必走候选逻辑，直接透传 —— 保持与直接调用一致的行为。
    const rows = await modelRows()
    const candidates = buildCandidates(rows, { model: wanted })
    if (candidates.length <= 1) {
      return baseComplete(candidates.length ? { ...request, model: candidates[0].routeKey } : request, onChunk)
    }

    const sessionKey = resolveSessionKey(request)
    const tried = new Set()
    const pinned = affinity.get(sessionKey)
    let lastError

    for (let attempt = 0; attempt < Math.min(maxAttempts, candidates.length); attempt += 1) {
      const candidate = selectCandidate(candidates, { tried, cooldowns, cursor, pinned })
      if (candidate === undefined || tried.has(candidate.id)) break
      tried.add(candidate.id)

      // 缓冲：换路时要把这一路已产出的内容丢掉，不能让用户看到半截回答。
      // 代价是首个增量有额外延迟（上游 dsh 的 deferStreamResponse 也是同样取舍）。
      const buffered = []
      let committed = false

      const attemptComplete = async () => {
        const routeRequest = { ...request, model: candidate.routeKey }
        try {
          const result = await baseComplete(routeRequest, chunk => {
            if (!committed && isAnswerBearing(chunk)) {
              committed = true
              // 提交点：把缓冲的内容一次性交给下游
              for (const pending of buffered) onChunk?.(pending)
              buffered.length = 0
            }
            if (committed) onChunk?.(chunk)
            else buffered.push(chunk)
          })
          return result
        } finally {
          if (committed) {
            // 正常结束：把剩余缓冲刷出去
            for (const pending of buffered) onChunk?.(pending)
            buffered.length = 0
          }
        }
      }

      try {
        const result = await attemptComplete()
        const failed = result?.error !== undefined || result?.failure !== undefined
        if (!failed) {
          affinity.set(sessionKey, candidate.routeKey)
          onAttempt?.({ candidate, attempt, ok: true, committed })
          return result
        }
        // 归一成 Error：失败返回的是 `{error, failure}` 结构而非抛异常，
        // 但后续的分类/冷却/抛出都按 Error 处理。
        lastError = toError(result)
        onAttempt?.({ candidate, attempt, ok: false, committed, error: lastError })
      } catch (error) {
        lastError = toError(error)
        onAttempt?.({ candidate, attempt, ok: false, committed, error: lastError })
      }

      const reason = classifyCooldownReason(lastError ?? {})
      cooldowns.mark(candidate.id, reason)
      if (committed) affinity.unbind(sessionKey)

      if (!shouldFailover(lastError, committed)) {
        onAttempt?.({ candidate, attempt, ok: false, committed, error: lastError, gaveUp: true })
        break
      }
    }

    // 所有候选都试过了：把最后一个错误原样抛出，保留可诊断性。
    throw lastError ?? new Error(`没有可用的路由：${wanted}`)
  }
}

/**
 * 解析会话标识，用于会话粘性。
 *
 * Codex 的 `previous_response_id` 与 `encrypted_content` 是**账号作用域**的：
 * 换账号后上游认不出这段对话。所以只要能拿到会话标识，就应该把请求钉在同一条路上。
 *
 * 锚点优先级（与 Codex-Manager `conversation_binding.rs` 一致）：
 * `session_id` → `x-api-key` → bearer。
 */
export function resolveSessionKey(request) {
  const headers = request?.headers ?? {}
  // 头名归一化：大小写不敏感，且 `session_id` 与 `Session-ID` 视为同一个头
  // （不同客户端的写法不统一，Codex 用 `session_id`，别的客户端可能用 `session-id`）。
  const normalize = name => name.toLowerCase().replace(/[-_]/g, '-')
  const get = name => {
    const wanted = normalize(name)
    for (const [key, entry] of Object.entries(headers)) {
      if (normalize(key) === wanted && typeof entry === 'string' && entry !== '') return entry
    }
    return undefined
  }

  const sessionId = get('session_id') ?? get('x-session-id')
  if (sessionId) return `sid:${sessionId}`

  const apiKey = get('x-api-key')
  if (apiKey) return `xak:${apiKey}`

  const authorization = get('authorization')
  if (authorization) return `bearer:${authorization}`

  return undefined
}

/**
 * 判断请求是否来自 Codex CLI。
 *
 * ⚠️ **不看 Bearer、不看 chatgpt-account-id** —— 那是出站注入的，
 * 用它判断会把普通 OpenAI SDK 请求也误判成 Codex。
 * 判据是 UA 里的 `codex_cli_rs` / `codex_exec`，或任一 `x-codex-*` 头。
 * （与 Codex-Manager `gateway/local_validation/request.rs:1443` 一致）
 *
 * ⚠️ 只带 `session_id` **不算** Codex —— OpenCode 等客户端也带 session_id。
 */
export function isCodexClientRequest(headers) {
  if (!headers || typeof headers !== 'object') return false
  const entries = []
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') entries.push([key.toLowerCase(), value])
  }
  const get = name => entries.find(([key]) => key === name)?.[1]

  const userAgent = `${get('user-agent') ?? ''} ${get('originator') ?? ''}`.toLowerCase()
  if (userAgent.includes('codex_cli_rs') || userAgent.includes('codex_exec')) return true

  const codexHeaders = [
    'x-client-request-id',
    'x-openai-subagent',
    'x-codex-beta-features',
    'x-codex-window-id',
    'x-codex-turn-metadata',
    'x-codex-turn-state',
    'x-codex-parent-thread-id',
  ]
  return codexHeaders.some(name => get(name) !== undefined)
}
