/**
 * 目录构造 —— 保留本 app 需要的两件事：
 *
 *  1. `displayModelName` —— 把裸模型 id 变成可读名字（聚合车道用）
 *  2. Kilo 车道的目录（`buildKiloCatalog` / `reviveKiloCatalog` / `isKiloEntry`）
 *
 * ## 被移除的部分
 *
 * 上游这份文件还有两块内容，本 app **不要**：
 *
 * - **免费聚合线**（`buildCatalog` / `CAPABILITIES` / `isFreeLane`）
 *   那条车道需要伪装官方 opencode 客户端的 UA 与工具定义，冒充客户端不成立，故下线。
 * - **EAC 共付车道**（`buildEacCatalog` / `isEacEntry`）
 *   它的凭据来自 seal 包里提取的共享签名密钥，上游可随时吊销，属于绕过授权机制。
 *
 * 保留 `displayModelName` 是因为聚合车道要显示用户自配 provider 的模型名。
 *
 * @module vendor/lanes/catalog.js
 */

import { baseModelId } from '../channels/tool-names.js'

const DISPLAY_NAMES = {
  'mimo-v2.6-flash-free': 'MiMo V2.6 Flash',
  'mimo-v2.5-free': 'MiMo V2.5',
  'muse-spark-1.3-contributor-free': 'Muse Spark 1.3',
  'muse-spark-1.2-contributor-free': 'Muse Spark 1.2',
  'nemotron-3-ultra-free': 'Nemotron 3 Ultra',
  'nemotron-3.5-lightning-free': 'Nemotron 3.5 Lightning',
  'ling-3.0-flash-fin-free': 'Ling 3.0 Flash Fin',
  'space-bunny-free': 'Space Bunny',
  'union-alpha': 'Union Alpha',
  'deepseek-v4-flash-free': 'DeepSeek V4 Flash',
  'deepseek-v4.1-flash-free': 'DeepSeek V4.1 Flash',
  'glm-5.3-flash-free': 'GLM 5.3 Flash',
  'jev-1.13-free': 'Jev 1.13',
}

/** Ids whose regional availability is known to be egress-dependent. */
const REGION_SENSITIVE = [/^muse.?spark/]

/**
 * Is this id on the免密 lane? The gateway's listing mixes paid and free ids;
 * only these answer without a per-user key.
 */
export function isFreeLane(modelId) {
  const base = baseModelId(modelId)
  if (ALWAYS_FREE.has(base)) return true
  return /(?:^|[-_])free(?:$|[-_.])/.test(base)
}

/** Look up the baseline capacities for one model id. An exact id override for a
 *  model the lane serves today wins over the family-wide pattern. */
export function capabilitiesFor(modelId) {
  const base = baseModelId(modelId)
  const override = FREE_ID_OVERRIDES[base]
  if (override !== undefined) return { reasoning: true, ...override }
  for (const entry of CAPABILITIES) if (entry.match.test(base)) return entry
  return { vision: false, reasoning: true, contextWindow: 131072, maxOutput: 32768 }
}

export function isRegionSensitive(modelId) {
  const base = baseModelId(modelId)
  return REGION_SENSITIVE.some(pattern => pattern.test(base))
}

