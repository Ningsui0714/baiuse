#!/usr/bin/env node
/**
 * BaiUse 命令行入口。
 *
 * 用法：
 *   node src/cli.js                      # 用默认目录与端口
 *   node src/cli.js --port 48760
 *   node src/cli.js --data-dir /path
 *   node src/cli.js --print-config       # 只打印 Codex 接入配方，不启动
 */

import { startApp } from './app.js'
import { resolveDataDir } from './store.js'

const usage = `白用 AI · BaiUse —— 一键白嫖，一键接入。

用法：node src/cli.js [选项]

  --port <端口>       网关监听端口（默认 48760）
  --host <地址>       监听地址（默认 127.0.0.1，只绑回环）
  --data-dir <目录>   数据目录（默认见 README）
  --print-config      打印 Codex 接入配方后退出
  --help              显示帮助

环境变量：
  OFM_GATEWAY_HOME    数据目录（等价于 --data-dir）
`

function parseArgs(argv) {
  const options = {}
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--help') { process.stdout.write(usage); return undefined }
    if (flag === '--print-config') { options.printConfig = true; continue }
    if (flag === '--port' || flag === '--host' || flag === '--data-dir') {
      const value = argv[++index]
      if (value === undefined) throw new Error(`选项 ${flag} 缺少参数`)
      if (flag === '--port') {
        const parsed = Number(value)
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
          throw new Error('--port 必须是 0 到 65535 的整数')
        }
        options.port = parsed
      } else if (flag === '--host') {
        options.host = value
      } else {
        options.dataDir = value
      }
      continue
    }
    throw new Error(`未知选项：${flag}`)
  }
  return options
}

/** 打印 Codex CLI 的接入配方。 */
function printRecipe(url, apiKey) {
  process.stdout.write([
    '# 加进 ~/.codex/config.toml',
    'model_provider = "ofm"',
    '',
    '[model_providers.ofm]',
    'name = "BaiUse"',
    `base_url = "${url}/v1"`,
    'wire_api = "responses"',
    'env_key = "OFM_API_KEY"',
    '',
    '# 然后：',
    `export OFM_API_KEY="${apiKey}"`,
    '',
  ].join('\n'))
}

async function main() {
  const options = parseArgs(process.argv)
  if (options === undefined) return

  const dataDir = options.dataDir ?? resolveDataDir()

  if (options.printConfig === true) {
    // 只读设置，不启动服务 —— 这样不会占用端口。
    const { createSettings } = await import('./store.js')
    const settings = createSettings(dataDir)
    const port = options.port ?? Number(settings.get().port) ?? 48760
    printRecipe(`http://127.0.0.1:${port}`, settings.get().apiKey)
    return
  }

  const app = await startApp({
    dataDir,
    port: options.port,
    host: options.host,
  })

  process.stdout.write('\n')
  printRecipe(app.url, app.apiKey)

  const shutdown = () => {
    void app.close().finally(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

main().catch(error => {
  process.stderr.write(`启动失败：${error.message}\n`)
  process.exitCode = 1
})
