# 原生客户端接入与验证边界

核对日期：2026-10-26。界面与协议实现均在当前仓库内，不需要安装 CC Switch。

## 设计依据

采用 CC Switch 的关键字段更新思路：只调整连接、鉴权与模型，保留权限、hooks、插件、MCP 和不属于本工具的供应商。读取已有 JSONC；解析失败时不写。多文件操作先完整解析、保留恢复日志，再写文件。

参考源：

- [CC Switch 配置文件说明](https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/5-faq/5.1-config-files.md)
- [CC Switch Claude Desktop 实现](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/claude_desktop_config.rs)，本次核对 commit `50395742445738d418427d480ef574eaa624a1de`。它的 3P profile 写入是专门的桌面接入路径，不等于 CLI 的 settings.json；本项目按用户确认，默认不用该文件写入路径，改为应用内引导。
- [Anthropic 官方：Desktop app 网关配置](https://code.claude.com/docs/en/llm-gateway-connect#desktop-app)。桌面应用读取第三方推理配置；本地用户在应用内配置，组织也可预先下发。
- [Gemini CLI 配置](https://geminicli.com/docs/reference/configuration/)
- [OpenCode 自定义供应商](https://opencode.ai/docs/providers/#custom-provider)

## 各客户端的实际行为

### Codex

复用已有 TOML 合并、接管标记与还原逻辑，不写官方 auth.json。新增空配置/不存在配置的区别：原来没有文件且接入后没改过，撤销时删除本工具生成的文件；原来是空文件则恢复为空文件。

原有直连档案、账号、会话管理保留在「Codex 高级管理」，不会在新接入流程中自动迁移会话或清除登录。

### Claude Code CLI

更新 `env.ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL`、三个默认角色模型以及顶层 `model`。移除文件内冲突的 API key、apiKeyHelper 与 Bedrock/Vertex/Foundry 模式开关，原值保留在备份。不会改写 shell profile 或系统环境。

### Gemini CLI

`.env` 中更新 `GEMINI_API_KEY`、`GOOGLE_GEMINI_BASE_URL`、`GEMINI_MODEL`，同步设置 `security.auth.selectedType = gemini-api-key` 与 `model.name`。保留注释、无关变量和 settings 的其他字段；不修改 Google 登录缓存。项目配置/进程环境的覆盖需在客户端内检查。

### OpenCode

优先现存的 `opencode.jsonc`，否则使用 `opencode.json`。保留已有 provider/MCP，新增 `provider.codex-relay`，使用 `@ai-sdk/openai-compatible` 与 `/v1`，设置默认模型为 `codex-relay/<真实模型 ID>`。

### Claude Desktop / Code 标签页

控制台仅保存网关模型映射，并提供应用内配置向导和单项复制。不会改写 `Claude`、`Claude-3p`、`configLibrary`、deploymentMode、桌面登录态或系统策略。

- URL：实际网关地址 + `/claude-desktop`。
- 身份：Static API key / Bearer，使用本机网关 Key。
- 模型：`claude-sonnet-4-5` 是可识别的路由别名，映射到所选真实模型，不宣称上游模型身份。
- 模型发现：`GET /claude-desktop/v1/models`。
- 配置入口：Help → Troubleshooting → Enable Developer Mode，然后 Developer → Configure Third-Party Inference → Gateway。
- 需要在应用内测试并应用，受安装版本与管理员策略约束。
- 页面「检测到网关请求」仅是成功请求观测，不是应用内状态验证。网关重启后这项运行时观测清空。

## 账号渠道的 DeepSeek 为什么没有显示

客户端接入共用一个目录，不限于 Kilo。内部保留账号、Kilo、自备 Key 路由，对外按逻辑模型整合（`lane: pool`），不再按厂商分组。CodeArts 提供的 DeepSeek 走已有账号凭据，不要求另买 DeepSeek API Key。

2026-10-26 实机排查：当前 CodeArts 有 1 个账号记录，但对应凭据缺失。旧页面以“有记录”判断“已登录”，错误显示正常；授权入口创建的待授权记录也被计入已登录账号。这与实际模型门控（凭据可解析才显示）不一致。

修复：账号 API 只返回凭据是否已保存/缺失/格式无效，不暴露凭据；未完成授权不计入已授权账号。凭据写入/移除和账号变更触发目录更新；刷新期间的变更会再刷新一次，另有定期对账。页面轮询比较模型内容，不再仅按模型数量判断；“刷新状态”也会主动重取渠道目录。

操作：账号缺凭据时，客户端接入 → CodeArts 提示中的“去完成授权” → 添加账号 → 在浏览器完成授权。凭据落盘且渠道目录返回后，模型会自动进入统一模型池；Claude Desktop 仍需在应用内应用 Gateway 参数。仅打开登录页不算授权成功。

## 统一模型池与应用内选择器

- 五个客户端都用相同的逻辑模型标识，例如 `deepseek-v4.1-flash`，不将厂商名写入新配置。DeepSeek 的日期后缀 `1017` / `20261017` 属于同版本同档位的变体；主版本及 Flash/Pro 不混用。
- 真实渠道 ID 保留在内部 `modelRows()`；对外目录由 `clientModelRows()` 整合，附线路和厂商数量。旧厂商前缀请求仍匹配同逻辑模型，优先原线路，失败后换到其它匹配线路。
- 配额耗尽或可重试错误发生在正文/工具参数提交之前时自动换路，保留完整输入、工具上下文及输出预算；失败线路不重复尝试，不把一个模型换成另一个版本。新授权渠道实时加入，无需改客户端配置或重启。
- 选择控件是应用内 Popover + 搜索 Combobox/Listbox，不再调用系统 select 菜单。支持模型名称/版本搜索、上下键、Home/End、Enter、Esc、外部点击关闭；按窗口空间自动向上/向下展开。
- 当前真实 CodeArts 的统一标识调用 HTTP 200；多厂商额度切换以明确标注的本地夹具验证，不虚构用户已经登录的 TRAE 渠道。

初次排查时，真实 Electron 页面显示“0 个已授权 / 1 个记录”和“未完成授权”；后续用户完成授权后，真实 CodeArts / DeepSeek 对话及 Codex CLI 工具闭环均已验证，详见 [实测记录](testing/deepseek-live-2026-10-26.md)。新增回归覆盖五类配置、五类协议转发（本地 DeepSeek 夹具）、目录同数量替换、刷新竞态及真实 Worker 的缺凭据状态；跨厂商额度切换仍以夹具为验证依据。

## 全局下拉与渠道识别

账号渠道、配置状态筛选、两处协议弹窗与客户端模型选择均使用应用内下拉。支持搜索、上下键、Home/End、Enter、Esc、外部关闭及弹窗内层级；刷新不重置仍有效的渠道选择。

`ui/channels.js` 统一补充中文产品名与厂商，例如 `CodeArts 码道 · 华为云`、`TRAE · 字节跳动`、`Raccoon 小浣熊 · 商汤科技`。总览、账号列表及客户端授权提示共用；登录与路由继续使用 `codearts`、`trae` 等原始标识。搜索支持中文厂商和产品名；没有官方中文名时不硬译。模型选择仍按统一模型展示，不重新加厂商前缀。

## 协议覆盖

新增下游 Messages、Chat Completions、Gemini generateContent / streamGenerateContent。支持文本、图片、自定义函数调用、参数分片重组、工具结果回传、SSE 和非流式、用量与长度截断标记。不同客户端共用现有模型目录、鉴权、冷却和故障转移。

不把不支持的功能静默丢弃：文档/音视频块、供应商服务端搜索或 computer-use 工具会返回明确错误；工具是否可用还取决于真实上游模型。不会声称所有 Anthropic/Gemini 扩展功能均兼容。

`/v1/messages/count_tokens`、Gemini `:countTokens` 为本地启发式估算，响应带 `x-relay-token-count: estimated`，不是模型原生 tokenizer 或计费用量；真实生成用量取自上游。

## 安全和还原

- 管理接口继续要求回环地址 + Bearer Key，不提供任意路径写入。
- 常规预览掩码 Key/token/secret/password；只在用户点复制时显式请求完整内容。
- 备份日志权限 0600；先保存原件，再原子替换客户端文件。
- 原件和当前内容吻合时按字节恢复；有后续无关编辑时按所管理字段恢复。
- 管理字段出现竞争修改时返回 409，保留备份与当前文件，避免覆盖。
- 本项目的文件式接入不会替换 symlink 管理的配置文件，而是给出明确提示。

## 验证结果

见 [视觉与交互验收记录](design/README.md)。单元/集成测试使用临时 HOME，不操作用户现有的客户端配置。

真实免费上游 smoke test：Messages 文本 HTTP 200；Messages 自定义 `read_file` 工具调用 HTTP 200，模拟工具结果回传后的回复 HTTP 200；Gemini 原生 JSON HTTP 200；Chat SSE HTTP 200。只发送公开测试提示，没有读取真实 README 或执行该工具。

这验证的是网关协议与上游联通，不等同于在 Claude Desktop 内完成了用户的配置；未启动/改动用户现有 Claude Desktop 来做实际对话验收。
