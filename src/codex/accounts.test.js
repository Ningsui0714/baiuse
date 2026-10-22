/**
 * Codex 账号管理的测试。
 *
 * 重点：**账号切换会写 `~/.codex/auth.json`** —— 那是用户的登录凭证，
 * 写坏了就是「Codex 突然要重新登录」。所以每条断言都在盯
 * 「写出去的结构对不对」「原来那份有没有留底」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  buildAuthJson,
  captureCurrentAuth,
  decodeIdToken,
  listAccounts,
  pollDeviceLogin,
  refreshAccount,
  removeAccount,
  startDeviceLogin,
  switchAccount,
} from './accounts.mjs'

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

function tempEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-acct-'))
  const codexHome = path.join(root, 'codex')
  const dataDir = path.join(root, 'app')
  fs.mkdirSync(codexHome, { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })
  return { root, codexHome, dataDir, env: { CODEX_HOME: codexHome }, home: root, authPath: path.join(codexHome, 'auth.json') }
}

function b64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function makeIdToken({ email = 'user@example.com', accountId = 'acc-123', plan = 'plus' } = {}) {
  return [
    b64url({ alg: 'none', typ: 'JWT' }),
    b64url({ email, 'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: plan } }),
    'sig',
  ].join('.')
}

/** 假 fetch：按 URL 分派。 */
function fakeFetch(routes) {
  return async (url, init) => {
    for (const [pattern, handler] of routes) {
      if (String(url).includes(pattern)) return handler(url, init)
    }
    throw new Error(`假 fetch 没有匹配：${url}`)
  }
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/* ------------------------------------------------------------------ *
 * id_token 解析
 * ------------------------------------------------------------------ */

test('decodeIdToken 取 email / accountId / plan', () => {
  const info = decodeIdToken(makeIdToken({ email: 'u@x.com', accountId: 'acc-9', plan: 'pro' }))
  assert.equal(info.email, 'u@x.com')
  assert.equal(info.accountId, 'acc-9')
  assert.equal(info.plan, 'pro')
})

test('decodeIdToken 对坏输入返回空值而不是抛错', () => {
  for (const bad of ['', 'x', 'a.b', 'a.!!!.c', null, undefined]) {
    const info = decodeIdToken(bad)
    assert.equal(info.accountId, '')
    assert.equal(info.email, '')
  }
})

/* ------------------------------------------------------------------ *
 * auth.json 结构
 * ------------------------------------------------------------------ */

test('buildAuthJson 产出 Codex 期望的形状', () => {
  const auth = buildAuthJson({
    accountId: 'acc-1',
    tokens: { id_token: 'id', access_token: 'at', refresh_token: 'rt' },
  })
  assert.equal(auth.auth_mode, 'chatgpt')
  assert.equal(auth.OPENAI_API_KEY, null)
  assert.deepEqual(auth.tokens, { id_token: 'id', access_token: 'at', refresh_token: 'rt', account_id: 'acc-1' })
  assert.match(auth.last_refresh, /^\d{4}-\d{2}-\d{2}T/)
})

test('buildAuthJson 对只有 API key 的账号产出 apikey 模式', () => {
  const auth = buildAuthJson({ tokens: { api_key: 'sk-1' } })
  assert.equal(auth.auth_mode, 'apikey')
  assert.equal(auth.OPENAI_API_KEY, 'sk-1')
})

/* ------------------------------------------------------------------ *
 * 记录当前登录
 * ------------------------------------------------------------------ */

test('记录当前登录：存下 token，且不动 auth.json', () => {
  const { dataDir, env, home, authPath } = tempEnv()
  const original = JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'at-1', refresh_token: 'rt-1', id_token: makeIdToken({ email: 'a@b.c' }) },
  }, null, 2)
  fs.writeFileSync(authPath, original)

  const result = captureCurrentAuth({ dataDir, env, home })
  assert.equal(result.ok, true)
  assert.equal(result.account.email, 'a@b.c')

  assert.equal(fs.readFileSync(authPath, 'utf8'), original, 'auth.json 不能被改')

  const list = listAccounts({ dataDir, env, home })
  assert.equal(list.length, 1)
  assert.equal(list[0].active, true, '就是当前这份 token')
  assert.equal(list[0].hasRefreshToken, true)
  // 列表不能泄露 token
  assert.equal(JSON.stringify(list).includes('at-1'), false)
})

