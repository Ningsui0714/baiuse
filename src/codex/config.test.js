/**
 * Codex 接管模块的测试。
 *
 * 这里的每一条都在防守同一件事：**别把用户的 config.toml 弄坏**。
 * 接管/撤销是这个 app 里唯一会改用户已有文件的动作，弄坏了代价最高。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { buildConfigText, connect, disconnect, getStatus, PROVIDER_ID, preview } from './config.mjs'
import { findSection, findTopLevelEnd, maskMultilineStringLines, splitLines } from './toml.mjs'

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

function tempEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-codex-'))
  const codexHome = path.join(root, 'codex')
  const dataDir = path.join(root, 'app')
  fs.mkdirSync(codexHome, { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })
  return { root, codexHome, dataDir, env: { CODEX_HOME: codexHome }, home: root }
}

const MODEL = 'trae/glm-5'

/* ------------------------------------------------------------------ *
 * 行编辑器：别把多行字符串/注释里的 [x] 当表头
 * ------------------------------------------------------------------ */

test('多行字符串里的 [x] 不算表头', () => {
  const text = [
    'note = """',
    '[fake.section]',
    'key = 1',
    '"""',
    '',
    '[model_providers.ofm]',
    'name = "x"',
  ].join('\n')
  const lines = splitLines(text)

  const mask = maskMultilineStringLines(lines)
  assert.equal(mask[1], true, '第二行处在多行字符串内')
  assert.equal(findSection(lines, 'fake.section'), null, '不能把字符串内容当表头')

  const real = findSection(lines, 'model_providers.ofm')
  assert.equal(real?.headerIndex, 5)
})

test('注释里的 [x] 不算表头', () => {
  const lines = splitLines('# [model_providers.ofm]\nname = "real"\n\n[model_providers.other]\nx = 1')
  assert.equal(findSection(lines, 'model_providers.ofm'), null)
  assert.equal(findSection(lines, 'model_providers.other')?.headerIndex, 3)
})

test('顶层区域在下第一个表头处结束', () => {
  const lines = splitLines('model = "a"\nfoo = 1\n\n[model_providers.x]\nbar = 2')
  assert.equal(findTopLevelEnd(lines), 3)
})

/* ------------------------------------------------------------------ *
 * 生成配置：只动该动的
 * ------------------------------------------------------------------ */

const ORIGINAL = `# 我的 Codex 配置 —— 注释必须保留
model = "gpt-6-astra"
model_reasoning_effort = "xhigh"
approval_policy = "never"

[model_providers.mine]
name = "我自己的中转"
base_url = "https://example.test/v1"
wire_api = "responses"

[mcp_servers.docs]
command = "npx"
args = ["-y", "docs-server"]
`

