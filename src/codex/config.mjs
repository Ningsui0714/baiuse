/**
 * Codex 接管 —— 把 `~/.codex/config.toml` 指向本机网关，并保证可安全回滚。
 *
 * ## 从 cc-switch 学到的两件事
 *
 * **1. `auth.json` 绝对不能碰。**
 * 早期工具把第三方 API Key 写进 `auth.json`，覆盖了官方的 ChatGPT 登录缓存 ——
 * 第三方模型能用了，但 Codex App 的远程操作、官方插件全没了。
 * 本模块**只写 `config.toml`**，`auth.json` 一个字节都不动。
 *
 * **2. 接管要有「归属标记」。**
 * 只靠 `base_url = "http://127.0.0.1:..."` 判断某段配置是不是我们写的，
 * 会误伤用户自己配的本地 provider。所以这里用**专用 provider id `ofm`**
 * 作为标记：只有 `[model_providers.ofm]` 这段是我们能认领、能清理的。
 *
 * ## 回滚策略
 *
 * 接管前把原始文件**整份备份**到 app 数据目录。恢复时：
 *
 * - 当前文件与我们写下的完全一致（哈希相同）→ 直接用备份还原，字节级复原
 * - 用户在我们写的版本上又改过 → 不敢用备份覆盖（会吞掉他的改动），
 *   改为**外科式摘除**：删掉 `[model_providers.ofm]` 段、把顶层 `model_provider`
 *   恢复成接管前的值，其余一律不动
 *
 * @module src/codex/config
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

import {
  detectEol,
  ensureSection,
  findSection,
  findTopLevelEnd,
  joinLines,
  readStringValue,
  removeSection,
  setKey,
  splitLines,
  tomlString,
} from './toml.mjs'

/** 我们写入的 provider id —— 同时是「这段配置归我们管」的标记。 */
export const PROVIDER_ID = 'ofm'
export const PROVIDER_NAME = 'BaiUse'

/** Codex 的配置目录。 */
export function resolveCodexDir({ env = process.env, home = os.homedir() } = {}) {
  const override = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : ''
  return override !== '' ? path.resolve(override) : path.join(home, '.codex')
}

/** 相关路径。 */
export function resolveCodexPaths(options = {}) {
  const dir = resolveCodexDir(options)
  return {
    dir,
    configPath: path.join(dir, 'config.toml'),
    authPath: path.join(dir, 'auth.json'),
    stateDbPath: path.join(dir, 'state_5.sqlite'),
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** 原子写：临时文件 + rename，权限 0600。 */
function atomicWrite(file, text) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temp, text, { mode: 0o600 })
    fs.renameSync(temp, file)
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp)
  }
}

/** 接管记录：存在 app 数据目录，不污染 `~/.codex`。 */
function markerPath(dataDir) {
  return path.join(dataDir, 'codex-takeover.json')
}

function backupPath(dataDir) {
  return path.join(dataDir, 'codex-config.backup.toml')
}

