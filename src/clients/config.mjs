/** Native client configuration, following CC Switch's key-field-only approach.
 * No shell execution, credential discovery or edits to account/MCP stores.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { parse, modify, applyEdits, printParseErrorCode } from 'jsonc-parser'
import * as codex from '../codex/config.mjs'

export const DESKTOP_MODEL = 'claude-sonnet-4-5'
export const CLIENTS = [
  { id: 'codex', name: 'Codex', kind: 'Responses', note: '桌面版与 CLI 共用配置；保留官方登录态。' },
  { id: 'claude', name: 'Claude Code', kind: 'Messages', note: '只更新连接、模型与鉴权字段，保留 permissions、hooks 和插件。' },
  { id: 'claude-desktop', name: 'Claude Desktop', kind: 'Messages', mode: 'in-app', note: '在桌面应用内配置 Third-Party Inference / Gateway，不读取 CLI 的 settings.json 作为桌面网关配置。这里仅准备参数与模型映射；应用内测试连接并应用后才生效，管理员策略可能将该表单设为只读。' },
  { id: 'gemini', name: 'Gemini CLI', kind: 'Gemini', note: '同步写入 .env 与 settings.json；项目级配置或终端环境变量可能覆盖全局设置。' },
  { id: 'opencode', name: 'OpenCode', kind: 'Chat Completions', note: '新增 codex-relay provider，保留其他供应商、MCP 与现有登录。' },
]

const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const hash = text => crypto.createHash('sha256').update(text ?? '').digest('hex')
const read = file => {
  try { return fs.readFileSync(file, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}
function atomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp, text, { mode: 0o600, flag: 'wx' })
    fs.renameSync(temp, file)
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
}
function object(text, file) {
  const errors = []
  const value = parse(text ?? '{}', errors, { allowTrailingComma: true })
  if (errors.length || !value || Array.isArray(value) || typeof value !== 'object') {
    throw fail(`配置解析失败：${file}${errors.length ? ` (${printParseErrorCode(errors[0].error)} @ ${errors[0].offset})` : '，根节点应为对象'}；原文件未修改`)
  }
  return value
}
function at(value, keys) { return keys.reduce((v, k) => v?.[k], value) }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
function patchJson(text, changes, file) {
  let next = text ?? '{}\n'
  const current = object(next, file)
  for (const { keys, value } of changes) {
    // Reject unexpected container types rather than silently replacing user data.
    for (let i = 1; i < keys.length; i++) {
      const parent = at(current, keys.slice(0, i))
      if (parent !== undefined && (!parent || Array.isArray(parent) || typeof parent !== 'object')) {
        throw fail(`配置字段 ${keys.slice(0, i).join('.')} 应为对象：${file}`)
      }
    }
    next = applyEdits(next, modify(next, keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: next.includes('\r\n') ? '\r\n' : '\n' } }))
  }
  return next
}
const envMatch = key => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`)
function envValue(text, key) { return (text ?? '').split(/\r?\n/).filter(line => envMatch(key).test(line)).join('\n') }
function patchEnv(text, changes) {
  const eol = text?.includes('\r\n') ? '\r\n' : '\n'
  const lines = (text ?? '').split(/\r?\n/)
  for (const { keys: [key], value } of changes) {
    const indices = lines.flatMap((line, i) => envMatch(key).test(line) ? [i] : [])
    const replacement = value === undefined ? null : `${key}=${JSON.stringify(String(value))}`
    for (const i of [...indices].reverse()) lines.splice(i, 1)
    if (replacement !== null) lines.splice(indices[0] ?? (lines.at(-1) === '' ? lines.length - 1 : lines.length), 0, replacement)
  }
  return lines.join(eol).replace(/(?:\r?\n)?$/, eol)
}
const change = (keys, value) => ({ keys: keys.split('.'), value })
function context(options) {
  const home = options.home ?? os.homedir()
  const env = options.env ?? process.env
  const config = env.XDG_CONFIG_HOME || path.join(home, '.config')
  return { home, env, config }
}
function plan(id, options) {
  const { home, env, config } = context(options)
  const { gatewayUrl, apiKey, model } = options
  const root = gatewayUrl.replace(/\/$/, '')
  const json = (file, changes) => ({ file, format: 'json', changes })
  if (id === 'claude') {
    return [json(path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json'), [
      change('env.ANTHROPIC_BASE_URL', root), change('env.ANTHROPIC_AUTH_TOKEN', apiKey),
      change('env.ANTHROPIC_API_KEY', undefined), change('env.ANTHROPIC_MODEL', model), change('model', model),
      ...['HAIKU', 'SONNET', 'OPUS'].map(role => change(`env.ANTHROPIC_DEFAULT_${role}_MODEL`, model)),
      ...['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].map(key => change(`env.${key}`, undefined)),
      change('apiKeyHelper', undefined),
    ])]
  }
  if (id === 'gemini') {
    const dir = path.join(home, '.gemini')
    return [
      { file: path.join(dir, '.env'), format: 'env', changes: [change('GEMINI_API_KEY', apiKey), change('GOOGLE_GEMINI_BASE_URL', root), change('GEMINI_MODEL', model), change('GOOGLE_GENAI_USE_VERTEXAI', undefined)] },
      json(path.join(dir, 'settings.json'), [change('security.auth.selectedType', 'gemini-api-key'), change('model.name', model)]),
    ]
  }
  if (id === 'opencode') {
    const dir = env.OPENCODE_CONFIG_DIR || path.join(config, 'opencode')
    const file = fs.existsSync(path.join(dir, 'opencode.jsonc')) ? path.join(dir, 'opencode.jsonc') : path.join(dir, 'opencode.json')
    return [json(file, [change('provider.codex-relay', {
      npm: '@ai-sdk/openai-compatible', name: 'BaiUse',
      options: { baseURL: `${root}/v1`, apiKey }, models: { [model]: { name: model } },
    }), change('model', `codex-relay/${model}`)])]
  }
  throw fail(`未知客户端：${id}`, 404)
}
function markerFile(id, options) { return path.join(options.dataDir, 'client-backups', `${id}.json`) }
function marker(id, options) {
  const text = read(markerFile(id, options))
  return text === null ? null : JSON.parse(text)
}
function validate(id, options) {
  if (!CLIENTS.some(client => client.id === id)) throw fail(`未知客户端：${id}`, 404)
  if (typeof options.model !== 'string' || !options.model.trim() || /[\x00-\x1f]/.test(options.model) || options.model.length > 512) throw fail('请选择一个可用模型')
}
function codexOptions(options) { return { ...options, baseUrl: `${options.gatewayUrl.replace(/\/$/, '')}/v1` } }

export function clientPreview(id, options) {
  validate(id, options)
  if (id === 'claude-desktop') {
    return { mode: 'in-app', files: [{ path: 'Claude Desktop · Gateway 参数', content: JSON.stringify({
      inferenceProvider: 'gateway', inferenceGatewayBaseUrl: `${options.gatewayUrl}/claude-desktop`,
      inferenceGatewayAuthScheme: 'bearer', inferenceGatewayApiKey: options.apiKey,
      inferenceModels: [{ name: DESKTOP_MODEL, labelOverride: options.model }],
    }, null, 2) }], note: CLIENTS.find(client => client.id === id).note }
  }
  if (id === 'codex') {
    const preview = codex.preview(codexOptions(options))
    return { files: [{ path: codex.resolveCodexPaths(options).configPath, content: preview.after }], note: CLIENTS[0].note }
  }
  const files = plan(id, options).map(entry => ({ path: entry.file, content: entry.format === 'env' ? patchEnv(read(entry.file), entry.changes) : patchJson(read(entry.file), entry.changes, entry.file) }))
  return { files, note: CLIENTS.find(client => client.id === id).note }
}

/** All files are parsed and snapshotted before the first write. Roll back on I/O failure. */
function transaction(writes) {
  const before = writes.map(entry => ({ file: entry.file, text: read(entry.file) }))
  try {
    for (const entry of writes) {
      if (entry.text === null) fs.rmSync(entry.file, { force: true })
      else atomic(entry.file, entry.text)
    }
  } catch (error) {
    const recoveryErrors = []
    for (const entry of before.reverse()) {
      try {
        if (entry.text === null) fs.rmSync(entry.file, { force: true })
        else atomic(entry.file, entry.text)
      } catch (recoveryError) { recoveryErrors.push(recoveryError) }
    }
    if (recoveryErrors.length) throw Object.assign(new Error(`${error.message}；部分文件仍需还原，恢复日志已保留`), { recoveryRequired: true })
    throw error
  }
}
export function connectClient(id, options) {
  validate(id, options)
  // Desktop's supported local flow is its in-app third-party inference form.
  // Preparation deliberately never writes Claude/Claude-3p deployment profiles.
  if (id === 'claude-desktop') return { ok: true, mode: 'in-app', prepared: true, model: options.model, files: [] }
  if (id === 'codex') return codex.connect(codexOptions(options))
  const previous = marker(id, options)
  const files = plan(id, options).map(entry => {
    if (fs.existsSync(entry.file) && fs.lstatSync(entry.file).isSymbolicLink()) throw fail(`配置文件是符号链接，请先在目标目录管理配置：${entry.file}；未修改原文件`)
    const before = read(entry.file)
    const original = previous?.files.find(file => file.file === entry.file)?.original ?? { text: before }
    const applied = entry.format === 'env' ? patchEnv(before, entry.changes) : patchJson(before, entry.changes, entry.file)
    return { ...entry, original, applied }
  })
  // Persist a recovery journal (including originals) BEFORE touching client files.
  atomic(markerFile(id, options), JSON.stringify({ version: 1, state: 'pending', model: options.model, files }, null, 2))
  try {
    transaction(files.map(file => ({ file: file.file, text: file.applied })))
  } catch (error) {
    if (!error.recoveryRequired) {
      if (previous) atomic(markerFile(id, options), JSON.stringify(previous))
      else fs.rmSync(markerFile(id, options), { force: true })
    }
    throw error
  }
  // If this bookkeeping write fails, the pending journal must remain: client
  // files were written and deleting the journal would lose their originals.
  atomic(markerFile(id, options), JSON.stringify({ version: 1, state: 'applied', model: options.model, files }, null, 2))
  return { ok: true, files: files.map(file => file.file), backupPath: markerFile(id, options), restartRequired: true }
}