test('没有 auth.json 时记录失败并说明原因', () => {
  const { dataDir, env, home } = tempEnv()
  const result = captureCurrentAuth({ dataDir, env, home })
  assert.equal(result.ok, false)
  assert.match(result.message, /auth\.json/)
})

/* ------------------------------------------------------------------ *
 * 切换
 * ------------------------------------------------------------------ */

test('切换写入 auth.json，并把原来那份留底', () => {
  const { dataDir, env, home, authPath } = tempEnv()

  // 先有账号 A（记录当前登录）
  fs.writeFileSync(authPath, JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'at-A', refresh_token: 'rt-A', id_token: makeIdToken({ email: 'a@x.com' }) },
  }))
  const a = captureCurrentAuth({ dataDir, env, home }).account

  // 再模拟账号 B（直接塞进存储，模拟设备码登录的产物）
  const storeFile = path.join(dataDir, 'codex-accounts.json')
  const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
  store.accounts.push({
    id: 'codex-b',
    label: 'b@x.com',
    email: 'b@x.com',
    accountId: 'acc-B',
    source: 'device',
    addedAt: new Date().toISOString(),
    tokens: { id_token: makeIdToken({ email: 'b@x.com' }), access_token: 'at-B', refresh_token: 'rt-B' },
  })
  fs.writeFileSync(storeFile, JSON.stringify(store))

  const result = switchAccount({ dataDir, accountId: 'codex-b', env, home })
  assert.equal(result.ok, true)

  const written = JSON.parse(fs.readFileSync(authPath, 'utf8'))
  assert.equal(written.auth_mode, 'chatgpt')
  assert.equal(written.tokens.access_token, 'at-B')
  assert.equal(written.tokens.refresh_token, 'rt-B')
  assert.equal(written.tokens.account_id, 'acc-B')

  // 原来那份（账号 A）必须留底，才能切回来
  const previous = JSON.parse(fs.readFileSync(path.join(dataDir, 'codex-auth.previous.json'), 'utf8'))
  assert.equal(previous.tokens.access_token, 'at-A')

  // 列表里的 active 跟着变
  const list = listAccounts({ dataDir, env, home })
  assert.equal(list.find(item => item.id === 'codex-b').active, true)
  assert.equal(list.find(item => item.id === a.id).active, false)
  assert.ok(list.find(item => item.id === 'codex-b').lastUsedAt !== null)
})

test('切换到不存在的账号会失败且不写文件', () => {
  const { dataDir, env, home, authPath } = tempEnv()
  const before = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'keep' } })
  fs.writeFileSync(authPath, before)

  const result = switchAccount({ dataDir, accountId: 'nope', env, home })
  assert.equal(result.ok, false)
  assert.equal(fs.readFileSync(authPath, 'utf8'), before)
})

test('删除账号不动 auth.json', () => {
  const { dataDir, env, home, authPath } = tempEnv()
  fs.writeFileSync(authPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'at' } }))
  const account = captureCurrentAuth({ dataDir, env, home }).account

  const result = removeAccount({ dataDir, accountId: account.id })
  assert.equal(result.ok, true)
  assert.equal(listAccounts({ dataDir, env, home }).length, 0)
  assert.equal(JSON.parse(fs.readFileSync(authPath, 'utf8')).tokens.access_token, 'at')
})

/* ------------------------------------------------------------------ *
 * 设备码
 * ------------------------------------------------------------------ */

test('startDeviceLogin 解析设备码响应', async () => {
  const fetchImpl = fakeFetch([
    ['deviceauth/usercode', () => jsonResponse(200, {
      device_auth_id: 'dev-1', user_code: 'ABCD-1234', interval: 5, expires_in: 600,
    })],
  ])

  const started = await startDeviceLogin({ fetchImpl })
  assert.equal(started.deviceAuthId, 'dev-1')
  assert.equal(started.userCode, 'ABCD-1234')
  assert.equal(started.verificationUrl, 'https://auth.openai.com/codex/device')
  assert.ok(started.expiresAt > Date.now())
})

