/**
 * 管理 API 的契约测试。
 *
 * 这里盯的是「**前后端契约**」而不是业务逻辑：
 * 渠道包的 RPC 有它的信封格式（`{ok, value}`）、方法名与载荷形状，
 * 任何一处对不上都会表现为「页面点了没反应」或「列表永远空」——
 * 这类 bug 不抛异常、不打日志，最难发现。
 *
 * 三个曾经真实发生的错误，各有一个用例钉住：
 *  1. `account.list` 返回 `{ok, value:{accounts}}`，却被当成 `{accounts}` 读
 *  2. 删除调的是 `account.remove`，而真实方法名是 `account.delete`
 *  3. `account.update` 要 `{accountId, patch}`，平铺字段会被静默忽略
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { createManagementHandler } from './management.js'

/** 起一个只挂管理接口的 HTTP 服务。 */
async function startManagement(app, apiKey = 'test-key') {
  const handler = createManagementHandler({ app, apiKey })
  const server = http.createServer((req, res) => {
    void handler(req, res).then(handled => {
      if (!handled) {
        res.writeHead(404)
        res.end('{}')
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    call: async (path, options = {}) => {
      const response = await fetch(`${base}${path}`, {
        ...options,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          ...(options.headers ?? {}),
        },
      })
      let body
      try { body = await response.json() } catch { body = undefined }
      return { status: response.status, body }
    },
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

/** 造一个假 app：`rpc` 记录调用并返回预设结果。 */
function fakeApp({ rpcResult, providers = ['trae', 'cline'] } = {}) {
  const calls = []
  return {
    calls,
    version: '0.0.0-test',
    dataDir: '/tmp/test-dir',
    url: 'http://127.0.0.1:9999',
    apiKey: 'test-key',
    channels: {
      providers,
      async rpc(request) {
        calls.push(request)
        if (typeof rpcResult === 'function') return rpcResult(request)
        return rpcResult ?? { ok: true, value: undefined }
      },
    },
    lanes: {
      kiloModels: ['k1'],
      aggregateCatalog: () => [],
      modelRows: () => [{ id: 'trae/x' }, { id: 'k1' }],
    },
    settings: {
      get: () => ({ port: 48760, aggregate: {}, apiKey: 'secret' }),
      update: patch => ({ port: 48760, aggregate: {}, ...patch }),
    },
  }
}

/* ------------------------------------------------------------------ *
 * 账号列表：必须拆开 {ok, value}
 * ------------------------------------------------------------------ */

test('GET /api/accounts 正确拆开渠道包的信封', async () => {
  const app = fakeApp({
    // ⚠️ listAccounts 会遍历**每个** provider 各调一次 account.list，
    // 假 rpc 若对所有 provider 返回同一份数据，账号就会重复。
    providers: ['trae'],
    rpcResult: {
      ok: true,
      value: {
        accounts: [{
          id: 'trae-1',
          provider: 'trae',
          nickname: '我的 TRAE',
          enabled: true,
          modelRateLimits: {},
        }],
      },
    },
  })
  const server = await startManagement(app)
  try {
    const { status, body } = await server.call('/api/accounts')
    assert.equal(status, 200)
    assert.equal(body.accounts.length, 1, '账号列表不能为空 —— 说明信封没拆开')
    assert.equal(body.accounts[0].id, 'trae-1')
    assert.equal(body.accounts[0].nickname, '我的 TRAE')
    assert.deepEqual(body.accounts[0].rateLimited, [])
  } finally { await server.close() }
})

test('限流中的账号带出解禁时间', async () => {
  const future = Date.now() + 10 * 60_000
  const app = fakeApp({
    providers: ['trae'],
    rpcResult: {
      ok: true,
      value: { accounts: [{ id: 'trae-1', provider: 'trae', modelRateLimits: { 'glm-5': future } }] },
    },
  })
  const server = await startManagement(app)
  try {
    const { body } = await server.call('/api/accounts')
    assert.equal(body.accounts[0].rateLimited.length, 1)
    assert.equal(body.accounts[0].rateLimited[0].model, 'glm-5')
  } finally { await server.close() }
})

test('账号列表区分授权状态且过滤凭据字段', async () => {
  const app = fakeApp({ providers: ['codearts'], rpcResult: { ok: true, value: { accounts: [
    { id: 'pending', provider: 'codearts', authenticated: false, credentialState: 'missing' },
    { id: 'saved', provider: 'codearts', authenticated: true, credentialState: 'saved', credentialRef: 'PRIVATE_REF', access_token: 'secret' },
  ] } } })
  const server = await startManagement(app)
  try {
    const { body } = await server.call('/api/accounts')
    assert.equal(body.accounts[0].authenticated, false)
    assert.equal(body.accounts[1].authenticated, true)
    assert.equal(body.accounts[0].credentialState, 'missing')
    assert.ok(!JSON.stringify(body).includes('PRIVATE_REF'))
    assert.ok(!JSON.stringify(body).includes('secret'))
  } finally { await server.close() }
})

test('刷新模型目录先刷新账号渠道，再返回合并清单', async () => {
  const app = fakeApp()
  let refreshed = false
  app.channels.refresh = async () => { refreshed = true }
  app.lanes.modelRows = () => { assert.equal(refreshed, true); return [{ id: 'codearts/fixture-deepseek', lane: 'channel' }, { id: 'kilo-auto/free', lane: 'kilo' }] }
  const server = await startManagement(app)
  try {
    const { status, body } = await server.call('/api/models/refresh', { method: 'POST', body: '{}' })
    assert.equal(status, 200)
    assert.equal(body.models[0].id, 'codearts/fixture-deepseek')
    assert.equal(body.models.length, 2)
  } finally { await server.close() }
})

/* ------------------------------------------------------------------ *
 * 新增账号：返回 loginUrl
 * ------------------------------------------------------------------ */

test('POST /api/accounts 返回登录链接', async () => {
  const app = fakeApp({
    rpcResult: { ok: true, value: { accountId: 'trae-9', loginUrl: 'https://example.test/login' } },
  })
  const server = await startManagement(app)
  try {
    const { status, body } = await server.call('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({ provider: 'trae' }),
    })
    assert.equal(status, 200)
    assert.equal(body.account.loginUrl, 'https://example.test/login')
    assert.equal(app.calls[0].method, 'account.create')
    assert.deepEqual(app.calls[0].payload, { provider: 'trae' })
  } finally { await server.close() }
})

test('POST /api/accounts 缺 provider 时 400', async () => {
  const app = fakeApp()
  const server = await startManagement(app)
  try {
    const { status } = await server.call('/api/accounts', { method: 'POST', body: '{}' })
    assert.equal(status, 400)
  } finally { await server.close() }
})

/* ------------------------------------------------------------------ *
 * 改账号：必须是 {accountId, patch}
 * ------------------------------------------------------------------ */

test('POST /api/accounts/:id 把字段放进 patch', async () => {
  const app = fakeApp()
  const server = await startManagement(app)
  try {
    const { status } = await server.call('/api/accounts/trae-1', {
      method: 'POST',
      body: JSON.stringify({ enabled: false }),
    })
    assert.equal(status, 200)
    assert.equal(app.calls[0].method, 'account.update')
    // ⚠️ 平铺会读到 patch === undefined，然后静默变成空操作
    assert.deepEqual(app.calls[0].payload, { accountId: 'trae-1', patch: { enabled: false } })
  } finally { await server.close() }
})

/* ------------------------------------------------------------------ *
 * 删除：方法名必须是 account.delete
 * ------------------------------------------------------------------ */

test('DELETE /api/accounts/:id 调用 account.delete', async () => {
  const app = fakeApp()
  const server = await startManagement(app)
  try {
    const { status } = await server.call('/api/accounts/trae-1', { method: 'DELETE' })
    assert.equal(status, 200)
    assert.equal(app.calls[0].method, 'account.delete', '方法名写错会落到 unknown method 分支')
    assert.deepEqual(app.calls[0].payload, { accountId: 'trae-1' })
  } finally { await server.close() }
})

test('刷新凭据调用 account.refresh', async () => {
  const app = fakeApp()
  const server = await startManagement(app)
  try {
    const { status } = await server.call('/api/accounts/trae-1/refresh', { method: 'POST' })
    assert.equal(status, 200)
    assert.equal(app.calls[0].method, 'account.refresh')
  } finally { await server.close() }
})

/* ------------------------------------------------------------------ *
 * RPC 失败要把错误抛出去，不能当成功
 * ------------------------------------------------------------------ */

test('渠道包返回 ok:false 时透出错误', async () => {
  const app = fakeApp({ rpcResult: { ok: false, error: { message: 'provider 不可用' } } })
  const server = await startManagement(app)
  try {
    const { status, body } = await server.call('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({ provider: 'trae' }),
    })
    assert.equal(status, 400)
    assert.match(body.error.message, /provider 不可用/)
  } finally { await server.close() }
})

/* ------------------------------------------------------------------ *
 * 其它
 * ------------------------------------------------------------------ */

test('GET /api/summary 汇总车道与账号', async () => {
  const app = fakeApp({
    rpcResult: request => ({
      ok: true,
      value: {
        accounts: request.payload.provider === 'trae'
          ? [{ id: 'a', provider: 'trae' }]
          : [],
      },
    }),
  })
  const server = await startManagement(app)
  try {
    const { status, body } = await server.call('/api/summary')
    assert.equal(status, 200)
    assert.deepEqual(body.lanes.channels, ['trae', 'cline'])
    assert.equal(body.lanes.kilo, 1)
    assert.equal(body.accounts.length, 1)
    assert.equal(body.models, 2)
  } finally { await server.close() }
})

test('设置接口不回显聚合车道的 API Key', async () => {
  const app = fakeApp()
  // ⚠️ aggregate 的结构是 {enabled, providers}，不是 {providerId: {...}}
  app.settings.get = () => ({
    port: 48760,
    aggregate: {
      enabled: true,
      providers: { deepseek: { enabled: true, apiKey: 'sk-secret-abcd', baseUrl: 'https://x' } },
    },
  })
  const server = await startManagement(app)
  try {
    const { body } = await server.call('/api/settings')
    const setting = body.settings.aggregate.providers.deepseek
    assert.equal(setting.apiKey, undefined, '真实的 Key 绝不能回显')
    assert.equal(setting.hasKey, true)
    assert.match(setting.keyHint, /sk-s.*abcd/)
    assert.equal(setting.baseUrl, 'https://x')
    assert.equal(body.settings.aggregate.enabled, true, '车道开关不能被掩码逻辑吃掉')
  } finally { await server.close() }
})

test('POST /api/settings 不能覆盖聚合车道（避免掩码回写）', async () => {
  const app = fakeApp()
  let received
  app.settings.update = patch => { received = patch; return { port: 48760 } }
  const server = await startManagement(app)
  try {
    await server.call('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        port: 1234,
        aggregate: { providers: { deepseek: { apiKey: '••••••••' } } },
      }),
    })
    assert.equal(received.aggregate, undefined,
      'aggregate 必须被剥掉 —— 否则前端把掩码回传会把真 Key 覆盖成圆点')
    assert.equal(received.port, 1234)
  } finally { await server.close() }
})

