/**
 * Codex 供应商档案 —— 「卡片 + 切换」。
 *
 * ## 这和聚合车道不是一回事
 *
 * - **聚合车道**：所有供应商都挂在网关后面，Codex 只连网关，按模型路由
 * - **供应商档案**（本模块）：每张卡是一份**直连**配置，切换 = 把
 *   `config.toml` 改成指向那一家，Codex 绕过网关直接打它
 *
 * 后者就是 cc-switch 的形态：同时只生效一份，切换是全局的。
 * 两种都要，因为场景不同 —— 想让某家跑满带宽、或某家只在直连时可用，
 * 就用直连；想自动故障转移，就用网关。
 *
 * ## 存储
 *
 * 档案存在 settings 的 `codexProfiles` 里（含 apiKey，文件 0600）。
 * 内置的「本机网关」档案是**虚拟的**，不落盘 —— 它的地址和 Key 跟着 app 走，
 * 用户改端口/换 Key 之后它自动跟着变，不需要同步。
 *
 * ## 写入
 *
 * 复用 `config.mjs` 那套外科式编辑：只动顶层 `model_provider` / `model` /
 * `disable_response_storage` 与目标 `[model_providers.<id>]` 段，其余字节不变；
 * 第一次切换前整份备份，`restore()` 能字节级还原。
 *
 * @module src/codex/profiles
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { PROVIDER_ID, buildConfigText, disconnect, getStatus, resolveCodexPaths } from './config.mjs'
/** Codex 的 `wire_api` 只认这两个值。 */
export const WIRE_APIS = Object.freeze(['responses', 'chat'])

/** 内置的「本机网关」档案 id（与接管用的 provider id 一致）。 */
export const GATEWAY_PROFILE_ID = PROVIDER_ID

/** 合法的档案 id：它会成为 TOML 表名与 `model_provider` 的值。 */
export function isValidProfileId(raw) {
  const id = String(raw ?? '').trim().toLowerCase()
  return /^[a-z0-9][a-z0-9_-]{1,31}$/.test(id) && id !== GATEWAY_PROFILE_ID
}

/**
 * 定档案 id。
 *
 * ⚠️ 用户填的是**中文/带空格的名字**（比如「宁小瞒」）时，**不要报错** ——
 * 那不是他该关心的事。按 Base URL 的主机名推一个（`api.deepseek.com` → `deepseek`），
 * 推不出来再用随机后缀。id 只是给 TOML 用的内部标识，用户看到的是显示名称。
 *
 * @param {object} body 表单提交
 * @param {Set<string>} taken 已被占用的 id
 */
export function resolveProfileId(body, taken = new Set()) {
  const raw = String(body.id ?? '').trim().toLowerCase()

  let base = isValidProfileId(raw) ? raw : ''
  if (base === '') base = idFromUrl(body.baseUrl) || `profile-${Math.random().toString(36).slice(2, 8)}`

  // 去重：deepseek、deepseek-2、deepseek-3…
  if (!taken.has(base)) return base
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`.slice(0, 32)
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-${Date.now().toString(36)}`.slice(0, 32)
}

/** 从 URL 主机名推一个 slug。 */
function idFromUrl(rawUrl) {
  try {
    const host = new URL(String(rawUrl ?? '')).hostname.toLowerCase()
    const parts = host.split('.').filter(part => part !== '' && part !== 'api' && part !== 'www' && part !== 'com' && part !== 'cn')
    const candidate = (parts[0] ?? '').replace(/[^a-z0-9]/g, '')
    if (candidate.length >= 2) return candidate.slice(0, 32)
  } catch {
    // URL 不合法时走兜底
  }
  return ''
}

/** 兼容旧调用：非法 id 直接抛错（仅供内部/测试使用）。 */
export function normalizeProfileId(raw) {
  const id = String(raw ?? '').trim().toLowerCase()
  if (id === GATEWAY_PROFILE_ID) {
    throw Object.assign(new Error(`"${GATEWAY_PROFILE_ID}" 是内置网关的保留 id`), { status: 400 })
  }
  if (!isValidProfileId(id)) {
    throw Object.assign(new Error('供应商 ID 只能用小写字母、数字、- 和 _，长度 2~32'), { status: 400 })
  }
  return id
}

