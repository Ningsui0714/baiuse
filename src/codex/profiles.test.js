/**
 * 供应商档案的测试。
 *
 * 这套东西会**改写用户的 `~/.codex/config.toml`**，所以每条断言都在防
 * 「切一次就把人家配置洗了」或「切错了回不去」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  activateProfile,
  GATEWAY_PROFILE_ID,
  listProfiles,
  normalizeProfileId,
  purgeProviderConfig,
  removeProfile,
  resolveProfileId,
  restoreConfig,
  saveProfile,
} from './profiles.mjs'

function tempEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-prof-'))
  const codexHome = path.join(root, 'codex')
  const dataDir = path.join(root, 'app')
  fs.mkdirSync(codexHome, { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })
  return {
    root,
    codexHome,
    dataDir,
    env: { CODEX_HOME: codexHome },
    home: root,
    configPath: path.join(codexHome, 'config.toml'),
  }
}

function fakeSettings(initial = {}) {
  let value = { codexProfiles: [], ...initial }
  return {
    get: () => value,
    update: patch => { value = { ...value, ...patch }; return value },
  }
}

const ORIGINAL = `# 用户自己的配置
model = "gpt-6-astra"
approval_policy = "never"

[mcp_servers.docs]
command = "npx"
`

/* ------------------------------------------------------------------ *
 * id 规则
 * ------------------------------------------------------------------ */

test('id 能自动推导：中文/空/冲突都不该让用户卡住', () => {
  // 中文 id 不报错，按域名推
  assert.equal(resolveProfileId({ id: '宁小瞒', baseUrl: 'https://api.deepseek.com/v1' }), 'deepseek')
  // 空 id 同样按域名推
  assert.equal(resolveProfileId({ baseUrl: 'https://api.moonshot.cn/v1' }), 'moonshot')
  // 域名推不出来时给个可用兜底
  assert.match(resolveProfileId({ id: '', baseUrl: 'not a url' }), /^profile-[a-z0-9]+$/)
  // 冲突时加后缀
  assert.equal(resolveProfileId({ baseUrl: 'https://api.deepseek.com/v1' }, new Set(['deepseek'])), 'deepseek-2')
  // 合法 id 原样保留
  assert.equal(resolveProfileId({ id: 'My-Custom_1', baseUrl: 'https://x/v1' }), 'my-custom_1')
})

