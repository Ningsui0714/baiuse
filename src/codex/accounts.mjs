/**
 * Codex 账号管理 —— 多账号登录与切换。
 *
 * ## 这里做的是哪一半
 *
 * cc-switch 的「Codex 账号」有两条路：
 *
 * 1. **应用内登录**（设备码）—— 用户拿到一个短码，去 openai 页面确认，
 *    我们换回 token 并存下来
 * 2. **切换** —— 把某个账号的 token 写进 `~/.codex/auth.json`
 *
 * 本模块两条都做。设备码用的是 **Codex CLI 自己的公开 client id**
 * （`app_EMoamEEZ73f0CkXaXp7hrann`）与它自己的验证页 —— 这不是冒充，
 * 就是 Codex 客户端的登录流程本身。
 *
 * ## 为什么也要「记录当前登录」
 *
 * 用户可能已经用 Codex 自己登录过了。逼他重新走一遍设备码是多余的 ——
 * 所以支持把当前的 `auth.json` 直接存成一个账号快照。
 *
 * ## 存储
 *
 * 账号存在 app 数据目录的 `codex-accounts.json`（0600），**只有 token，没有别的**。
 * 切换时写 `~/.codex/auth.json`，并在切换前把原来的 auth.json 备份到
 * `<dataDir>/codex-auth.previous.json`，所以切错了还能切回来。
 *
 * @module src/codex/accounts
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { resolveCodexPaths } from './config.mjs'

/** Codex CLI 的公开 OAuth client id（与 Codex 自身登录一致）。 */
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const DEVICE_USERCODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode'
const DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token'
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const DEVICE_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback'
const VERIFICATION_URL = 'https://auth.openai.com/codex/device'
const USER_AGENT = 'codex-cli/0.142.0'

/** 轮询超时上限（秒）。 */
const MAX_POLL_SECONDS = 600

/* ------------------------------------------------------------------ *
 * 存储
 * ------------------------------------------------------------------ */

function accountsFile(dataDir) {
  return path.join(dataDir, 'codex-accounts.json')
}

function previousAuthFile(dataDir) {
  return path.join(dataDir, 'codex-auth.previous.json')
}

function readStore(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(accountsFile(dataDir), 'utf8'))
    const accounts = Array.isArray(parsed?.accounts) ? parsed.accounts : []
    return { accounts: accounts.filter(entry => entry !== null && typeof entry === 'object' && typeof entry.id === 'string') }
  } catch {
    return { accounts: [] }
  }
}

function writeStore(dataDir, store) {
  const file = accountsFile(dataDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(store, null, 2), { mode: 0o600 })
    fs.renameSync(temp, file)
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp)
  }
}

/* ------------------------------------------------------------------ *
 * JWT 解析（只为拿 label 与 account_id，不校验签名）
 * ------------------------------------------------------------------ */

/** base64url → Buffer。 */
function decodeBase64Url(input) {
  const normalized = String(input ?? '').replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  return Buffer.from(padded, 'base64')
}

/**
 * 从 id_token 里取账号信息。
 *
 * ⚠️ 只解码、**不验签** —— 这两个字段只用来显示标签和写 `account_id`，
 * 真正的凭证是 access_token，由 Codex 自己校验。
 */
export function decodeIdToken(idToken) {
  const empty = { accountId: '', email: '', plan: '' }
  if (typeof idToken !== 'string' || idToken === '') return empty

  const parts = idToken.split('.')
  if (parts.length < 2) return empty

  let payload
  try {
    payload = JSON.parse(decodeBase64Url(parts[1]).toString('utf8'))
  } catch {
    return empty
  }

  const auth = payload['https://api.openai.com/auth'] ?? {}
  return {
    accountId: String(auth.chatgpt_account_id ?? payload.chatgpt_account_id ?? ''),
    email: String(payload.email ?? ''),
    plan: String(auth.chatgpt_plan_type ?? ''),
  }
}

/* ------------------------------------------------------------------ *
 * 设备码登录
 * ------------------------------------------------------------------ */

/**
 * 开始设备码登录。
 *
 * @returns {Promise<{deviceAuthId:string, userCode:string, verificationUrl:string, intervalSeconds:number, expiresAt:number}>}
 */
