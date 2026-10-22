/**
 * 统一路由 —— 跨 provider / 跨账号的候选选择与故障转移。
 *
 * ## 本模块解决什么
 *
 * 同一个模型可能存在于多个渠道（`trae/glm-5` 与 `cline/glm-5`）。
 * 首选那条路被限流、撞配额墙、遇验证码时，要能**自动换到下一条**，
 * 而不是把错误原样抛给用户。
 *
 * ## 设计来源
 *
 * 最初的方案是改造 dsh-our-free-model 插件，让它在**同一个 provider 内**换号之外
 * 还能跨 provider 换路 —— 它的 `complete` 入口是按模型名前缀分流的
 * （`channels.handles(model) ? channels.complete(...) : core.complete(...)`），
 * 分流之后就没有「另一条路」可选了。
 *
 * 本模块是那个思路的独立实现。**它不 import 也不需要 dsh** ——
 * 下面的对比只是解释设计动机。
 *
 * - 免费聚合线 —— 需伪装官方客户端指纹，**已下线**（见 `vendor/lanes/catalog.js`）
 * - 渠道包线 —— 12 家客户端逆向 API，自带完整账号池
 *
 * 渠道包内部确实有换号能力（`nextAccount(modelId, tried)`），但那只是
 * **同一个 provider 内部**换账号 —— 本模块补的是跨 provider 这一层。
 *
 * ## 设计取舍（全部来自两个上游仓库的实测教训）
 *
 * 1. **提交规则**：reasoning-delta **不算提交**。Codex 会先吐 reasoning，
 *    若把它当提交点，「想了一分钟然后撞配额墙」这个最有价值的 failover 场景就废了。
 *    （上游 dsh `src/adapter.js` L215-218 的 `runCombo()` 明确写了这个理由）
 *
 * 2. **限流解禁时间取更长者**：各家限流解析都有「解析不出 → 退兜底值」的末端，
 *    而兜底通常偏短（cline 兜底 1h，真实可能 19h39m）。后写的短值覆盖先写的真值
 *    → 无限循环。上游 dsh `business.mjs` L30842 记录了这个事故。
 *
 * 3. **轮询游标记 id 而非下标**：池扩容/收缩时，下标会串位。
 *    （Codex-Manager `gateway/routing/route_hint.rs` 的做法）
 *
 * 4. **最后一个候选永不跳过**：否则出错时拿不到「到底为什么失败」这个可诊断信息。
 *    （Codex-Manager `gateway/upstream/support/candidates.rs`）
 *
 * 5. **凭据 ref 前缀按长度降序**：`QODERCN` 必须在 `QODER` 之前，否则 CN 凭据
 *    静默挂到 qoder 面板。上游 dsh L29823 记录了这个坑。
 */

/** 冷却原因 → 冷却秒数。阶梯语义：429 越犯越久，其余按类别固定。 */
export const COOLDOWN_SECONDS = Object.freeze({
  default: 20,
  network: 20,
  rateLimited: 45,
  upstream5xx: 30,
  upstream4xx: 20,
  challenge: 6,
  anthropicChallenge: 60,
})

/** 连续 429 的冷却阶梯（秒）。超过 30 分钟未再犯则视为新一轮。 */
export const RATE_LIMIT_LADDER_SECONDS = Object.freeze([45, 300, 1800, 7200])

/** offense 记忆时长：超过则清零，避免长期记仇误伤账号。 */
export const OFFENSE_FORGET_AFTER_MS = 30 * 60 * 1000

const REASON_RE = /rate.?limit|too many requests|429|quota|限额|限流|额度|积分|余额不足/i
const CHALLENGE_RE = /captcha|verify|challenge|人机|验证码/i
const NETWORK_RE = /fetch failed|econnreset|etimedout|enotfound|eai_again|socket hang up|network/i
const SERVER_RE = /internal server error|bad gateway|service unavailable|gateway timeout|5\d\d/i

/**
 * 把一个失败归类成冷却原因。
 *
 * 归类顺序有讲究：**挑战类必须先于限流类判断**，因为不少渠道把验证码错误
 * 也报成 429；若按限流处理，会白白冷却 45 秒起，而挑战的正解是重试。
 *
 * @param {{status?: number, code?: string, message?: string}} error
 * @returns {keyof typeof COOLDOWN_SECONDS}
 */
export function classifyCooldownReason(error) {
  const status = Number(error?.status ?? error?.statusCode ?? 0)
  const code = String(error?.code ?? '').toUpperCase()
  const text = `${error?.message ?? ''}`

  if (CHALLENGE_RE.test(text) || code === 'CHALLENGE') return 'challenge'
  if (status === 429 || code === 'RATE_LIMIT' || code === 'QUOTA_EXHAUSTED' || REASON_RE.test(text)) {
    return 'rateLimited'
  }
  if (status >= 500 || SERVER_RE.test(text)) return 'upstream5xx'
  if (status >= 400) return 'upstream4xx'
  if (NETWORK_RE.test(text)) return 'network'
  return 'default'
}

