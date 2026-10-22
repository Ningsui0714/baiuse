/**
 * 设置存储 —— 一个带原子写的 JSON 文件。
 *
 * 存在哪：
 *   macOS  `~/Library/Application Support/OFM Codex Gateway/`
 *   其他  `$XDG_CONFIG_HOME/ofm-codex-gateway/` 或 `~/.config/ofm-codex-gateway/`
 *
 * 里面有什么：
 *   - `apiKey`        本网关的 API Key（Codex 用它连进来）
 *   - `aggregate`     聚合车道配置：provider → { baseUrl, apiKey, models[] }
 *   - `egress`        出口设置（代理）
 *   - `hiddenModels`  用户隐藏的模型
 *
 * 凭据（各渠道的 token）不在这里 —— 那些由渠道包自己管理，
 * 落在 `dataDir/channel-credentials.json`（0600）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 默认数据目录。 */
export function resolveDataDir(env = process.env, home = os.homedir()) {
  const override = typeof env.OFM_GATEWAY_HOME === 'string' ? env.OFM_GATEWAY_HOME.trim() : ''
  if (override !== '') return path.resolve(override)

  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'OFM Codex Gateway')
  }
  const xdg = typeof env.XDG_CONFIG_HOME === 'string' ? env.XDG_CONFIG_HOME.trim() : ''
  if (xdg !== '') return path.join(xdg, 'ofm-codex-gateway')
  return path.join(home, '.config', 'ofm-codex-gateway')
}

const DEFAULTS = {
  version: 1,
  apiKey: '',
  port: 48760,
  aggregate: {},
  egress: { mode: 'direct' },
  hiddenModels: [],
}

/** 生成一个 API Key。 */
export function generateKey() {
  return `ofm-${crypto.getRandomValues(new Uint8Array(24)).reduce((hex, byte) => hex + byte.toString(16).padStart(2, '0'), '')}`
}

/**
 * 创建设置存储。
 *
 * @param {string} dataDir
 * @returns {{get: () => object, update: (patch: object) => object, flush: () => void, value: object}}
 */
export function createSettings(dataDir) {
  const file = path.join(dataDir, 'settings.json')
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })

  let value = { ...DEFAULTS }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed !== null && typeof parsed === 'object') {
      value = { ...DEFAULTS, ...parsed }
    }
  } catch {
    // 读不出来就用默认值（首次启动的正常情况）
  }
  if (typeof value.apiKey !== 'string' || value.apiKey === '') {
    value.apiKey = generateKey()
  }

  /** 原子写：临时文件 + rename。避免写到一半被读到半个 JSON。 */
  const flush = () => {
    const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    try {
      fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
      fs.renameSync(temp, file)
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp)
    }
  }

  return {
    file,
    get: () => value,
    update(patch) {
      value = { ...value, ...patch }
      flush()
      return value
    },
    flush,
    get value() { return value },
  }
}