test('POST /api/settings 不允许改 apiKey', async () => {
  const app = fakeApp()
  let received
  app.settings.update = patch => { received = patch; return { port: 48760 } }
  const server = await startManagement(app)
  try {
    await server.call('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ apiKey: 'hacked', port: 1234 }),
    })
    assert.equal(received.apiKey, undefined, 'apiKey 必须被剥掉')
    assert.equal(received.port, 1234)
  } finally { await server.close() }
})

test('未鉴权访问管理接口返回 401', async () => {
  const app = fakeApp()
  const server = await startManagement(app, 'right-key')
  try {
    const response = await fetch(`${server.base}/api/accounts`, {
      headers: { authorization: 'Bearer wrong-key' },
    })
    assert.equal(response.status, 401)
  } finally { await server.close() }
})

test('未知的管理路径返回 404', async () => {
  const app = fakeApp()
  const server = await startManagement(app)
  try {
    const { status } = await server.call('/api/nope')
    assert.equal(status, 404)
  } finally { await server.close() }
})

/* ------------------------------------------------------------------ *
 * 自定义厂商（不在内置目录里的端点）
 * ------------------------------------------------------------------ */

/** 有状态的 settings 替身：update 会真的合并进去。 */
function statefulApp(initial = {}) {
  const app = fakeApp()
  let value = { port: 48760, aggregate: { enabled: true, providers: {}, ...initial }, apiKey: 'test-key' }
  app.settings = {
    get: () => value,
    update: patch => {
      value = { ...value, ...patch }
      if (patch.aggregate !== undefined) value.aggregate = patch.aggregate
      return value
    },
  }
  return app
}