export async function startDeviceLogin({ fetchImpl = fetch } = {}) {
  const response = await fetchImpl(DEVICE_USERCODE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  })

  const text = await response.text()
  if (!response.ok) {
    throw Object.assign(new Error(`设备码请求失败：HTTP ${response.status} ${text.slice(0, 200)}`), { status: 502 })
  }

  let payload
  try { payload = JSON.parse(text) } catch {
    throw Object.assign(new Error('设备码响应不是 JSON'), { status: 502 })
  }

  const deviceAuthId = String(payload.device_auth_id ?? payload.deviceAuthId ?? '')
  const userCode = String(payload.user_code ?? payload.userCode ?? '')
  if (deviceAuthId === '' || userCode === '') {
    throw Object.assign(new Error('设备码响应缺少 device_auth_id / user_code'), { status: 502 })
  }

  const interval = Number(payload.interval) || 5
  const expiresIn = Math.min(Number(payload.expires_in ?? payload.expiresIn) || MAX_POLL_SECONDS, MAX_POLL_SECONDS)

  return {
    deviceAuthId,
    userCode,
    verificationUrl: VERIFICATION_URL,
    intervalSeconds: interval,
    expiresAt: Date.now() + expiresIn * 1000,
  }
}

/** 用 authorization_code 换 token。 */
async function exchangeCode({ code, codeVerifier, fetchImpl = fetch }) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: DEVICE_REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
  })

  const response = await fetchImpl(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': USER_AGENT,
    },
    body: form.toString(),
  })

  const text = await response.text()
  if (!response.ok) {
    throw Object.assign(new Error(`换取 token 失败：HTTP ${response.status} ${text.slice(0, 200)}`), { status: 502 })
  }

  let payload
  try { payload = JSON.parse(text) } catch {
    throw Object.assign(new Error('token 响应不是 JSON'), { status: 502 })
  }

  if (typeof payload.access_token !== 'string' || payload.access_token === '') {
    throw Object.assign(new Error('token 响应缺少 access_token'), { status: 502 })
  }

  return {
    idToken: String(payload.id_token ?? ''),
    accessToken: payload.access_token,
    refreshToken: String(payload.refresh_token ?? ''),
    expiresIn: Number(payload.expires_in) || 3600,
  }
}

/**
 * 轮询一次设备码授权。
 *
 * @returns {Promise<{status:'pending'|'ok', account?: object, message?: string}>}
 */
export async function pollDeviceLogin({ deviceAuthId, userCode, dataDir, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(DEVICE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
  })

  // 403 / 404 = 还没确认；410 = 码过期
  if (response.status === 403 || response.status === 404) {
    return { status: 'pending', message: '等待你在浏览器里确认…' }
  }
  if (response.status === 410) {
    return { status: 'expired', message: '设备码已过期，请重新开始' }
  }

  const text = await response.text()
  if (!response.ok) {
    throw Object.assign(new Error(`轮询失败：HTTP ${response.status} ${text.slice(0, 200)}`), { status: 502 })
  }

  let payload
  try { payload = JSON.parse(text) } catch {
    throw Object.assign(new Error('轮询响应不是 JSON'), { status: 502 })
  }

  const code = String(payload.authorization_code ?? payload.code ?? '')
  const codeVerifier = String(payload.code_verifier ?? '')
  if (code === '' || codeVerifier === '') {
    return { status: 'pending', message: '等待你在浏览器里确认…' }
  }

  const tokens = await exchangeCode({ code, codeVerifier, fetchImpl })
  const info = decodeIdToken(tokens.idToken)

  const account = {
    id: `codex-${crypto.randomBytes(4).toString('hex')}`,
    label: info.email !== '' ? info.email : (info.accountId !== '' ? info.accountId.slice(0, 8) : 'ChatGPT 账号'),
    email: info.email,
    plan: info.plan,
    accountId: info.accountId,
    source: 'device',
    addedAt: new Date().toISOString(),
    tokens: {
      id_token: tokens.idToken,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
    },
  }

  if (dataDir !== undefined) {
    const store = readStore(dataDir)
    store.accounts.push(account)
    writeStore(dataDir, store)
  }

  return { status: 'ok', account }
}

/* ------------------------------------------------------------------ *
 * 记录当前登录 / 列表 / 切换
 * ------------------------------------------------------------------ */