/** Title-case a bare upstream id into something a picker can show. */
export function displayModelName(modelId) {
  const base = baseModelId(modelId)
  const known = DISPLAY_NAMES[base]
  if (known !== undefined) return known
  const words = base
    .replace(/[-_.]+/g, ' ')
    .replace(/(\d)\s+/g, '$1 ')
    .trim()
    .split(' ')
    .map(word => (/^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ')
  return words
}

/**
 * Merge the upstream listing with the local capability table.
 *
 * @param {string[]} ids - raw upstream model ids
 * @returns {Array<object>} catalog entries in listing order
 */
export function buildCatalog(ids) {
  const seen = new Set()
  const entries = []
  for (const raw of ids) {
    const id = String(raw ?? '').trim()
    if (id === '' || !isFreeLane(id)) continue
    const base = baseModelId(id)
    if (seen.has(base)) continue
    seen.add(base)
    const caps = capabilitiesFor(base)
    entries.push({
      id: base,
      name: displayModelName(base),
      wire: isResponsesModel(base) ? 'responses' : 'chat',
      vision: caps.vision === true,
      reasoning: caps.reasoning !== false,
      contextWindow: number(caps.contextWindow) ?? 131072,
      maxOutput: number(caps.maxOutput) ?? 32768,
      canDisableThinking: Array.isArray(caps.efforts)
        ? caps.efforts.includes('disabled')
        : caps.canDisableThinking !== false,
      regionSensitive: isRegionSensitive(base),
      // A model that declares its own thinking menu carries it end to end, the
      // same shape the absorbed channels use: the level is the real control on
      // the wire. Without a menu the free lane's token-budget ladder applies.
      ...Array.isArray(caps.efforts) ? {
        efforts: [...caps.efforts],
        effortDefault: caps.effortDefault,
        ...caps.effortPatch === undefined ? {} : { effortPatch: caps.effortPatch },
        ...caps.effortOffPatch === undefined ? {} : { effortOffPatch: caps.effortOffPatch },
      } : {},
    })
  }
  return entries
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined
}

/** Parse the gateway's `{"data":[{"id":…}]}` listing. */
export function parseListing(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : Array.isArray(payload) ? payload : []
  return rows.map(row => (typeof row === 'string' ? row : row?.id)).filter(id => typeof id === 'string' && id !== '')
}

// ── the Kilo channel ──────────────────────────────────────────────────────────
//
// A third producer whose ids are Kilo gateway ids (`org/model`, mostly with a
// `:free` suffix) and whose entries carry `channel: 'kilo'` end to end: the
// adapter routes them to their own wire, the probe skips them (their presence
// in the roster is the verdict — the listing named them this round), and the
// pages show the channel tag. No credential exists on this lane, so there is
// nothing to seal, gate, or leak; the cost is stated upstream instead —
// free-pool prompts may be logged by the provider (README, 免责声明).

export const KILO_CHANNEL = 'kilo'
export const KILO_TAG = 'Kilo'

/**
 * The thinking menu the free pool honours, verified live on 2026-10-06.
 *
 * The gateway speaks OpenRouter's unified `reasoning` object: `effort` picks a
 * level, `enabled: false` switches thinking off. Level runs measured on
 * `nemotron-3.5-lightning` (`reasoning_tokens`: off 0/0/0, low ≈216–252,
 * medium ≈220–428) — the parameter is accepted and forwarded on every probed
 * family, so the menu is the model's own control exactly like the EAC lane's,
 * not a token ladder wearing an effort name.
 *
 * Two families refuse the off rung outright — stepfun and liquid answer HTTP
 * 400 "Reasoning is mandatory for this endpoint and cannot be disabled", and
 * the two auto-routers accept the parameter but keep thinking anyway (verified
 * on `kilo-auto/off`), so their menus omit `disabled` rather than promise a
 * rung that fails the turn. `inkling-small` could not be probed (daily rate
 * limit) and stays conservative with them; ling-3.1 and laguna-xs inherit the
 * off rung from their verified siblings (ling-3.0-sante, laguna-s).
 */
const KILO_EFFORT_PATCH = { reasoning: { effort: '$effort' } }
const KILO_EFFORT_OFF_PATCH = { reasoning: { enabled: false } }
const KILO_REASONING_MANDATORY = [/^stepfun\//, /^liquid\//, /^thinkingmachines\//]
const KILO_NO_DISABLE_IDS = new Set(['kilo-auto/free', 'openrouter/free'])

/** The declared thinking menu for one listing row, EAC shape, or {} when the
 *  row does not declare reasoning support at all. */
function kiloEffortMenuFor(row) {
  const params = Array.isArray(row?.supported_parameters) ? row.supported_parameters : []
  if (!params.includes('reasoning')) return {}
  const id = String(row?.id ?? '')
  const canDisable = !KILO_REASONING_MANDATORY.some(pattern => pattern.test(id))
    && !KILO_NO_DISABLE_IDS.has(id)
  return {
    efforts: canDisable ? ['disabled', 'low', 'medium', 'high'] : ['low', 'medium', 'high'],
    // Parity with the EAC lane: the menu's own default is its top level.
    effortDefault: 'high',
    effortPatch: KILO_EFFORT_PATCH,
    ...canDisable ? { effortOffPatch: KILO_EFFORT_OFF_PATCH } : {},
    canDisableThinking: canDisable,
  }
}

/**
 * Is this raw listing row on Kilo's free pool? Everything else on that gateway
 * is a paid id that answers 401 keyless, and a picker full of guaranteed
 * refusals is worse than a short roster.
 */
export function isKiloFreeRow(row) {
  return row?.isFree === true && typeof row?.id === 'string' && row.id.trim() !== ''
}

/**
 * The picker name: the listing's own name with the vendor prefix and the
 * `(free)` qualifier stripped, under the channel tag — `NVIDIA: Nemotron 3
 * Ultra (free)` → `Kilo Nemotron 3 Ultra`. The `org/` prefix is routing
 * detail, never a name the picker shows.
 */
export function kiloDisplayName(row) {
  const raw = typeof row?.name === 'string' ? row.name.trim() : ''
  const bare = (raw !== '' ? raw : String(row?.id ?? ''))
    .replace(/^[^:]{1,40}:\s+/, '')
    .replace(/\s*\(free\)\s*$/i, '')
    .trim()
  const pretty = bare !== '' ? bare : String(row?.id ?? '')
    .replace(/[-_.]+/g, ' ').trim()
    .split(' ')
    .map(word => (/^\d/.test(word) ? word : word.toUpperCase() === word ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ')
  return `${KILO_TAG} ${pretty}`
}

function kiloEntryOf(row) {
  const context = number(row?.context_length) ?? number(row?.top_provider?.context_length) ?? 131072
  const output = number(row?.top_provider?.max_completion_tokens) ?? 32768
  const modalities = Array.isArray(row?.architecture?.input_modalities) ? row.architecture.input_modalities : []
  const menu = kiloEffortMenuFor(row)
  return {
    id: String(row.id).trim(),
    name: kiloDisplayName(row),
    channel: KILO_CHANNEL,
    wire: 'chat',
    vision: modalities.includes('image'),
    reasoning: true,
    contextWindow: context,
    maxOutput: output,
    // With a declared menu the thinking level itself is the control (a real
    // effort field on the wire); without one the free lane's token-budget
    // ladder applies and the model's streaming thinking cannot be switched off.
    canDisableThinking: menu.canDisableThinking === true,
    regionSensitive: false,
    ...menu.efforts === undefined ? {} : {
      efforts: [...menu.efforts],
      effortDefault: menu.effortDefault,
      effortPatch: menu.effortPatch,
      ...menu.effortOffPatch === undefined ? {} : { effortOffPatch: menu.effortOffPatch },
    },
  }
}

/**
 * Build the Kilo channel's catalog rows from its raw listing rows.
 * Rows that are not on the free pool, or that repeat an id, are dropped.
 */
export function buildKiloCatalog(rows) {
  const seen = new Set()
  const entries = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isKiloFreeRow(row)) continue
    const entry = kiloEntryOf(row)
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    entries.push(entry)
  }
  return entries
}

/**
 * Rebuild the channel's rows from the persisted cache (`kiloRows` in the
 * catalog store) — the same objects `buildKiloCatalog` produced, re-validated
 * field by field so a damaged store degrades to a shorter roster instead of a
 * malformed one.
 */
export function reviveKiloCatalog(stored) {
  const seen = new Set()
  const entries = []
  for (const row of Array.isArray(stored) ? stored : []) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    if (typeof row.id !== 'string' || row.id.trim() === '' || row.channel !== KILO_CHANNEL) continue
    const entry = {
      ...kiloEntryOf({ ...row, name: typeof row.name === 'string' && row.name !== '' ? row.name : row.id }),
      name: typeof row.name === 'string' && row.name !== '' ? row.name : kiloDisplayName({ id: row.id }),
      contextWindow: number(row.contextWindow) ?? 131072,
      maxOutput: number(row.maxOutput) ?? 32768,
      vision: row.vision === true,
    }
    // The persisted rows are built entries, not listing rows, so the declared
    // thinking menu travels with them (validated field by field) instead of
    // being re-derived from a `supported_parameters` array they never had.
    if (Array.isArray(row.efforts) && row.efforts.length > 0) {
      entry.efforts = row.efforts.filter(level => typeof level === 'string')
      entry.effortDefault = typeof row.effortDefault === 'string' ? row.effortDefault : entry.effortDefault
      if (row.effortPatch !== undefined && row.effortPatch !== null && typeof row.effortPatch === 'object') entry.effortPatch = row.effortPatch
      if (row.effortOffPatch !== undefined && row.effortOffPatch !== null && typeof row.effortOffPatch === 'object') entry.effortOffPatch = row.effortOffPatch
      entry.canDisableThinking = entry.efforts.includes('disabled')
    }
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    entries.push(entry)
  }
  return entries
}

/** Is this catalog row from the Kilo channel? */
export function isKiloEntry(entry) {
  return entry?.channel === KILO_CHANNEL
}
