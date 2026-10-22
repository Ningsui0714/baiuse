# Codex Relay

**把免费 AI API 接入 Codex CLI。** Codex Relay 在本机提供统一的 OpenAI Responses 接口，内置 Kilo 免账号、免上游 API Key 的免费模型池；也能接入已有渠道账号和自备 Key 的供应商。一个模型有多条可用路径时，网关可在响应尚未提交前自动故障转移。

```text
Codex CLI -> Codex Relay (本机) -> Kilo 免费模型池（免上游 Key）
             /v1/responses       -> 已登录账号渠道 / 自备 Key 的供应商
```

## 免费的边界

| 来源 | 接入要求 | 费用说明 |
| --- | --- | --- |
| Kilo 免费模型池 | 无需 Kilo 账号或上游 API Key | 仅接入上游标记为免费的模型；可用性、限流由上游决定 |
| 账号渠道 | 登录自己的渠道账号 | 是否有免费额度取决于对应渠道 |
| 自定义供应商 | 填写自己的 API Key | 是否免费取决于供应商及账户套餐 |

网关自身会生成一串**本机鉴权 Key**，供 Codex CLI 连接本地服务；这不是购买上游 API 的 Key。Kilo 免费池的提示词可能被上游记录并用于改进服务，不适合发送敏感内容。

项目包含 Electron 桌面管理界面和纯 Node.js 命令行入口，默认只监听 `127.0.0.1`。

## 环境要求

- Node.js `^22.19.0` 或 `>=24.0.0`，以及 npm。
- 已安装 Codex CLI，且能够访问你要使用的上游服务。
- 桌面版需要能运行 Electron 的 macOS、Windows 或 Linux 环境；无图形界面可使用命令行版。

仓库目前没有预构建安装包或 lockfile。从源码运行：

```bash
npm install
npm run start:app
```

桌面版启动后打开管理界面。想先用免费的 Kilo 模型，可直接到「模型」确认带有 Kilo 来源的免费模型已出现，再到「接入 Codex」选择「本机网关」并点击「使用」，无需先登录上游账号。Kilo 目录会在启动后异步加载；若上游不可达，该目录可能为空。

需要更多渠道时，在「账号」登录自己的账号，或在「聚合」配置自备 API Key 的供应商。它们与免费 Kilo 模型共用同一个本地网关。

Gemini 账号渠道需要你自行提供 OAuth 客户端配置：登录前设置 `CMDC_PAK_GOOGLE_CLIENT_ID` 和 `CMDC_PAK_GOOGLE_CLIENT_SECRET`。仓库不包含共享客户端凭据；这不影响 Kilo 免费模型的使用。

Loomy 微信登录需要自行设置 `CMDC_PAK_LOOMY_WECHAT_APP_ID`。仓库不包含共享微信 OAuth 客户端标识；其他登录方式及 Kilo 免费模型不受影响。

### 命令行运行

```bash
npm start
# 或指定监听端口和数据目录
node src/cli.js --port 48760 --data-dir /path/to/data
node src/cli.js --help
```

启动日志会打印实际监听地址和 Codex 接入配方。默认端口是 `48760`；若被占用，会自动选择空闲端口并记入设置。无桌面壳时，在浏览器打开启动日志给出的地址加 `/app`（例如 `http://127.0.0.1:48760/app`），使用日志中的本机网关 API Key 登录。请勿把这串 Key 提交到 GitHub。

已有数据目录时，也可运行 `node src/cli.js --print-config` 查看接入配方，不启动网关；首次使用应先正常启动一次，让 Key 持久化。

### 手动接入 Codex CLI

界面的「接入 Codex」可以自动写入配置，并在首次接管前备份原文件。也可以手动在 `~/.codex/config.toml` 中设置：

```toml
model_provider = "ofm"
model = "<模型页中显示的模型 ID>"

[model_providers.ofm]
name = "Codex Relay"
base_url = "http://127.0.0.1:48760/v1"
wire_api = "responses"
env_key = "OFM_API_KEY"
```

在运行 Codex CLI 的终端设置 `OFM_API_KEY` 为网关启动时给出的 Key。如果实际端口不是 `48760`，将 `base_url` 改为启动日志中的地址加 `/v1`。模型 ID 以「模型」页或 `GET /v1/models` 的返回值为准。

「接入 Codex」里的自定义供应商档案是**直连**：切换到它时 Codex 绕过本机网关，不使用网关故障转移。要使用聚合路由，请选「本机网关」。

## 接口与路由

| 路径 | 用途 | 鉴权 |
| --- | --- | --- |
| `GET /health` | 本机网关状态 | 无 |
| `GET /v1/models` | 当前可见模型 | Bearer 网关 Key |
| `POST /v1/responses` | Codex Responses 请求，支持流式与非流式 | Bearer 网关 Key |
| `GET /app` | 管理界面 | 页面本身无鉴权；管理 API 要求 Key |

上游可能使用 Chat、Messages 或 Responses 协议，网关统一为 Responses。路由按模型 ID 查找候选，结合会话粘性、轮询和故障冷却选择上游。上游失败时默认最多尝试四条候选；一旦已经输出正文或工具调用参数，就不会再切换，以免拼接两条回答。自动故障转移不能保证每个模型都有备用渠道，也不能消除上游配额或登录限制。

## 数据与兼容性

公开名称从 **OFM Codex Gateway** 改为 **Codex Relay**，但以下运行时标识继续沿用，避免已有 Codex 配置和本地数据失效：

- Codex provider ID：`ofm`，对应 `[model_providers.ofm]`。
- 环境变量：`OFM_API_KEY`、`OFM_GATEWAY_HOME`。
- 默认数据目录：macOS 为 `~/Library/Application Support/OFM Codex Gateway/`；其他系统为 `$XDG_CONFIG_HOME/ofm-codex-gateway/` 或 `~/.config/ofm-codex-gateway/`。

可用 `--data-dir` 或 `OFM_GATEWAY_HOME` 改数据目录。该目录保存网关 Key、供应商配置及渠道凭据，应当按敏感数据保护，不要提交到版本库。管理 API 除 Bearer Key 外还检查请求来自本机回环地址。

「接入 Codex」的网关接管修改 `config.toml`，首次接管会在应用数据目录备份；「还原原始配置」可撤销接管。账号管理是单独的功能：「记录当前登录」会保存当前 Codex 登录态，「切换账号」会备份并改写 `~/.codex/auth.json`。切换后如 Codex 仍使用旧账号，重启 Codex 后台进程。

## 开发与测试

```bash
npm test          # 单元及集成测试
npm run test:e2e  # 本地端到端故障转移演示
```

`npm run dist` 构建 macOS 目录版；`npm run dist:all` 调用 electron-builder 的多平台构建，跨平台打包仍取决于本机工具链。

```text
electron/   Electron 主进程与 preload
ui/         静态管理界面和样式
src/        网关、CLI、渠道运行时、路由和 Codex 配置管理
vendor/     随仓库提供的渠道、车道及供应商注册表
test/       端到端演示
docs/       设计与分析资料
```

供应商预设位于 `vendor/providers/registry.json`。本项目不依赖外部宿主进程，但推理仍依赖所选上游服务及其网络连接。

## 许可

项目自有代码采用 [MIT License](LICENSE)。`vendor/` 中的渠道适配代码源自 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) 及其上游项目；这些代码仍受各自的上游许可约束，使用相关服务时也应遵守其条款。