test('接管只改 model_provider / model / 我们自己的段，其余原样保留', () => {
  const after = buildConfigText(ORIGINAL, {
    baseUrl: 'http://127.0.0.1:48760/v1',
    apiKey: 'ofm-test-key',
    model: MODEL,
  })

  // 保留项
  assert.match(after, /# 我的 Codex 配置 —— 注释必须保留/)
  assert.match(after, /model_reasoning_effort = "xhigh"/)
  assert.match(after, /approval_policy = "never"/)
  assert.match(after, /\[model_providers\.mine\]/)
  assert.match(after, /base_url = "https:\/\/example\.test\/v1"/)
  assert.match(after, /\[mcp_servers\.docs\]/)
  assert.match(after, /args = \["-y", "docs-server"\]/)

  // 改动项
  assert.match(after, /^model_provider = "ofm"$/m)
  assert.match(after, /^model = "trae\/glm-5"$/m)
  assert.match(after, /\[model_providers\.ofm\]/)
  assert.match(after, /name = "BaiUse"/)
  assert.match(after, /base_url = "http:\/\/127\.0\.0\.1:48760\/v1"/)
  assert.match(after, /wire_api = "responses"/)
  assert.match(after, /experimental_bearer_token = "ofm-test-key"/)
})

test('重复接管是幂等的（不会越写越多）', () => {
  const once = buildConfigText(ORIGINAL, { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: MODEL })
  const twice = buildConfigText(once, { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: MODEL })
  assert.equal(twice, once)
  assert.equal((twice.match(/\[model_providers\.ofm\]/g) ?? []).length, 1)
  assert.equal((twice.match(/^model_provider = /gm) ?? []).length, 1)
})

test('没有 model 时不写 model 行，也不写 disable_response_storage', () => {
  const after = buildConfigText(ORIGINAL, { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k' })
  assert.match(after, /^model_provider = "ofm"$/m)
  // 原有的 model 保持不变（不是我们该管的事）
  assert.match(after, /^model = "gpt-6-astra"$/m)
  assert.doesNotMatch(after, /disable_response_storage/)
})

test('有官方登录时 requires_openai_auth = true', () => {
  const after = buildConfigText('', { baseUrl: 'http://x/v1', apiKey: 'k', requiresOpenAiAuth: true })
  assert.match(after, /requires_openai_auth = true/)
})

test('没有官方登录时 requires_openai_auth = false', () => {
  const after = buildConfigText('', { baseUrl: 'http://x/v1', apiKey: 'k', requiresOpenAiAuth: false })
  assert.match(after, /requires_openai_auth = false/)
})

test('CRLF 文件保持 CRLF', () => {
  const crlf = 'model = "a"\r\napproval_policy = "never"\r\n'
  const after = buildConfigText(crlf, { baseUrl: 'http://x/v1', apiKey: 'k' })
  assert.ok(after.includes('\r\n'), '应当仍是 CRLF')
  // 不能出现「\r 混在 \n 之间」的双重换行
  assert.doesNotMatch(after, /\r\r/)
})

test('空配置也能长出完整片段', () => {
  const after = buildConfigText('', { baseUrl: 'http://x/v1', apiKey: 'k', model: MODEL })
  assert.match(after, /^model_provider = "ofm"$/m)
  assert.match(after, /\[model_providers\.ofm\]/)
})

/* ------------------------------------------------------------------ *
 * 落盘：接管 → 撤销
 * ------------------------------------------------------------------ */

test('接管后状态正确，auth.json 一个字节都没动', () => {
  const { codexHome, dataDir, env, home } = tempEnv()
  const configPath = path.join(codexHome, 'config.toml')
  const authPath = path.join(codexHome, 'auth.json')
  fs.writeFileSync(configPath, ORIGINAL)
  const authBefore = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'tok' } }, null, 2)
  fs.writeFileSync(authPath, authBefore)

  const result = connect({
    dataDir, env, home,
    baseUrl: 'http://127.0.0.1:48760/v1',
    apiKey: 'ofm-key',
    model: MODEL,
  })

  assert.equal(result.backupCreated, true)
  assert.equal(result.status.active, true)
  assert.equal(result.status.hasOurBlock, true)
  assert.equal(result.status.currentProvider, PROVIDER_ID)
  assert.equal(result.status.auth.hasChatGPT, true)

  // 官方登录必须原样保留 —— 这是整个模块最重要的一条
  assert.equal(fs.readFileSync(authPath, 'utf8'), authBefore)

  // 有官方登录 → requires_openai_auth = true
  assert.match(fs.readFileSync(configPath, 'utf8'), /requires_openai_auth = true/)
})

test('撤销后配置字节级复原', () => {
  const { codexHome, dataDir, env, home } = tempEnv()
  const configPath = path.join(codexHome, 'config.toml')
  fs.writeFileSync(configPath, ORIGINAL)

  connect({ dataDir, env, home, baseUrl: 'http://127.0.0.1:48760/v1', apiKey: 'ofm-key', model: MODEL })
  const result = disconnect({ dataDir, env, home })

  assert.equal(result.mode, 'restored')
  assert.equal(fs.readFileSync(configPath, 'utf8'), ORIGINAL, '必须与原始文件完全一致')
  assert.equal(result.status.managed, false)
  assert.equal(result.status.hasOurBlock, false)
})