/** 读当前 auth.json（可能不存在）。 */
function readAuth(authPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 把当前 `~/.codex/auth.json` 记成一个账号。
 *
 * 适用于「我已经用 Codex 登录过了，不想再走一遍设备码」。
 *
 * @returns {{ok:boolean, account?: object, message:string}}
 */
export function captureCurrentAuth({ dataDir, label = '', env, home } = {}) {
  const paths = resolveCodexPaths({ env, home })
  const auth = readAuth(paths.authPath)
  if (auth === null) return { ok: false, message: '没有可记录的登录（auth.json 不存在或读不出）' }

  const tokens = auth.tokens ?? {}
  const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : ''
  const refreshToken = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : ''
  const idToken = typeof tokens.id_token === 'string' ? tokens.id_token : ''
  const apiKey = typeof auth.OPENAI_API_KEY === 'string' ? auth.OPENAI_API_KEY : ''

  if (accessToken === '' && apiKey === '') {
    return { ok: false, message: '当前 auth.json 里没有可用的登录凭据' }
  }

  const info = decodeIdToken(idToken)
  const account = {
    id: `codex-${crypto.randomBytes(4).toString('hex')}`,
    label: label.trim() !== '' ? label.trim() : (info.email !== '' ? info.email : '当前登录'),
    email: info.email,
    plan: info.plan,
    accountId: info.accountId !== '' ? info.accountId : String(tokens.account_id ?? ''),
    source: 'capture',
    addedAt: new Date().toISOString(),
    tokens: {
      id_token: idToken,
      access_token: accessToken,
      refresh_token: refreshToken,
      ...(apiKey !== '' ? { api_key: apiKey } : {}),
    },
  }

  const store = readStore(dataDir)
  store.accounts.push(account)
  writeStore(dataDir, store)
  return { ok: true, account, message: '已记录当前登录' }
}

/** 账号列表（不含 token）。 */
export function listAccounts({ dataDir, env, home } = {}) {
  const store = readStore(dataDir)
  const paths = resolveCodexPaths({ env, home })
  const current = readAuth(paths.authPath)
  const currentAccess = typeof current?.tokens?.access_token === 'string' ? current.tokens.access_token : ''

  return store.accounts.map(account => {
    const access = account.tokens?.access_token ?? ''
    return {
      id: account.id,
      label: account.label,
      email: account.email ?? '',
      plan: account.plan ?? '',
      source: account.source ?? 'device',
      addedAt: account.addedAt ?? null,
      lastUsedAt: account.lastUsedAt ?? null,
      hasRefreshToken: typeof account.tokens?.refresh_token === 'string' && account.tokens.refresh_token !== '',
      // 只做「是否就是当前这份 token」的比较，不返回 token 本身
      active: access !== '' && access === currentAccess,
    }
  })
}

/** 组装 Codex 期望的 auth.json 结构。 */
export function buildAuthJson(account, { now = new Date() } = {}) {
  const tokens = account.tokens ?? {}
  const base = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: tokens.id_token ?? '',
      access_token: tokens.access_token ?? '',
      refresh_token: tokens.refresh_token ?? '',
      account_id: account.accountId ?? '',
    },
    last_refresh: now.toISOString(),
  }
  // 快照来源的账号可能只有 API key（auth_mode = apikey）
  if (typeof tokens.api_key === 'string' && tokens.api_key !== '' && !tokens.access_token) {
    return {
      auth_mode: 'apikey',
      OPENAI_API_KEY: tokens.api_key,
      tokens: null,
      last_refresh: now.toISOString(),
    }
  }
  return base
}

/** 原子写 auth.json（0600）。 */
function writeAuth(authPath, value) {
  const file = authPath
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
    fs.renameSync(temp, file)
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp)
  }
}

/**
 * 切换到某个账号。
 *
 * 切换前把当前 `auth.json` 备份到 app 数据目录 —— 切错了能切回来。
 *
 * @returns {{ok:boolean, message:string, account?: object}}
 */
export function switchAccount({ dataDir, accountId, env, home } = {}) {
  const store = readStore(dataDir)
  const index = store.accounts.findIndex(entry => entry.id === accountId)
  if (index === -1) return { ok: false, message: '账号不存在' }

  const paths = resolveCodexPaths({ env, home })

  // 备份当前登录（即使它没被存成账号）
  const currentText = readText(paths.authPath)
  if (currentText !== '') {
    try { fs.writeFileSync(previousAuthFile(dataDir), currentText, { mode: 0o600 }) } catch { /* 备份失败不阻止切换 */ }
  }

  const account = store.accounts[index]
  writeAuth(paths.authPath, buildAuthJson(account))

  store.accounts[index] = { ...account, lastUsedAt: new Date().toISOString() }
  writeStore(dataDir, store)

  return { ok: true, message: `已切换到 ${account.label}`, account: store.accounts[index] }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}

/** 删除一个账号（只删我们存的副本，不动 auth.json）。 */
export function removeAccount({ dataDir, accountId } = {}) {
  const store = readStore(dataDir)
  const next = store.accounts.filter(entry => entry.id !== accountId)
  if (next.length === store.accounts.length) return { ok: false, message: '账号不存在' }
  writeStore(dataDir, { accounts: next })
  return { ok: true, message: '已删除' }
}