export function restoreClient(id, options) {
  if (!CLIENTS.some(client => client.id === id)) throw fail('未知客户端', 404)
  if (id === 'claude-desktop') return { ok: true, mode: 'in-app', message: '已清除网关模型映射；桌面应用内的设置需在应用内撤销' }
  if (id === 'codex') return codex.disconnect(options)
  const backup = marker(id, options)
  if (!backup) return { ok: true, mode: 'noop' }
  const writes = backup.files.map(entry => {
    const current = read(entry.file)
    const original = entry.original.text
    if (current === entry.applied || current === original) return { file: entry.file, text: original }
    // Keep later, unrelated edits. Refuse to overwrite competing changes in our fields.
    if (entry.format === 'env') {
      let next = current ?? ''
      for (const { keys: [key] } of entry.changes) {
        const now = envValue(current, key)
        if (now !== envValue(entry.applied, key) && now !== envValue(original, key)) throw fail(`还原冲突：${entry.file} 的 ${key} 已被其他程序修改；备份已保留`, 409)
        const lines = next.split(/\r?\n/).filter(line => !envMatch(key).test(line))
        const old = envValue(original, key)
        if (old) lines.splice(Math.max(0, lines.length - 1), 0, old)
        next = lines.join(current?.includes('\r\n') ? '\r\n' : '\n')
      }
      return { file: entry.file, text: next }
    }
    const now = object(current, entry.file)
    const old = object(original, entry.file)
    const applied = object(entry.applied, entry.file)
    const changes = entry.changes.map(({ keys }) => {
      if (!same(at(now, keys), at(applied, keys)) && !same(at(now, keys), at(old, keys))) throw fail(`还原冲突：${entry.file} 的 ${keys.join('.')} 已被其他程序修改；备份已保留`, 409)
      return { keys, value: at(old, keys) }
    })
    return { file: entry.file, text: patchJson(current, changes, entry.file) }
  })
  transaction(writes)
  fs.rmSync(markerFile(id, options), { force: true })
  return { ok: true, mode: 'restored', restartRequired: true }
}

export function listClients(options) {
  return CLIENTS.map(client => {
    try {
      if (client.id === 'claude-desktop') {
        const activity = options.desktopActivity
        const prepared = !!options.desktopModel
        return { ...client, paths: [], managed: prepared, configured: false, prepared, observed: prepared && activity?.model === options.desktopModel, lastRequestAt: activity?.at ?? null, model: options.desktopModel ?? '' }
      }
      if (client.id === 'codex') {
        const status = codex.getStatus(options)
        return { ...client, managed: status.managed, configured: status.active && !status.drifted && status.ourBaseUrl === `${options.gatewayUrl}/v1`, paths: [status.paths.configPath], model: status.currentModel }
      }
      const saved = marker(client.id, options)
      const paths = plan(client.id, { ...options, model: saved?.model || 'model' }).map(entry => entry.file)
      return { ...client, paths, managed: !!saved, configured: saved?.state === 'applied' && saved.files.every(entry => hash(read(entry.file)) === hash(entry.applied)), model: saved?.model ?? '', backupPath: saved ? markerFile(client.id, options) : null }
    } catch (error) { return { ...client, managed: fs.existsSync(markerFile(client.id, options)), configured: false, paths: [], error: error.message } }
  })
}