function readProfiles(settings) {
  const raw = settings.get().codexProfiles
  if (!Array.isArray(raw)) return []
  return raw.filter(entry => entry !== null && typeof entry === 'object' && typeof entry.id === 'string')
}

function writeProfiles(settings, profiles) {
  settings.update({ codexProfiles: profiles })
}

/** 内置网关档案（虚拟，不落盘）。 */
function gatewayProfile({ gatewayUrl, gatewayKey, gatewayModel }) {
  return {
    id: GATEWAY_PROFILE_ID,
    name: '本机网关',
    description: '聚合所有渠道，按模型自动路由，支持故障转移',
    baseUrl: gatewayUrl,
    wireApi: 'responses',
    model: gatewayModel ?? '',
    apiKey: gatewayKey ?? '',
    builtin: true,
  }
}

/**
 * 列出全部档案，并标出哪一个正在生效。
 *
 * @param {object} options
 * @param {object} options.settings app 设置存储
 * @param {string} options.gatewayUrl 本机网关地址（含 /v1）
 * @param {string} options.gatewayKey 本机网关 Key
 * @param {string} [options.env]
 * @param {string} [options.home]
 */
export function listProfiles({ settings, dataDir, gatewayUrl, gatewayKey, gatewayModel, env, home } = {}) {
  // 统一成字符串：调用方可能只传 url（比如测试），undefined.slice 会直接崩
  const url = typeof gatewayUrl === 'string' ? gatewayUrl : ''
  const key = typeof gatewayKey === 'string' ? gatewayKey : ''
  const status = getStatus({ dataDir, env, home })
  const activeId = status.currentProvider

  const user = readProfiles(settings).map(profile => ({
    id: profile.id,
    name: profile.name ?? profile.id,
    description: profile.description ?? '',
    baseUrl: profile.baseUrl ?? '',
    wireApi: profile.wireApi ?? 'responses',
    model: profile.model ?? '',
    // Key 只在保存时回显提示，不返回明文
    hasKey: typeof profile.apiKey === 'string' && profile.apiKey !== '',
    keyHint: typeof profile.apiKey === 'string' && profile.apiKey !== ''
      ? `${profile.apiKey.slice(0, 4)}…${profile.apiKey.slice(-4)}`
      : '',
    builtin: false,
    active: activeId === profile.id,
  }))

  const gateway = gatewayProfile({ gatewayUrl: url, gatewayKey: key, gatewayModel })
  return [
    {
      id: gateway.id,
      name: gateway.name,
      description: gateway.description,
      baseUrl: gateway.baseUrl,
      wireApi: gateway.wireApi,
      model: gateway.model,
      hasKey: key !== '',
      keyHint: key === '' ? '' : `${key.slice(0, 4)}…${key.slice(-4)}`,
      builtin: true,
      active: activeId === GATEWAY_PROFILE_ID,
    },
    ...user,
  ]
}

/**
 * 新增或更新一份档案。
 *
 * @returns {object} 更新后的档案列表
 */
export function saveProfile({ settings, dataDir, profile, gatewayUrl, gatewayKey, gatewayModel, env, home } = {}) {
  const body = profile ?? {}
  const existing = readProfiles(settings)
  // 编辑已有档案时沿用原 id；新增时才推导
  const originalId = typeof body.originalId === 'string' && body.originalId !== '' ? body.originalId : ''
  const taken = new Set(existing.map(entry => entry.id).filter(entryId => entryId !== originalId))
  const id = originalId !== '' && isValidProfileId(originalId)
    ? originalId
    : resolveProfileId({ ...body, id: body.id }, taken)

  const baseUrl = String(body.baseUrl ?? '').trim()
  if (baseUrl === '') throw Object.assign(new Error('Base URL 必填'), { status: 400 })

  const wireApi = String(body.wireApi ?? 'responses')
  if (!WIRE_APIS.includes(wireApi)) {
    throw Object.assign(new Error('wire_api 只能是 responses 或 chat'), { status: 400 })
  }

  const profiles = existing
  const index = profiles.findIndex(entry => entry.id === (originalId || id))

  const previous = index === -1 ? {} : profiles[index]
  const next = {
    ...previous,
    id,
    name: String(body.name ?? '').trim() || id,
    description: String(body.description ?? '').trim(),
    baseUrl,
    wireApi,
    model: String(body.model ?? '').trim(),
    apiKey: typeof body.apiKey === 'string' && body.apiKey.trim() !== ''
      ? body.apiKey.trim()
      : (previous.apiKey ?? ''),
  }

  // 换 id 时删掉旧条目
  if (index !== -1 && profiles[index].id !== id) profiles.splice(index, 1)
  const target = profiles.findIndex(entry => entry.id === id)
  if (target === -1) profiles.push(next)
  else profiles[target] = next

  writeProfiles(settings, profiles)
  return listProfiles({ settings, dataDir, gatewayUrl, gatewayKey, gatewayModel, env, home })
}