test('接管期间用户改了别的配置：撤销只摘掉我们的部分', () => {
  const { codexHome, dataDir, env, home } = tempEnv()
  const configPath = path.join(codexHome, 'config.toml')
  fs.writeFileSync(configPath, ORIGINAL)

  connect({ dataDir, env, home, baseUrl: 'http://127.0.0.1:48760/v1', apiKey: 'ofm-key', model: MODEL })

  // 用户在我们写的那份上又加了一行
  const edited = `${fs.readFileSync(configPath, 'utf8')}\n[mcp_servers.extra]\ncommand = "x"\n`
  fs.writeFileSync(configPath, edited)

  const result = disconnect({ dataDir, env, home })
  const after = fs.readFileSync(configPath, 'utf8')

  assert.equal(result.mode, 'surgical', '哈希不匹配时不能拿备份覆盖')
  assert.doesNotMatch(after, /\[model_providers\.ofm\]/, '我们的段要摘掉')
  assert.match(after, /\[mcp_servers\.extra\]/, '用户新加的东西必须留着')
  assert.match(after, /\[model_providers\.mine\]/, '别人的 provider 必须留着')
  assert.match(after, /^model_provider = "openai"$/m, '顶层要回到接管前的值')
})

test('未接管时撤销是空操作', () => {
  const { codexHome, dataDir, env, home } = tempEnv()
  fs.writeFileSync(path.join(codexHome, 'config.toml'), ORIGINAL)
  const result = disconnect({ dataDir, env, home })
  assert.equal(result.mode, 'noop')
  assert.equal(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'), ORIGINAL)
})

test('重复接管不会把备份覆盖成已接管的版本', () => {
  const { codexHome, dataDir, env, home } = tempEnv()
  const configPath = path.join(codexHome, 'config.toml')
  fs.writeFileSync(configPath, ORIGINAL)

  connect({ dataDir, env, home, baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k1', model: MODEL })
  const second = connect({ dataDir, env, home, baseUrl: 'http://127.0.0.1:2/v1', apiKey: 'k2', model: MODEL })
  assert.equal(second.backupCreated, false)

  disconnect({ dataDir, env, home })
  assert.equal(fs.readFileSync(configPath, 'utf8'), ORIGINAL, '备份必须仍是最初那份')
})

test('检测到漂移（drifted）', () => {
  const { codexHome, dataDir, env, home } = tempEnv()
  const configPath = path.join(codexHome, 'config.toml')
  fs.writeFileSync(configPath, ORIGINAL)
  connect({ dataDir, env, home, baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: MODEL })

  assert.equal(getStatus({ dataDir, env, home }).drifted, false)
  fs.appendFileSync(configPath, '\n# 用户又加了个注释\n')
  assert.equal(getStatus({ dataDir, env, home }).drifted, true)
})

test('预览不落盘', () => {
  const { codexHome, dataDir, env, home } = tempEnv()
  const configPath = path.join(codexHome, 'config.toml')
  fs.writeFileSync(configPath, ORIGINAL)

  const result = preview({ dataDir, env, home, baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: MODEL })
  assert.equal(result.changed, true)
  assert.match(result.after, /\[model_providers\.ofm\]/)
  assert.equal(fs.readFileSync(configPath, 'utf8'), ORIGINAL, '预览不能写文件')
})

test('接管需要 baseUrl 与 apiKey', () => {
  const { dataDir, env, home } = tempEnv()
  assert.throws(() => connect({ dataDir, env, home, apiKey: 'k' }), /网关地址/)
  assert.throws(() => connect({ dataDir, env, home, baseUrl: 'http://x/v1' }), /API Key/)
})

/* ------------------------------------------------------------------ *
 * 配置里已有 ofm 段（用户手写的）也能正确识别
 * ------------------------------------------------------------------ */

test('手写的 ofm 段会被认出并在撤销时清理', () => {
  const { codexHome, dataDir, env, home } = tempEnv()
  const configPath = path.join(codexHome, 'config.toml')
  const handWritten = 'model_provider = "ofm"\n\n[model_providers.ofm]\nname = "x"\nbase_url = "http://127.0.0.1:9/v1"\n'
  fs.writeFileSync(configPath, handWritten)

  const status = getStatus({ dataDir, env, home })
  assert.equal(status.hasOurBlock, true)
  assert.equal(status.active, true)
  assert.equal(status.managed, false, '没接管过就不是 managed')

  const result = disconnect({ dataDir, env, home })
  assert.equal(result.status.hasOurBlock, false)
  assert.doesNotMatch(fs.readFileSync(configPath, 'utf8'), /\[model_providers\.ofm\]/)
})