/**
 * 冷却账本：按 key 记录「冷却到什么时候」与「连续犯规次数」。
 *
 * key 用 `provider/model#accountId` 形态 —— 同一个账号在不同模型上的限流是独立的
 * （cline 经常只限某个模型），但同一个模型的冷却应跨 provider 隔离。
 */
export class CooldownLedger {
  #until = new Map()
  #offenses = new Map()
  #lastOffense = new Map()
  #now

  constructor(now = () => Date.now()) {
    this.#now = now
  }

  /** 该 key 当前是否处于冷却中。 */
  isCooling(key) {
    const until = this.#until.get(key)
    return until !== undefined && until > this.#now()
  }

  /** 冷却到什么时候（毫秒时间戳）；不在冷却则 undefined。 */
  untilOf(key) {
    const until = this.#until.get(key)
    return until !== undefined && until > this.#now() ? until : undefined
  }

  /**
   * 记一次失败并进入冷却。
   *
   * ⚠️ **解禁时间取更长者**：见模块头「坑 2」。若新的解禁时刻比已记录的更早，
   * 说明新拿到的是「解析不出时长」的兜底值，不能覆盖已经拿到的真值。
   */
  mark(key, reason) {
    const now = this.#now()
    const previous = this.#lastOffense.get(key)
    const stale = previous === undefined || now - previous > OFFENSE_FORGET_AFTER_MS
    const offense = stale ? 1 : (this.#offenses.get(key) ?? 0) + 1
    this.#offenses.set(key, offense)
    this.#lastOffense.set(key, now)

    let seconds = COOLDOWN_SECONDS[reason] ?? COOLDOWN_SECONDS.default
    if (reason === 'rateLimited') {
      const index = Math.min(offense - 1, RATE_LIMIT_LADDER_SECONDS.length - 1)
      seconds = RATE_LIMIT_LADDER_SECONDS[index]
    }
    const until = now + seconds * 1000
    const current = this.#until.get(key)
    this.#until.set(key, current === undefined ? until : Math.max(current, until))
    return this.#until.get(key)
  }

  /** 手动解除冷却（账号被重新启用时用）。 */
  clear(key) {
    this.#until.delete(key)
    this.#offenses.delete(key)
    this.#lastOffense.delete(key)
  }

  /** 清理过期条目，避免无限增长。 */
  prune() {
    const now = this.#now()
    for (const [key, until] of this.#until) {
      if (until <= now) this.#until.delete(key)
    }
    for (const [key, at] of this.#lastOffense) {
      if (now - at > OFFENSE_FORGET_AFTER_MS) {
        this.#lastOffense.delete(key)
        this.#offenses.delete(key)
      }
    }
  }
}

/**
 * 会话粘性：把一次会话钉在同一条路上。
 *
 * 为什么要钉：Codex 的 `previous_response_id` 与 `encrypted_content` 是**账号作用域**的
 * —— 换账号后上游认不出这段对话，表现为「模型突然忘了上下文」或直接 400。
 * （Codex-Manager `gateway/routing/conversation_binding.rs` 出于同样理由做持久绑定）
 *
 * key 由调用方提供（Codex 侧可用 `session_id` / `x-codex-turn-metadata` 里的会话标识）。
 */
export class SessionAffinity {
  #binding = new Map()
  #ttlMs
  #maxEntries

  constructor({ ttlMs = 30 * 60 * 1000, maxEntries = 5000 } = {}) {
    this.#ttlMs = ttlMs
    this.#maxEntries = maxEntries
  }

  #prune(now) {
    for (const [key, entry] of this.#binding) {
      if (entry.expiresAt <= now) this.#binding.delete(key)
    }
    // 简单的容量控制：超量时丢最早插入的（Map 保持插入序）
    while (this.#binding.size > this.#maxEntries) {
      const oldest = this.#binding.keys().next().value
      this.#binding.delete(oldest)
    }
  }

  /** 读出该会话已绑定的 route key；不存在或过期则 undefined。 */
  get(sessionKey) {
    if (!sessionKey) return undefined
    const entry = this.#binding.get(sessionKey)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.#binding.delete(sessionKey)
      return undefined
    }
    return entry.routeKey
  }

  /** 把会话钉到某条路。 */
  set(sessionKey, routeKey) {
    if (!sessionKey) return
    this.#prune(Date.now())
    this.#binding.set(sessionKey, { routeKey, expiresAt: Date.now() + this.#ttlMs })
  }

  /** 该路失败后解绑，让下一次重新选路。 */
  unbind(sessionKey) {
    if (sessionKey) this.#binding.delete(sessionKey)
  }
}

/**
 * 轮询游标。
 *
 * ⚠️ 游标记的是 **id** 而不是下标 —— 候选列表增删时，下标会串位，
 * 导致某个候选被跳过或被重复选中。（Codex-Manager `route_hint.rs` 的做法）
 */
export class RotationCursor {
  #lastId

