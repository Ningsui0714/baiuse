/**
 * 统一路由的单元测试。
 *
 * 重点覆盖两个上游仓库踩过的坑：
 *  - 提交规则（reasoning 不算提交 → 「想了一分钟才撞配额墙」要能换路）
 *  - 限流解禁时间取更长者（短兜底值不能覆盖长真值）
 * 以及轮询游标不串位、最后候选永不跳过、会话粘性。
 *
 * 用 node:test 跑：`node --test src/`
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CooldownLedger,
  RotationCursor,
  SessionAffinity,
  buildCandidates,
  classifyCooldownReason,
  selectCandidate,
  shouldFailover,
} from './route.js'

/* ------------------------------------------------------------------ *
 * 候选集构建
 * ------------------------------------------------------------------ */

test('buildCandidates: 精确匹配 provider/model 优先于同名裸模型', () => {
  const rows = [
    { id: 'cline/glm-5', owned_by: 'cline' },
    { id: 'glm-5', owned_by: 'free' },
    { id: 'trae/glm-5', owned_by: 'trae' },
  ]
  const candidates = buildCandidates(rows, { model: 'glm-5' })
  assert.equal(candidates[0].id, 'glm-5', '裸名精确匹配应排最前')
  assert.equal(candidates[0].provider, 'free')
  assert.ok(candidates.some(c => c.id === 'cline/glm-5'), '同名 provider 版本也要进候选')
  assert.ok(candidates.some(c => c.id === 'trae/glm-5'))
})

test('buildCandidates: provider/model 全等时精确优先', () => {
  const rows = [{ id: 'cline/glm-5' }, { id: 'trae/glm-5' }]
  const candidates = buildCandidates(rows, { model: 'trae/glm-5' })
  assert.equal(candidates[0].id, 'trae/glm-5')
  assert.equal(candidates[0].priority, 0)
  assert.equal(candidates[0].routeKey, 'trae/glm-5')
})

test('buildCandidates: 不匹配的模型返回空集', () => {
  assert.deepEqual(buildCandidates([{ id: 'a/b' }], { model: 'nope' }), [])
  assert.deepEqual(buildCandidates(undefined, { model: 'x' }), [])
})

/* ------------------------------------------------------------------ *
 * 选择：软约束 + 最后候选永不跳过
 * ------------------------------------------------------------------ */

test('selectCandidate: 跳过已试过与冷却中的候选', () => {
  const now = 1_000_000
  const cooldowns = new CooldownLedger(() => now)
  cooldowns.mark('trae/glm-5', 'rateLimited')

  const candidates = [
    { id: 'trae/glm-5', provider: 'trae', model: 'glm-5', routeKey: 'trae/glm-5' },
    { id: 'cline/glm-5', provider: 'cline', model: 'glm-5', routeKey: 'cline/glm-5' },
  ]
  const picked = selectCandidate(candidates, { tried: new Set(), cooldowns })
  assert.equal(picked.id, 'cline/glm-5', '冷却中的 trae 应被跳过')
})

test('selectCandidate: 全部不可用时退回最后一个候选以保留可诊断性', () => {
  const now = 1_000_000
  const cooldowns = new CooldownLedger(() => now)
  const candidates = [
    { id: 'a/1', provider: 'a', model: '1', routeKey: 'a/1' },
    { id: 'b/1', provider: 'b', model: '1', routeKey: 'b/1' },
  ]
  cooldowns.mark('a/1', 'rateLimited')
  cooldowns.mark('b/1', 'rateLimited')
  const picked = selectCandidate(candidates, { tried: new Set(), cooldowns })
  assert.equal(picked.id, 'b/1', '应退回最后一个候选，而不是 undefined')
})

test('selectCandidate: 全部已试过也返回最后候选', () => {
  const candidates = [
    { id: 'a/1', provider: 'a', model: '1', routeKey: 'a/1' },
    { id: 'b/1', provider: 'b', model: '1', routeKey: 'b/1' },
  ]
  const picked = selectCandidate(candidates, { tried: new Set(['a/1', 'b/1']) })
  assert.equal(picked.id, 'b/1')
})

test('selectCandidate: 会话粘性优先于轮询', () => {
  const candidates = [
    { id: 'a/1', provider: 'a', model: '1', routeKey: 'a/1' },
    { id: 'b/1', provider: 'b', model: '1', routeKey: 'b/1' },
  ]
  const picked = selectCandidate(candidates, { tried: new Set(), pinned: 'b/1' })
  assert.equal(picked.id, 'b/1')
})

test('selectCandidate: 粘性的路已试过则不再使用粘性', () => {
  const candidates = [
    { id: 'a/1', provider: 'a', model: '1', routeKey: 'a/1' },
    { id: 'b/1', provider: 'b', model: '1', routeKey: 'b/1' },
  ]
  const picked = selectCandidate(candidates, { tried: new Set(['b/1']), pinned: 'b/1' })
  assert.equal(picked.id, 'a/1')
})

/* ------------------------------------------------------------------ *
 * 轮询游标：标记 id 而非下标
 * ------------------------------------------------------------------ */

test('RotationCursor: 候选列表缩短后不串位', () => {
  const cursor = new RotationCursor()
  const first = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.equal(cursor.pick(first), 0) // a
  assert.equal(cursor.pick(first), 1) // b

  // 池收缩：a 被移除
  const shrunk = [{ id: 'b' }, { id: 'c' }]
  const index = cursor.pick(shrunk)
  assert.equal(shrunk[index].id, 'c', '游标应按 id 找到 b 并取下一个 c')
})