test('保存时中文 ID 不再报错，自动推导并可用', () => {
  const { dataDir, env, home } = tempEnv()
  const settings = fakeSettings()
  const profiles = saveProfile({
    settings, dataDir, env, home,
    profile: { id: '宁小瞒', name: '宁小瞒', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k' },
  })
  const entry = profiles.find(item => !item.builtin)
  assert.ok(entry, '应当保存成功')
  assert.equal(entry.id, 'deepseek')
  assert.equal(entry.name, '宁小瞒')
})

test('档案 id 校验', () => {
  assert.equal(normalizeProfileId(' DeepSeek-1 '), 'deepseek-1')
  assert.throws(() => normalizeProfileId('ofm'), /保留/)
  assert.throws(() => normalizeProfileId('A B'), /小写字母/)
  assert.throws(() => normalizeProfileId('x'), /小写字母/)
})

/* ------------------------------------------------------------------ *
 * 列表
 * ------------------------------------------------------------------ */

test('列表含内置网关档案，且标出当前生效的那份', () => {
  const { dataDir, env, home, configPath } = tempEnv()
  fs.writeFileSync(configPath, ORIGINAL)
  const settings = fakeSettings()

  const profiles = listProfiles({
    settings, dataDir, env, home,
    gatewayUrl: 'http://127.0.0.1:48760/v1',
    gatewayKey: 'ofm-key',
  })

  // 两张内置卡：OpenAI 官方 + 本机网关
  assert.equal(profiles.length, 2)
  assert.equal(profiles[0].id, 'openai')
  assert.equal(profiles[0].official, true)
  assert.equal(profiles[0].active, true, '当前 provider 就是 openai，官方卡应生效')
  assert.equal(profiles[1].id, GATEWAY_PROFILE_ID)
  assert.equal(profiles[1].active, false)
  // 不返回明文 Key
  assert.equal(JSON.stringify(profiles).includes('ofm-key'), false)
  assert.match(profiles[1].keyHint, /ofm-.*-key/)
})

/* ------------------------------------------------------------------ *
 * 保存 / 删除
 * ------------------------------------------------------------------ */

test('保存供应商后出现在列表，Key 不回显', () => {
  const { dataDir, env, home } = tempEnv()
  const settings = fakeSettings()

  const profiles = saveProfile({
    settings, dataDir, env, home,
    gatewayUrl: 'http://x/v1', gatewayKey: 'k',
    profile: {
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      wireApi: 'responses',
      model: 'deepseek-v4-pro',
      apiKey: 'sk-secret-1234',
    },
  })

  const entry = profiles.find(item => item.id === 'deepseek')
  assert.ok(entry)
  assert.equal(entry.name, 'DeepSeek')
  assert.equal(entry.hasKey, true)
  assert.match(entry.keyHint, /sk-s.*1234/)
  assert.equal(JSON.stringify(profiles).includes('sk-secret-1234'), false)
})

test('保存时缺 Base URL 或 wire_api 非法会被拒', () => {
  const { dataDir, env, home } = tempEnv()
  const settings = fakeSettings()
  assert.throws(() => saveProfile({
    settings, dataDir, env, home, profile: { id: 'a1', baseUrl: '' },
  }), /Base URL/)

  assert.throws(() => saveProfile({
    settings, dataDir, env, home,
    profile: { id: 'a1', baseUrl: 'https://x/v1', wireApi: 'grpc' },
  }), /wire_api/)
})

test('内置网关档案不能删除', () => {
  const { dataDir, env, home } = tempEnv()
  const settings = fakeSettings()
  assert.throws(() => removeProfile({ settings, dataDir, id: GATEWAY_PROFILE_ID, env, home }), /不能删除/)
})

/* ------------------------------------------------------------------ *
 * 切换
 * ------------------------------------------------------------------ */

test('切换到第三方供应商：写对表与顶层键，其余内容保留', () => {
  const { dataDir, env, home, configPath } = tempEnv()
  fs.writeFileSync(configPath, ORIGINAL)
  const settings = fakeSettings()

  saveProfile({
    settings, dataDir, env, home,
    profile: {
      id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1',
      wireApi: 'responses', model: 'deepseek-v4-pro', apiKey: 'sk-ds',
    },
  })

  const result = activateProfile({
    settings, dataDir, env, home, profileId: 'deepseek',
    gatewayUrl: 'http://127.0.0.1:48760/v1', gatewayKey: 'ofm-key',
  })
  assert.equal(result.ok, true)

  const text = fs.readFileSync(configPath, 'utf8')
  assert.match(text, /^model_provider = "deepseek"$/m)
  assert.match(text, /^model = "deepseek-v4-pro"$/m)
  assert.match(text, /\[model_providers\.deepseek\]/)
  assert.match(text, /base_url = "https:\/\/api\.deepseek\.com\/v1"/)
  assert.match(text, /wire_api = "responses"/)
  assert.match(text, /experimental_bearer_token = "sk-ds"/)
  // 用户自己的东西不能丢
  assert.match(text, /# 用户自己的配置/)
  assert.match(text, /approval_policy = "never"/)
  assert.match(text, /\[mcp_servers\.docs\]/)
})

test('切换到网关档案时用实时 Key，而不是存的', () => {
  const { dataDir, env, home, configPath } = tempEnv()
  fs.writeFileSync(configPath, ORIGINAL)
  const settings = fakeSettings()

  activateProfile({
    settings, dataDir, env, home, profileId: GATEWAY_PROFILE_ID,
    gatewayUrl: 'http://127.0.0.1:50123/v1', gatewayKey: 'ofm-live-key',
  })

  const text = fs.readFileSync(configPath, 'utf8')
  assert.match(text, /base_url = "http:\/\/127\.0\.0\.1:50123\/v1"/)
  assert.match(text, /experimental_bearer_token = "ofm-live-key"/)
  assert.match(text, /^model_provider = "ofm"$/m)
})

test('切换两次后仍是单一 model_provider，且原配置只备份一次', () => {
  const { dataDir, env, home, configPath } = tempEnv()
  fs.writeFileSync(configPath, ORIGINAL)
  const settings = fakeSettings()

  saveProfile({ settings, dataDir, env, home, profile: { id: 'a1', baseUrl: 'https://a/v1', apiKey: 'ka' } })
  saveProfile({ settings, dataDir, env, home, profile: { id: 'b1', baseUrl: 'https://b/v1', apiKey: 'kb' } })

  activateProfile({ settings, dataDir, env, home, profileId: 'a1', gatewayUrl: 'http://g/v1', gatewayKey: 'k' })
  const first = fs.readFileSync(configPath, 'utf8')
  activateProfile({ settings, dataDir, env, home, profileId: 'b1', gatewayUrl: 'http://g/v1', gatewayKey: 'k' })

  const text = fs.readFileSync(configPath, 'utf8')
  assert.equal((text.match(/^model_provider = /gm) ?? []).length, 1)
  assert.match(text, /^model_provider = "b1"$/m)
  assert.match(text, /\[model_providers\.a1\]/, '切换不会删掉别的供应商表')
  assert.match(text, /\[model_providers\.b1\]/)

  const backup = fs.readFileSync(path.join(dataDir, 'codex-config.backup.toml'), 'utf8')
  assert.equal(backup, ORIGINAL, '备份必须仍是最初那份，不能被第一次切换的结果覆盖')
  assert.notEqual(first, ORIGINAL)
})

/* ------------------------------------------------------------------ *
 * 还原
 * ------------------------------------------------------------------ */

test('还原能字节级回到原始配置', () => {
  const { dataDir, env, home, configPath } = tempEnv()
  fs.writeFileSync(configPath, ORIGINAL)
  const settings = fakeSettings()

  activateProfile({ settings, dataDir, env, home, profileId: GATEWAY_PROFILE_ID, gatewayUrl: 'http://g/v1', gatewayKey: 'k' })
  assert.notEqual(fs.readFileSync(configPath, 'utf8'), ORIGINAL)

  const result = restoreConfig({ dataDir, env, home })
  assert.equal(result.mode, 'restored')
  assert.equal(fs.readFileSync(configPath, 'utf8'), ORIGINAL)
})

test('还原后由官方卡生效', () => {
  const { dataDir, env, home, configPath } = tempEnv()
  fs.writeFileSync(configPath, ORIGINAL)
  const settings = fakeSettings()

  activateProfile({ settings, dataDir, env, home, profileId: GATEWAY_PROFILE_ID, gatewayUrl: 'http://g/v1', gatewayKey: 'k' })
  restoreConfig({ dataDir, env, home })

  const profiles = listProfiles({ settings, dataDir, env, home, gatewayUrl: 'http://g/v1', gatewayKey: 'k' })
  const active = profiles.filter(profile => profile.active)
  assert.equal(active.length, 1)
  assert.equal(active[0].id, 'openai', '还原之后生效的是 OpenAI 官方')
})

test('切换不存在的档案不写文件', () => {
  const { dataDir, env, home, configPath } = tempEnv()
  fs.writeFileSync(configPath, ORIGINAL)
  const settings = fakeSettings()

  const result = activateProfile({ settings, dataDir, env, home, profileId: 'nope', gatewayUrl: 'http://g/v1', gatewayKey: 'k' })
  assert.equal(result.ok, false)
  assert.equal(fs.readFileSync(configPath, 'utf8'), ORIGINAL)
})

/* ------------------------------------------------------------------ *
 * 彻底移除第三方配置
 * ------------------------------------------------------------------ */

test('移除第三方段：只删我们的，别的 provider 与用户内容都保留', () => {
  const { dataDir, env, home, configPath } = tempEnv()
  const settings = fakeSettings()

  // 用户自己也有一个第三方 provider，不能误删
  const original = ORIGINAL + `
[model_providers.mine]
name = "我自己配的"
base_url = "https://mine.example/v1"
wire_api = "chat"
`
  fs.writeFileSync(configPath, original)

  saveProfile({ settings, dataDir, env, home, profile: { id: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k1' } })
  saveProfile({ settings, dataDir, env, home, profile: { id: 'kimi', baseUrl: 'https://api.moonshot.cn/v1', apiKey: 'k2' } })
  activateProfile({ settings, dataDir, env, home, profileId: 'deepseek', gatewayUrl: 'http://g/v1', gatewayKey: 'k' })
  activateProfile({ settings, dataDir, env, home, profileId: 'kimi', gatewayUrl: 'http://g/v1', gatewayKey: 'k' })

  const result = purgeProviderConfig({ settings, dataDir, env, home })
  assert.equal(result.ok, true)
  assert.deepEqual([...result.removed].sort(), ['deepseek', 'kimi'])

  const text = fs.readFileSync(configPath, 'utf8')
  assert.doesNotMatch(text, /model_providers\.deepseek/)
  assert.doesNotMatch(text, /model_providers\.kimi/)
  assert.match(text, /\[model_providers\.mine\]/, '用户自己的 provider 必须保留')
  assert.match(text, /model_provider = "openai"/, '顶层改回官方')
  // 用户的其它内容一字不动
  assert.match(text, /# 用户自己的配置/)
  assert.match(text, /\[mcp_servers\.docs\]/)
})

test('移除第三方段：备份原文件', () => {
  const { dataDir, env, home, configPath } = tempEnv()
  const settings = fakeSettings()
  fs.writeFileSync(configPath, ORIGINAL)
  saveProfile({ settings, dataDir, env, home, profile: { id: 'a1', baseUrl: 'https://a/v1', apiKey: 'k' } })
  activateProfile({ settings, dataDir, env, home, profileId: 'a1', gatewayUrl: 'http://g/v1', gatewayKey: 'k' })

  const before = fs.readFileSync(configPath, 'utf8')
  purgeProviderConfig({ settings, dataDir, env, home })

  const backup = fs.readFileSync(path.join(dataDir, 'codex-config.before-purge.toml'), 'utf8')
  assert.equal(backup, before)
})

test('移除第三方段：没有可删的也不报错', () => {
  const { dataDir, env, home, configPath } = tempEnv()
  const settings = fakeSettings()
  fs.writeFileSync(configPath, ORIGINAL)

  const result = purgeProviderConfig({ settings, dataDir, env, home })
  assert.equal(result.ok, true)
  assert.deepEqual(result.removed, [])
  assert.equal(fs.readFileSync(configPath, 'utf8').replace(/\n+$/, ''), ORIGINAL.replace(/\n+$/, ''))
})