  /** 从候选里挑下一个，返回它在数组中的下标。 */
  pick(candidates) {
    if (candidates.length === 0) return -1
    if (candidates.length === 1) return 0
    const index = candidates.findIndex(candidate => candidate.id === this.#lastId)
    const next = index === -1 ? 0 : (index + 1) % candidates.length
    this.#lastId = candidates[next].id
    return next
  }

  get lastId() {
    return this.#lastId
  }
}

/**
 * 候选集的形态。
 *
 * @typedef {object} RouteCandidate
 * @property {string}  id           唯一标识（provider/model#accountId）
 * @property {string}  provider     provider 名
 * @property {string}  model        provider 内的模型名
 * @property {string}  routeKey     传给 complete 的模型串（provider/model）
 * @property {string}  [accountId]  账号 id（渠道包线有，免费线没有）
 * @property {number}  [priority]   越小越优先（provider 声明序）
 */

/**
 * 从模型目录构建候选集。
 *
 * @param {readonly {id: string, owned_by?: string}[]} modelRows  /v1/models 的行
 * @param {object} options
 * @param {string} options.model            客户端请求的模型（可能是裸名或 provider/model）
 * @param {boolean} [options.prioritizeExact] 是否把精确匹配排前面
 * @returns {RouteCandidate[]}
 */
export function buildCandidates(modelRows, { model, prioritizeExact = true }) {
  const rows = Array.isArray(modelRows) ? modelRows : []
  const wanted = String(model ?? '').trim()
  if (wanted === '') return []

  const candidates = []
  for (const row of rows) {
    const id = String(row?.id ?? '')
    if (id === '') continue
    const slash = id.indexOf('/')
    if (slash === -1) {
      // 裸名（免费线）：直接命中
      if (id === wanted) candidates.push({ id, provider: row.owned_by ?? 'free', model: id, routeKey: id, priority: 0 })
      continue
    }
    const provider = id.slice(0, slash)
    const modelName = id.slice(slash + 1)
    // 匹配规则：provider/model 全等，或裸模型名与 modelName 相等（跨 provider 同名模型）
    const exact = id === wanted
    const bareMatch = modelName === wanted || wanted.endsWith(`/${modelName}`) === false ? modelName === wanted : false
    if (!exact && !bareMatch) continue
    candidates.push({
      id,
      provider,
      model: modelName,
      routeKey: id,
      priority: exact ? 0 : 1,
    })
  }

  if (prioritizeExact && candidates.length > 1) {
    candidates.sort((a, b) => a.priority - b.priority)
  }
  return candidates
}

/**
 * 选出下一次应该尝试的候选。
 *
 * 软约束（冷却中 / 已试过）会跳过，但**最后一个候选永不跳过** ——
 * 否则请求会以「没有可用路由」结束，用户永远看不到真实的上游错误。
 *
 * @param {RouteCandidate[]} candidates
 * @param {object} options
 * @param {Set<string>} options.tried       已试过的候选 id
 * @param {CooldownLedger} options.cooldowns 冷却账本
 * @param {RotationCursor} [options.cursor]  轮询游标
 * @param {string} [options.pinned]         会话粘性钉住的 route key
 * @returns {RouteCandidate | undefined}
 */
export function selectCandidate(candidates, { tried = new Set(), cooldowns, cursor, pinned } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined

  // 会话粘性优先：钉住的候选如果还可用就直接用
  if (pinned) {
    const bound = candidates.find(candidate => candidate.routeKey === pinned)
    if (bound && !tried.has(bound.id) && !(cooldowns?.isCooling(bound.id) ?? false)) return bound
  }

  const usable = candidates.filter(candidate => {
    if (tried.has(candidate.id)) return false
    if (cooldowns?.isCooling(candidate.id) ?? false) return false
    return true
  })

  if (usable.length === 0) {
    // 全部不可用 → 退回候选列表的最后一个，让错误可诊断
    return candidates[candidates.length - 1]
  }

  if (cursor && usable.length > 1) {
    const index = cursor.pick(usable)
    if (index >= 0) return usable[index]
  }
  return usable[0]
}

/**
 * 判断这次失败是否值得换路。
 *
 * **提交规则**在这里落地：调用方只在收到第一个「答案性增量」后才把
 * `committed` 置为 true；在此之前的失败（配额墙、验证码、限流）都应换路。
 * 之后就committed 的失败不应换路 —— 因为用户已经看到内容了。
 *
 * @param {object} error
 * @param {boolean} committed 是否已向客户端吐出过内容
 */
export function shouldFailover(error, committed) {
  if (committed) return false
  const status = Number(error?.status ?? error?.statusCode ?? 0)
  // 明确的客户端错误不换路：换路也修不好
  if (status >= 400 && status < 500) {
    const reason = classifyCooldownReason(error)
    if (reason !== 'rateLimited' && reason !== 'challenge' && reason !== 'network' && reason !== 'upstream5xx') {
      return false
    }
  }
  return true
}