test('RotationCursor: 池扩容后仍按 id 定位', () => {
  const cursor = new RotationCursor()
  const list = [{ id: 'a' }, { id: 'b' }]
  cursor.pick(list) // a
  const grown = [{ id: 'x' }, { id: 'a' }, { id: 'b' }]
  const index = cursor.pick(grown)
  assert.equal(grown[index].id, 'b')
})

/* ------------------------------------------------------------------ *
 * 冷却账本：解禁时间取更长者
 * ------------------------------------------------------------------ */

test('CooldownLedger: 短兜底值不得覆盖已记录的长解禁时间', () => {
  let now = 1_000_000
  const ledger = new CooldownLedger(() => now)
  // 先记一个长的（真实值 19h39m）
  ledger.mark('k', 'rateLimited')
  const long = ledger.untilOf('k')
  now += 1000
  // 再记一次 —— 阶梯会升级，但绝不该缩短
  ledger.mark('k', 'rateLimited')
  const after = ledger.untilOf('k')
  assert.ok(after >= long, '解禁时间不得变早')
})

test('CooldownLedger: 429 按阶梯升级', () => {
  let now = 1_000_000
  const ledger = new CooldownLedger(() => now)
  const first = ledger.mark('k', 'rateLimited')
  assert.equal(first - now, 45_000)
  now = first
  const second = ledger.mark('k', 'rateLimited')
  assert.equal(second - now, 300_000, '第二次 429 应升到 5 分钟')
})

test('CooldownLedger: 久未犯规则重新计数', () => {
  let now = 1_000_000
  const ledger = new CooldownLedger(() => now)
  ledger.mark('k', 'rateLimited')
  now += 31 * 60 * 1000 // 超过遗忘窗口
  const again = ledger.mark('k', 'rateLimited')
  assert.equal(again - now, 45_000, '新的一轮应回到第一档')
})

test('CooldownLedger: 不同错误类别冷却时长不同', () => {
  const now = 1_000_000
  const ledger = new CooldownLedger(() => now)
  assert.equal(ledger.mark('a', 'challenge') - now, 6_000)
  assert.equal(ledger.mark('b', 'upstream5xx') - now, 30_000)
  assert.equal(ledger.mark('c', 'default') - now, 20_000)
})

/* ------------------------------------------------------------------ *
 * 失败分类
 * ------------------------------------------------------------------ */

test('classifyCooldownReason: 验证码先于限流判定', () => {
  assert.equal(classifyCooldownReason({ status: 429, message: 'captcha required' }), 'challenge')
})

test('classifyCooldownReason: 识别常见限流形态', () => {
  assert.equal(classifyCooldownReason({ status: 429 }), 'rateLimited')
  assert.equal(classifyCooldownReason({ code: 'RATE_LIMIT' }), 'rateLimited')
  assert.equal(classifyCooldownReason({ message: 'Rate limit exceeded' }), 'rateLimited')
  assert.equal(classifyCooldownReason({ status: 503 }), 'upstream5xx')
  assert.equal(classifyCooldownReason({ status: 400 }), 'upstream4xx')
  assert.equal(classifyCooldownReason({ message: 'fetch failed' }), 'network')
})

/* ------------------------------------------------------------------ *
 * 提交规则：决定要不要换路
 * ------------------------------------------------------------------ */

test('shouldFailover: 未提交前的配额墙要换路', () => {
  const error = { status: 429, message: 'Rate limit exceeded' }
  assert.equal(shouldFailover(error, false), true, '未提交 → 应换路')
})

test('shouldFailover: 已提交后不再换路', () => {
  const error = { status: 429, message: 'Rate limit exceeded' }
  assert.equal(shouldFailover(error, true), false, '已吐过内容 → 换路会让用户看到拼接的半截回答')
})

test('shouldFailover: 明确的客户端错误不换路', () => {
  assert.equal(shouldFailover({ status: 400, message: 'bad request' }, false), false)
  assert.equal(shouldFailover({ status: 404, message: 'model not found' }, false), false)
})

test('shouldFailover: 服务端错误要换路', () => {
  assert.equal(shouldFailover({ status: 502, message: 'bad gateway' }, false), true)
})

/* ------------------------------------------------------------------ *
 * 会话粘性
 * ------------------------------------------------------------------ */

test('SessionAffinity: 绑定后可读回，失败后可解绑', () => {
  const affinity = new SessionAffinity()
  affinity.set('sess-1', 'cline/glm-5')
  assert.equal(affinity.get('sess-1'), 'cline/glm-5')
  affinity.unbind('sess-1')
  assert.equal(affinity.get('sess-1'), undefined)
})

test('SessionAffinity: 过期后不再返回绑定', () => {
  const affinity = new SessionAffinity({ ttlMs: 1 })
  affinity.set('sess-1', 'a/1')
  // ttlMs=1，1ms 后过期；同步等待略大于 1ms
  const until = Date.now() + 5
  while (Date.now() < until) { /* spin */ }
  assert.equal(affinity.get('sess-1'), undefined)
})

test('SessionAffinity: 无 key 时不绑定', () => {
  const affinity = new SessionAffinity()
  affinity.set(undefined, 'a/1')
  assert.equal(affinity.get(undefined), undefined)
})