test('自定义厂商：保存定义与 Key，并出现在视图里', async () => {
  const app = statefulApp()
  const server = await startManagement(app)
  try {
    const { status, body } = await server.call('/api/aggregate/custom', {
      method: 'POST',
      body: JSON.stringify({
        id: 'myrelay',
        name: '我的中转站',
        baseUrl: 'https://relay.example.com/v1',
        format: 'openai-chat',
        models: ['gpt-4o', 'gpt-4o', 'claude-x'],
        apiKey: 'sk-custom-1',
      }),
    })
    assert.equal(status, 200)
    const entry = body.providers.find(item => item.id === 'myrelay')
    assert.ok(entry, '自定义厂商要出现在列表里')
    assert.equal(entry.custom, true)
    assert.equal(entry.name, '我的中转站')
    assert.deepEqual(entry.models, ['gpt-4o', 'claude-x'], '模型去重')
    assert.equal(entry.setting.hasKey, true)
    assert.equal(JSON.stringify(body).includes('sk-custom-1'), false, 'Key 不能回显')
  } finally { await server.close() }
})

test('自定义厂商：ID 不合规直接 400', async () => {
  const app = statefulApp()
  const server = await startManagement(app)
  try {
    for (const id of ['A B', '有中文', 'x', '-lead', 'a'.repeat(40)]) {
      const { status } = await server.call('/api/aggregate/custom', {
        method: 'POST',
        body: JSON.stringify({ id, baseUrl: 'https://x/v1', format: 'openai-chat', models: ['m'] }),
      })
      assert.equal(status, 400, `id=${id} 应该被拒`)
    }
  } finally { await server.close() }
})