function readMarker(dataDir) {
  // 没有数据目录就当没接管过 —— 不能因为 path.join(undefined) 抛错把状态查询搞挂
  if (typeof dataDir !== 'string' || dataDir === '') return null
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath(dataDir), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function writeMarker(dataDir, marker) {
  atomicWrite(markerPath(dataDir), JSON.stringify(marker, null, 2))
}

function deleteMarker(dataDir) {
  try { fs.unlinkSync(markerPath(dataDir)) } catch { /* 不存在就算了 */ }
}

/** `auth.json` 里有没有官方登录（ChatGPT token 或 API key）。 */
function inspectAuth(authPath) {
  const text = readTextSafe(authPath)
  if (text === '') return { exists: false, mode: '', hasChatGPT: false, hasApiKey: false }

  let parsed
  try { parsed = JSON.parse(text) } catch { return { exists: true, mode: 'unreadable', hasChatGPT: false, hasApiKey: false } }

  const accessToken = parsed?.tokens?.access_token
  const apiKey = parsed?.OPENAI_API_KEY
  return {
    exists: true,
    mode: typeof parsed?.auth_mode === 'string' ? parsed.auth_mode : '',
    hasChatGPT: typeof accessToken === 'string' && accessToken !== '',
    hasApiKey: typeof apiKey === 'string' && apiKey !== '',
  }
}

/**
 * 读当前状态。
 *
 * @param {object} options
 * @param {string} options.dataDir app 数据目录
 * @param {object} [options.env]
 * @param {string} [options.home]
 */
export function getStatus({ dataDir, env, home } = {}) {
  const paths = resolveCodexPaths({ env, home })
  const text = readTextSafe(paths.configPath)
  const lines = splitLines(text)

  const topLevelEnd = findTopLevelEnd(lines)
  const currentProvider = readStringValue(lines, 'model_provider', 0, topLevelEnd) ?? 'openai'
  const currentModel = readStringValue(lines, 'model', 0, topLevelEnd) ?? ''
  const section = findSection(lines, `model_providers.${PROVIDER_ID}`)
  const baseUrl = section === null
    ? undefined
    : readStringValue(lines, 'base_url', section.bodyStart, section.bodyEnd)

  const marker = readMarker(dataDir)
  // ⚠️ `managed` 只表示「这个 app 写过配置」，**不能**绑死某个 provider id。
  // 多档案切换时 marker.providerId 会变成用户选的那个；早先拿它和 'ofm' 比，
  // 切成第三方后就被判成「没接管过」，于是第二次切换会把原始备份覆盖掉。
  const managed = marker !== null
  const drifted = managed && marker.wroteHash !== undefined && marker.wroteHash !== sha256(text)

  return {
    paths: {
      dir: paths.dir,
      configPath: paths.configPath,
      authPath: paths.authPath,
      stateDbPath: paths.stateDbPath,
    },
    configExists: text !== '',
    currentProvider,
    currentModel,
    active: currentProvider === PROVIDER_ID,
    hasOurBlock: section !== null,
    ourBaseUrl: baseUrl ?? '',
    managed,
    drifted,
    previousProvider: managed ? (marker.previousProvider ?? 'openai') : null,
    wroteProvider: managed ? (marker.providerId ?? null) : null,
    backupAvailable: managed && fs.existsSync(backupPath(dataDir)),
    auth: inspectAuth(paths.authPath),
  }
}

/**
 * 生成接管后的配置文本（纯函数，便于预览与测试）。
 *
 * @param {string} text 原始 config.toml
 * @param {object} options
 * @param {string} options.baseUrl 网关地址，如 `http://127.0.0.1:48760/v1`
 * @param {string} options.apiKey 网关 API Key
 * @param {string} [options.model] 要写进顶层 `model` 的模型 id
 * @param {boolean} [options.requiresOpenAiAuth] 是否要求官方登录态
 * @returns {string}
 */
export function buildConfigText(text, {
  baseUrl,
  apiKey,
  model,
  requiresOpenAiAuth = false,
  providerId = PROVIDER_ID,
  providerName = PROVIDER_NAME,
  wireApi = 'responses',
}) {
  const eol = detectEol(text)
  let lines = splitLines(text.replace(/\r\n/g, '\n'))
  const table = `model_providers.${providerId}`

  // 顶层：model_provider 与 model
  let topEnd = findTopLevelEnd(lines)
  lines = setKey(lines, 'model_provider', tomlString(providerId), 0, topEnd)
  if (typeof model === 'string' && model !== '') {
    topEnd = findTopLevelEnd(lines)
    lines = setKey(lines, 'model', tomlString(model), 0, topEnd)
    topEnd = findTopLevelEnd(lines)
    lines = setKey(lines, 'disable_response_storage', 'true', 0, topEnd)
  }

  // 目标 provider 段
  const ensured = ensureSection(lines, table)
  lines = ensured.lines
  let { bodyStart, bodyEnd } = ensured.section

  const put = (key, literal) => {
    lines = setKey(lines, key, literal, bodyStart, bodyEnd)
    const refreshed = findSection(lines, table)
    bodyStart = refreshed.bodyStart
    bodyEnd = refreshed.bodyEnd
  }

  put('name', tomlString(providerName))
  put('base_url', tomlString(baseUrl))
  put('wire_api', tomlString(wireApi))
  // ⚠️ Key 只写进 config.toml，绝不写 auth.json。
  put('experimental_bearer_token', tomlString(apiKey))
  // 有官方登录态时置 true：Codex 会继续带上官方身份（App 的远程操作/插件靠它）。
  // 没有官方登录时置 false，否则 Codex 会要求先登录才能用。
  put('requires_openai_auth', requiresOpenAiAuth ? 'true' : 'false')

  return joinLines(lines).replace(/\n/g, eol)
}

/**
 * 接管。
 *
 * @returns {{status: object, changed: boolean, backupCreated: boolean}}
 */
export function connect({ dataDir, baseUrl, apiKey, model, providerId = PROVIDER_ID, providerName, wireApi, env, home } = {}) {
  if (typeof baseUrl !== 'string' || baseUrl === '') throw new Error('缺少网关地址')
  if (typeof apiKey !== 'string' || apiKey === '') throw new Error('缺少网关 API Key')

  const paths = resolveCodexPaths({ env, home })
  const before = readTextSafe(paths.configPath)
  const status = getStatus({ dataDir, env, home })

  // 只在「第一次接管」时备份：多次接管不应把备份覆盖成已接管的版本
  let backupCreated = false
  if (status.managed === false) {
    if (fs.existsSync(paths.configPath)) {
      atomicWrite(backupPath(dataDir), before)
      backupCreated = true
    }
    writeMarker(dataDir, {
      providerId: PROVIDER_ID,
      previousProvider: status.currentProvider,
      backedUpAt: new Date().toISOString(),
      hadConfig: fs.existsSync(paths.configPath),
    })
  }

  const after = buildConfigText(before, {
    baseUrl,
    apiKey,
    model,
    requiresOpenAiAuth: status.auth.hasChatGPT === true,
    providerId,
    ...(providerName === undefined ? {} : { providerName }),
    ...(wireApi === undefined ? {} : { wireApi }),
  })

  atomicWrite(paths.configPath, after)

  const marker = readMarker(dataDir) ?? { providerId: PROVIDER_ID }
  writeMarker(dataDir, {
    ...marker,
    providerId: PROVIDER_ID,
    wroteHash: sha256(after),
    wroteAt: new Date().toISOString(),
  })

  return {
    status: getStatus({ dataDir, env, home }),
    changed: after !== before,
    backupCreated,
  }
}

/**
 * 撤销接管。
 *
 * @returns {{status: object, mode: 'restored'|'surgical'|'noop'}}
 */
export function disconnect({ dataDir, env, home } = {}) {
  const paths = resolveCodexPaths({ env, home })
  const current = readTextSafe(paths.configPath)
  const marker = readMarker(dataDir)

  if (marker === null) {
    // 没接管过；但如果文件里偏偏有我们的段（比如用户手写的），也清掉
    const status = getStatus({ dataDir, env, home })
    if (status.hasOurBlock === false && status.active === false) {
      return { status, mode: 'noop' }
    }
  }

  const backupFile = backupPath(dataDir)
  const clean = marker?.wroteHash !== undefined && marker.wroteHash === sha256(current)

  // No pre-existing file: remove only our unchanged generated configuration.
  // An existing empty file has its own empty backup and is restored as a file.
  if (clean && marker?.hadConfig === false && !fs.existsSync(backupFile)) {
    fs.rmSync(paths.configPath, { force: true })
    deleteMarker(dataDir)
    return { status: getStatus({ dataDir, env, home }), mode: 'restored' }
  }

  // ① 文件仍是「我们写下的那一份」：直接还原备份，字节级复原
  if (clean && fs.existsSync(backupFile)) {
    atomicWrite(paths.configPath, fs.readFileSync(backupFile, 'utf8'))
    deleteMarker(dataDir)
    try { fs.unlinkSync(backupFile) } catch { /* 忽略 */ }
    return { status: getStatus({ dataDir, env, home }), mode: 'restored' }
  }

  // ② 用户改过：只摘掉我们的部分，其余原样保留
  const eol = detectEol(current)
  let lines = splitLines(current.replace(/\r\n/g, '\n'))
  // 摘掉「我们写的那一家」；marker 记着是谁
  const wroteProvider = typeof marker?.providerId === 'string' && marker.providerId !== ''
    ? marker.providerId
    : PROVIDER_ID
  lines = removeSection(lines, `model_providers.${wroteProvider}`)

  const topEnd = findTopLevelEnd(lines)
  const provider = tomlString(marker?.previousProvider ?? 'openai')
  lines = setKey(lines, 'model_provider', provider, 0, topEnd)

  atomicWrite(paths.configPath, joinLines(lines).replace(/\n/g, eol))
  deleteMarker(dataDir)
  try { fs.unlinkSync(backupFile) } catch { /* 忽略 */ }

  return { status: getStatus({ dataDir, env, home }), mode: 'surgical' }
}

/** 预览接管后的文本（不落盘）。 */
export function preview({ dataDir, baseUrl, apiKey, model, providerId = PROVIDER_ID, providerName, wireApi, env, home } = {}) {
  const paths = resolveCodexPaths({ env, home })
  const before = readTextSafe(paths.configPath)
  const status = getStatus({ dataDir, env, home })
  const after = buildConfigText(before, {
    baseUrl,
    apiKey,
    model,
    requiresOpenAiAuth: status.auth.hasChatGPT === true,
    providerId,
    ...(providerName === undefined ? {} : { providerName }),
    ...(wireApi === undefined ? {} : { wireApi }),
  })
  return { before, after, changed: before !== after, requiresOpenAiAuth: status.auth.hasChatGPT === true }
}
