# DeepSeek 账号渠道实测

日期：2026-10-26（Asia/Shanghai）。对象：实际运行的 Codex Relay 桌面版、用户已授权的 CodeArts 账号；模型 ID 来自真实目录：`codearts/deepseek-v4.1-flash`。

## 实际结果

| 检查 | 结果 |
| --- | --- |
| 账号与模型目录 | 凭据已保存、可续期；7 个 CodeArts 模型与 17 个 Kilo 模型同时出现 |
| Responses 非流式 | HTTP 200，约 2 秒，返回指定测试短语 |
| Messages / Claude Code 协议 | HTTP 200，返回指定测试短语 |
| Chat Completions / OpenCode SSE | HTTP 200，收到文本与结束事件；约 64 秒 |
| Gemini generateContent | HTTP 200，约 1 秒，返回指定测试短语 |
| Responses SSE | HTTP 200，收到正文与完成事件；存在约 22～63 秒的慢请求 |
| Messages 自动工具调用 | 真实上游返回 `relay_probe` 与正确参数；模拟工具结果回传后正确回答 |
| 真实 Codex CLI | 修复后 exit 0，约 2.4 秒，输出 `relay-codex-cli-ok`，无断流重试 |
| 真实 Codex CLI 工具闭环 | 实际执行 `/bin/zsh -lc 'printf relay-codex-tool-ok'`，exit 0，工具结果回传后正常结束；整轮约 67 秒 |

Codex CLI 使用临时 CODEX_HOME、空工作目录、ephemeral、read-only 模式。没有写入用户现有 Codex/Claude/Gemini/OpenCode 配置，没有读取项目文件或执行测试以外的命令。

## 这次实测发现并修复

初次真实 CLI 已得到模型正文，却因 `response.completed.usage` 透传渠道内部 camelCase 字段而报缺少 `input_tokens`，重复采样。现已统一 Responses / Chat / Messages / Gemini 用量字段；补齐稳定的 item ID、内容起止事件、完整 function_call 与参数结束事件，CLI 正常完成。

协议结构对齐 [OpenAI 官方 Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events)。实测事实以上表及本地回归为准，不以规范文档代替运行验证。

按用户要求：不将连通性测试的 128/256 token 参数写入客户端默认配置；移除网关固定 32MB 请求体上限；账号渠道不再按历史模型名称将显式输出预算静默压到 64K。保留完整上下文与客户端预算，未指定时沿用渠道适配器/上游默认值。真实模型能力与配额仍由上游决定；真正的 max-tokens 结束明确返回 incomplete，而不是伪装 completed。

本地夹具验证 33MB 输入、131072 输出预算和 100000 字符输出原样通过，未用真实账号消耗大额度做压力测试。

## 仍有的边界

- 普通对话及自动工具调用已经验证。强制指定工具的 `tool_choice` 在账号渠道桥接中仍会返回 400；不将自动工具成功等同于全部工具选择模式兼容。
- Claude Code、Gemini CLI、OpenCode 本次验证到真实上游协议层；当前环境没有对应 CLI 可执行文件，没有声称完成三者的原生进程端到端测试。
- Claude Desktop 尚未配置网关映射，也未在桌面应用内测试/应用参数；未改写其设置。
- 观察到部分请求需等待约一分钟。未取得上游排队明细，不把原因武断归结为网络、模型思考或免费池限流。

## 回归

`npm test`：195 项通过。`npm run test:e2e`：限流后切换备用渠道通过。`git diff --check`：通过。

原始诊断输出只保存在本机临时测试目录 `/tmp/codex-relay-deepseek-live`；测试报告不包含账号凭据或网关 Key。