/** 删除一份档案（不动 config.toml）。 */
export function removeProfile({ settings, dataDir, id, gatewayUrl, gatewayKey, gatewayModel, env, home } = {}) {
  if (id === GATEWAY_PROFILE_ID) {
    throw Object.assign(new Error('内置网关档案不能删除'), { status: 400 })
  }
  const profiles = readProfiles(settings).filter(entry => entry.id !== id)
  writeProfiles(settings, profiles)
  return listProfiles({ settings, dataDir, gatewayUrl, gatewayKey, gatewayModel, env, home })
}

/** 原子写。 */
function atomicWrite(file, text) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temp, text, { mode: 0o600 })
    fs.renameSync(temp, file)
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp)
  }
}

function readTextSafe(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}

/**
 * 把某份档案写进 `config.toml`（Codex 会直连它）。
 *
 * @returns {{ok:boolean, mode:string, profileId:string, message:string}}
 */
export function activateProfile({
  settings, dataDir, profileId, gatewayUrl, gatewayKey, gatewayModel, env, home,
} = {}) {
  const all = listProfiles({ settings, dataDir, gatewayUrl, gatewayKey, gatewayModel, env, home })
  const profile = all.find(entry => entry.id === profileId)
  if (profile === undefined) return { ok: false, mode: 'noop', profileId, message: '档案不存在' }

  const paths = resolveCodexPaths({ env, home })
  const before = readTextSafe(paths.configPath)
  const status = getStatus({ dataDir, env, home })

  // 第一次接管才备份（多次切换不应覆盖原始备份）
  if (status.managed === false) {
    if (before !== '') {
      atomicWrite(path.join(dataDir, 'codex-config.backup.toml'), before)
    }
    atomicWrite(path.join(dataDir, 'codex-takeover.json'), JSON.stringify({
      providerId: profile.id,
      previousProvider: status.currentProvider,
      backedUpAt: new Date().toISOString(),
      hadConfig: before !== '',
    }, null, 2))
  }

  // 网关档案的 Key 用实时值；用户档案用存下来的 Key
  const apiKey = profile.builtin ? (gatewayKey ?? '') : profileApiKey(settings, profile.id)
  const baseUrl = profile.builtin ? (gatewayUrl ?? '') : profile.baseUrl

  const after = buildConfigText(before, {
    providerId: profile.id,
    providerName: profile.name,
    baseUrl,
    apiKey,
    model: profile.model,
    wireApi: profile.wireApi,
    requiresOpenAiAuth: status.auth.hasChatGPT === true,
  })

  atomicWrite(paths.configPath, after)

  const markerFile = path.join(dataDir, 'codex-takeover.json')
  let marker = {}
  try { marker = JSON.parse(fs.readFileSync(markerFile, 'utf8')) } catch { marker = {} }
  atomicWrite(markerFile, JSON.stringify({
    ...marker,
    providerId: profile.id,
    wroteHash: crypto.createHash('sha256').update(after, 'utf8').digest('hex'),
    wroteAt: new Date().toISOString(),
  }, null, 2))

  return { ok: true, mode: 'activated', profileId: profile.id, message: `已切换到 ${profile.name}` }
}

/** 从 settings 里取某档案的真实 Key（只在写配置时用）。 */
function profileApiKey(settings, id) {
  const entry = readProfiles(settings).find(profile => profile.id === id)
  return typeof entry?.apiKey === 'string' ? entry.apiKey : ''
}

/** 还原到接管前的配置。 */
export function restoreConfig({ dataDir, env, home } = {}) {
  const result = disconnect({ dataDir, env, home })
  return {
    ok: true,
    mode: result.mode,
    message: result.mode === 'restored'
      ? '已还原到原始配置'
      : result.mode === 'surgical' ? '已摘除本 app 写入的配置（其余保留）' : '本来就没有接管',
  }
}