test('自定义厂商：缺 Base URL 或模型时 400', async () => {
  const app = statefulApp()
  const server = await startManagement(app)
  try {
    const noUrl = await server.call('/api/aggregate/custom', {
      method: 'POST',
      body: JSON.stringify({ id: 'a1', format: 'openai-chat', models: ['m'] }),
    })
    assert.equal(noUrl.status, 400)

    const noModels = await server.call('/api/aggregate/custom', {
      method: 'POST',
      body: JSON.stringify({ id: 'a1', baseUrl: 'https://x/v1', format: 'openai-chat', models: [] }),
    })
    assert.equal(noModels.status, 400)
  } finally { await server.close() }
})

test('自定义厂商：删除时定义与 Key 一起清掉', async () => {
  const app = statefulApp()
  const server = await startManagement(app)
  try {
    await server.call('/api/aggregate/custom', {
      method: 'POST',
      body: JSON.stringify({
        id: 'tmp1', name: 'tmp', baseUrl: 'https://x/v1', format: 'openai-chat', models: ['m'], apiKey: 'k',
      }),
    })
    const removed = await server.call('/api/aggregate/custom/tmp1', { method: 'DELETE' })
    assert.equal(removed.status, 200)
    assert.equal(removed.body.providers.some(item => item.id === 'tmp1'), false)

    const aggregate = app.settings.get().aggregate
    assert.equal(Object.keys(aggregate.customProviders ?? {}).length, 0)
    assert.equal(Object.keys(aggregate.providers ?? {}).length, 0)
  } finally { await server.close() }
})
