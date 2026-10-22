/**
 * Codex 历史会话的 provider 迁移。
 *
 * ## 为什么要管这个
 *
 * Codex 把每个会话的 `model_provider` 记在 `state_5.sqlite` 的 `threads` 表里。
 * 接管时我们把顶层 `model_provider` 改成了 `ofm`，但**旧会话那一行的值不变**。
 *
 * 两个方向各有一个坑：
 *
 * - 接管后打开旧会话 → 它仍指向 `openai`（内置，存在），能开，但走的是官方登录
 * - **撤销接管后**打开接管期间新建的会话 → 它指向 `ofm`，而 `ofm` 已经不存在了
 *
 * 所以迁移只在**撤销时**做：把 `ofm` 改回接管前的 provider，避免悬空引用。
 * 接管时不动 —— 用户的老会话按原样走官方没有什么损失。
 *
 * ## 为什么用 sqlite3 命令行
 *
 * 这个 app 刻意零运行时依赖，引一个 native sqlite 模块会带来编译/架构问题。
 * macOS 与主流 Linux 都自带 `sqlite3`。没有就跳过并如实报告，不假装成功。
 *
 * @module src/codex/state-db
 */

import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

/** 把值转成 SQL 字符串字面量（单引号转义）。 */
function sqlLiteral(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`
}

/** sqlite3 命令是否可用。 */
export function hasSqliteCli() {
  try {
    execFileSync('sqlite3', ['--version'], { stdio: 'pipe', timeout: 5000 })
    return true
  } catch {
    return false
  }
}

function run(dbPath, sql, { readonly = false } = {}) {
  const args = []
  if (readonly) args.push('-readonly')
  args.push(dbPath, sql)
  return execFileSync('sqlite3', args, {
    encoding: 'utf8',
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/** 这个库有没有 `threads` 表。 */
export function hasThreadsTable(dbPath) {
  if (!fs.existsSync(dbPath)) return false
  try {
    const out = run(dbPath, "SELECT name FROM sqlite_master WHERE type='table' AND name='threads';", { readonly: true })
    return out === 'threads'
  } catch {
    return false
  }
}

/**
 * 统计各 provider 的会话数。
 *
 * @returns {Array<{provider:string, count:number}>}
 */
export function listProviderCounts(dbPath) {
  if (!hasThreadsTable(dbPath)) return []
  try {
    const out = run(dbPath, 'SELECT model_provider, COUNT(*) FROM threads GROUP BY model_provider;', { readonly: true })
    if (out === '') return []
    return out.split('\n').map(line => {
      const [provider, count] = line.split('|')
      return { provider: provider ?? '', count: Number(count) || 0 }
    })
  } catch {
    return []
  }
}

/**
 * 把 `from` 的会话改挂到 `to`。
 *
 * @returns {{ok:boolean, updated:number, message:string}}
 */
export function migrateThreads(dbPath, from, to) {
  if (typeof from !== 'string' || from === '' || typeof to !== 'string' || to === '') {
    return { ok: false, updated: 0, message: 'from / to 都必须是非空字符串' }
  }
  if (from === to) return { ok: true, updated: 0, message: '无需迁移' }
  if (!fs.existsSync(dbPath)) return { ok: false, updated: 0, message: '找不到 state_5.sqlite' }
  if (!hasSqliteCli()) return { ok: false, updated: 0, message: '本机没有 sqlite3 命令，已跳过历史会话迁移' }
  if (!hasThreadsTable(dbPath)) return { ok: false, updated: 0, message: '这个库里没有 threads 表' }

  try {
    // changes() 只反映本语句影响的行数，所以放在同一条命令里
    const out = run(
      dbPath,
      `UPDATE threads SET model_provider = ${sqlLiteral(to)} WHERE model_provider = ${sqlLiteral(from)};\nSELECT changes();`,
    )
    const updated = Number(out.split('\n').pop()) || 0
    return { ok: true, updated, message: updated === 0 ? `没有属于 ${from} 的会话` : `已迁移 ${updated} 个会话` }
  } catch (error) {
    return { ok: false, updated: 0, message: `迁移失败：${error?.message ?? error}` }
  }
}