/**
 * 用 refresh_token 刷新某个账号的 access_token。
 *
 * @returns {{ok:boolean, message:string}}
 */
export async function refreshAccount({ dataDir, accountId, fetchImpl = fetch } = {}) {
  const store = readStore(dataDir)
  const index = store.accounts.findIndex(entry => entry.id === accountId)
  if (index === -1) return { ok: false, message: '账号不存在' }

  const account = store.accounts[index]
  const refreshToken = account.tokens?.refresh_token
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    return { ok: false, message: '这个账号没有 refresh_token，需要重新登录' }
  }

  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  })

  const response = await fetchImpl(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT },
    body: form.toString(),
  })

  const text = await response.text()
  if (!response.ok) {
    return { ok: false, message: `刷新失败：HTTP ${response.status} ${text.slice(0, 160)}` }
  }

  let payload
  try { payload = JSON.parse(text) } catch {
    return { ok: false, message: '刷新响应不是 JSON' }
  }

  const tokens = {
    ...account.tokens,
    access_token: String(payload.access_token ?? account.tokens.access_token),
    refresh_token: String(payload.refresh_token ?? refreshToken),
    id_token: String(payload.id_token ?? account.tokens.id_token ?? ''),
  }

  store.accounts[index] = { ...account, tokens }
  writeStore(dataDir, store)

  return { ok: true, message: '已刷新（若它正是当前账号，切换一次即可生效）' }
}

/** 切换前的 auth.json 备份（供「切回来」用）。 */
export function readPreviousAuth({ dataDir } = {}) {
  return readText(previousAuthFile(dataDir))
}

/**
 * 清除「API Key 登录」，让 Codex 回到账号登录。
 *
 * ## 什么时候需要它
 *
 * Codex 判断登录方式时，**只要看到 `auth.json.OPENAI_API_KEY`（或环境变量
 * `OPENAI_API_KEY`）就进入 API key 模式**，账号登录入口随之消失。
 * 用户在外部工具里填过 API Key、或早期工具直接把 Key 写进 auth.json 之后，
 * 就会卡在「退不出 API 登录」的状态。
 *
 * 这里只做一件事：把 `OPENAI_API_KEY` 清成 null、`auth_mode` 改回 `chatgpt`。
 * **ChatGPT 的 tokens 一个字节都不动** —— 清完重启 Codex 就能看到账号登录。
 *
 * 动手前把原文件备份到 app 数据目录，清错了还能拿回来。
 */
export function clearApiKeyAuth({ dataDir, env, home } = {}) {
  const paths = resolveCodexPaths({ env, home })
  const text = readText(paths.authPath)
  if (text === '') {
    return { ok: false, message: 'auth.json 不存在，Codex 本来就没有登录态' }
  }

  let auth
  try { auth = JSON.parse(text) } catch {
    return { ok: false, message: 'auth.json 不是合法 JSON，为避免弄坏它，已放弃' }
  }

  const apiKey = typeof auth.OPENAI_API_KEY === 'string' ? auth.OPENAI_API_KEY : ''
  const hasTokens = typeof auth.tokens?.access_token === 'string' && auth.tokens.access_token !== ''
  const mode = typeof auth.auth_mode === 'string' ? auth.auth_mode : ''

  if (apiKey === '' && mode !== 'apikey') {
    return {
      ok: true,
      changed: false,
      message: hasTokens
        ? '没有 API Key 登录；账号登录应该可用（重启 Codex 试试）'
        : '没有 API Key 登录；但也没有 ChatGPT 登录，需要重新登录',
    }
  }

  // 备份原文件
  try {
    fs.writeFileSync(path.join(dataDir, 'codex-auth.apikey.backup.json'), text, { mode: 0o600 })
  } catch {
    // 备份失败不阻止：这一步本身可逆（重新填一次 Key 即可）
  }

  const next = {
    ...auth,
    OPENAI_API_KEY: null,
    // 有 ChatGPT token 就切回 chatgpt 模式；没有则保持 chatgpt 让 Codex 引导登录
    auth_mode: 'chatgpt',
  }

  writeAuth(paths.authPath, next)

  return {
    ok: true,
    changed: true,
    message: hasTokens
      ? '已清除 API Key 登录，ChatGPT 登录态保留 —— 重启 Codex 即可用账号登录'
      : '已清除 API Key 登录，重启 Codex 后走账号登录',
  }
}
