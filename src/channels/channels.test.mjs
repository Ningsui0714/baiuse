import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCredentials } from '../../vendor/channels/credentials.mjs'
import { accountCredentialStatus } from './account-status.mjs'
import { createChannelRuntime, createModelRefresh } from './runtime.mjs'

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-channels-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('账号条目不等于授权成功；只返回凭据状态，不返回凭据', async t => {
  const dir = fixture(t)
  const credentials = createCredentials(dir)
  const account = { credentialRef: 'CODEARTS_ACCOUNT_TEST' }
  assert.deepEqual(await accountCredentialStatus(credentials, account), { authenticated: false, credentialState: 'missing' })
  for (const bad of ['broken-json', 'null', '"token"']) {
    await credentials.set(account.credentialRef, bad)
    assert.deepEqual(await accountCredentialStatus(credentials, account), { authenticated: false, credentialState: 'invalid' })
  }
  await credentials.set(account.credentialRef, JSON.stringify({ access_token: 'fixture-only-secret' }))
  const result = await accountCredentialStatus(credentials, account)
  assert.deepEqual(result, { authenticated: true, credentialState: 'saved' })
  assert.ok(!JSON.stringify(result).includes('fixture-only-secret'))
})

test('OAuth 凭据写入/移除通知宿主，重开后状态仍保留', async t => {
  const dir = fixture(t)
  let changes = 0
  const credentials = createCredentials(dir, { onChange() { changes++ } })
  await credentials.set('TEST_REF', '{"token":"fixture"}')
  assert.equal(changes, 1)
  assert.equal((fs.statSync(path.join(dir, 'channel-credentials.json')).mode & 0o777), 0o600)
  const reopened = createCredentials(dir)
  assert.equal((await reopened.resolve('TEST_REF')).value, '{"token":"fixture"}')
  await credentials.unset('TEST_REF')
  assert.equal(changes, 2)
  assert.equal(await credentials.resolve('TEST_REF'), undefined)
})

test('目录加载期间的授权变更不会被并发合并吞掉', async () => {
  let release, loads = 0, rows
  const refresh = createModelRefresh(async () => {
    if (++loads === 1) return await new Promise(resolve => { release = resolve })
    return [{ id: 'codearts/fixture-deepseek', lane: 'channel' }]
  }, value => { rows = value })
  const first = refresh()
  const second = refresh()
  const third = refresh()
  assert.equal(second, first)
  assert.equal(third, first)
  release([])
  await first
  assert.equal(loads, 2)
  assert.equal(rows[0].id, 'codearts/fixture-deepseek')
})

test('目录失败保留旧值，后续刷新可以恢复', async () => {
  let fail = true, rows = ['old']
  const refresh = createModelRefresh(async () => { if (fail) throw new Error('fixture failure'); return ['new'] }, value => { rows = value })
  await assert.rejects(refresh(), /fixture failure/)
  assert.deepEqual(rows, ['old'])
  fail = false
  await refresh()
  assert.deepEqual(rows, ['new'])
})

test('真实渠道 Worker 把没有凭据的 CodeArts 条目标记为待授权，目录不冒充可用', async t => {
  const dir = fixture(t)
  fs.mkdirSync(path.join(dir, 'channel-pack'))
  fs.writeFileSync(path.join(dir, 'channel-pack/state.json'), JSON.stringify({
    accounts: [{ id: 'codearts-fixture', provider: 'codearts', nickname: 'fixture', credentialRef: 'MISSING_REF', enabled: true, refreshable: false }],
    disabledModels: {}, gatewayEnabled: true,
  }))
  const runtime = await createChannelRuntime({ dataDir: dir, logger: { info() {}, warn() {}, error() {} } })
  try {
    await runtime.ready
    const reply = await runtime.rpc({ method: 'account.list', payload: { provider: 'codearts' } })
    assert.equal(reply.ok, true)
    assert.equal(reply.value.accounts[0].authenticated, false)
    assert.equal(reply.value.accounts[0].credentialState, 'missing')
    assert.deepEqual(runtime.publicModelRows(), [])
  } finally { await runtime.close() }
})

test('有道龙虾已移除：不注册模型、拒绝旧账号操作和签到，保留历史凭据',async t=>{
  const dir=fixture(t)
  fs.mkdirSync(path.join(dir,'channel-pack'))
  const account={id:'lobsterai-retired',provider:'lobsterai',nickname:'retired fixture',credentialRef:'MISSING_RETIRED',enabled:true,refreshable:false}
  fs.writeFileSync(path.join(dir,'channel-pack/state.json'),JSON.stringify({accounts:[account],disabledModels:{},gatewayEnabled:true}))
  const runtime=await createChannelRuntime({dataDir:dir,logger:{info(){},warn(){},error(){}}})
  try {
    await runtime.ready
    assert.ok(!runtime.providers.includes('lobsterai'))
    assert.ok(!runtime.publicModelRows().some(m=>m.id.startsWith('lobsterai/')))
    for(const request of [{method:'account.create',payload:{provider:'lobsterai'}},{method:'credits.claimAll',payload:{provider:'lobsterai'}},{method:'account.refresh',payload:{accountId:account.id}},{method:'credits.balances',payload:{provider:'lobsterai'}}]){
      const result=await runtime.rpc(request)
      assert.equal(result.ok,false);assert.equal(result.error.code,'provider-retired');assert.match(result.error.message,/封号风险/)
    }
    assert.deepEqual((await runtime.rpc({method:'account.list',payload:{}})).value.accounts,[])
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir,'channel-pack/state.json'),'utf8')).accounts.some(a=>a.id===account.id))
  }finally{await runtime.close()}
})