test('startDeviceLogin 对失败响应给出可诊断错误', async () => {
  const fetchImpl = fakeFetch([['deviceauth/usercode', () => new Response('nope', { status: 500 })]])
  await assert.rejects(() => startDeviceLogin({ fetchImpl }), /500/)
})

test('未确认时轮询返回 pending', async () => {
  const fetchImpl = fakeFetch([['deviceauth/token', () => new Response('', { status: 403 })]])
  const result = await pollDeviceLogin({ deviceAuthId: 'd', userCode: 'u', fetchImpl })
  assert.equal(result.status, 'pending')
})

test('设备码过期返回 expired', async () => {
  const fetchImpl = fakeFetch([['deviceauth/token', () => new Response('', { status: 410 })]])
  const result = await pollDeviceLogin({ deviceAuthId: 'd', userCode: 'u', fetchImpl })
  assert.equal(result.status, 'expired')
})

test('确认后换到 token 并落库', async () => {
  const { dataDir } = tempEnv()
  const idToken = makeIdToken({ email: 'new@x.com', accountId: 'acc-N', plan: 'plus' })

  const fetchImpl = fakeFetch([
    ['deviceauth/token', () => jsonResponse(200, { authorization_code: 'code-1', code_verifier: 'ver-1' })],
    ['oauth/token', async (_url, init) => {
      // 换 token 必须是 form 编码，带上 authorization_code
      assert.match(String(init.headers['content-type']), /x-www-form-urlencoded/)
      assert.match(String(init.body), /grant_type=authorization_code/)
      assert.match(String(init.body), /code=code-1/)
      assert.match(String(init.body), /code_verifier=ver-1/)
      return jsonResponse(200, {
        access_token: 'at-N', refresh_token: 'rt-N', id_token: idToken, expires_in: 3600,
      })
    }],
  ])

  const result = await pollDeviceLogin({ deviceAuthId: 'd', userCode: 'u', dataDir, fetchImpl })
  assert.equal(result.status, 'ok')
  assert.equal(result.account.email, 'new@x.com')
  assert.equal(result.account.accountId, 'acc-N')

  const list = listAccounts({ dataDir, env: {}, home: os.tmpdir() })
  assert.equal(list.length, 1)
  assert.equal(list[0].label, 'new@x.com')
  assert.equal(list[0].source, 'device')
})

/* ------------------------------------------------------------------ *
 * 刷新
 * ------------------------------------------------------------------ */

test('刷新用 refresh_token 换新 access_token', async () => {
  const { dataDir, env, home, authPath } = tempEnv()
  fs.writeFileSync(authPath, JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'old', refresh_token: 'rt-old', id_token: makeIdToken() },
  }))
  const account = captureCurrentAuth({ dataDir, env, home }).account

  const fetchImpl = fakeFetch([
    ['oauth/token', async (_url, init) => {
      assert.match(String(init.body), /grant_type=refresh_token/)
      assert.match(String(init.body), /refresh_token=rt-old/)
      return jsonResponse(200, { access_token: 'new', refresh_token: 'rt-new', expires_in: 3600 })
    }],
  ])

  const result = await refreshAccount({ dataDir, accountId: account.id, fetchImpl })
  assert.equal(result.ok, true)

  // 存储里的 token 已更新（切一次才会写进 auth.json）
  const store = JSON.parse(fs.readFileSync(path.join(dataDir, 'codex-accounts.json'), 'utf8'))
  assert.equal(store.accounts[0].tokens.access_token, 'new')
  assert.equal(store.accounts[0].tokens.refresh_token, 'rt-new')
})

test('没有 refresh_token 时刷新直接失败并说明', async () => {
  const { dataDir } = tempEnv()
  const store = { accounts: [{ id: 'x', label: 'x', tokens: { access_token: 'a' } }] }
  fs.writeFileSync(path.join(dataDir, 'codex-accounts.json'), JSON.stringify(store))

  const result = await refreshAccount({ dataDir, accountId: 'x', fetchImpl: async () => { throw new Error('不该发请求') } })
  assert.equal(result.ok, false)
  assert.match(result.message, /refresh_token/)
})
