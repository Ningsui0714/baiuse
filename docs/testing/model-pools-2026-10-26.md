# 统一模型池与应用内选择器

## 交付行为

选择器按模型展示，不按 CodeArts / TRAE 等厂商拆分。选择 `DeepSeek V4.1 Flash` 时，新配置使用稳定 ID `deepseek-v4.1-flash`。同模型其它已授权渠道会自动加入池，配额耗尽后不要求修改配置或重启客户端。旧的 `codearts/deepseek-v4.1-flash` 请求也可以切换到其它同模型渠道。

`DeepSeekV4.1 Flash 1017`、`deepseek-v4.1-flash-20261017` 合并为上述逻辑模型；V4/V4.1、Flash/Pro、Chat/R1、其它未声明等价的调优版本仍分别处理。真实上游路由名保留，网关不把逻辑别名直接发给上游。

配额或可重试错误发生在正文/工具参数提交之前时自动换路；不会把两条回答拼接，也不会重新尝试已失败线路。输入、工具结果和输出预算原样保留。不再以四条候选为默认上限，每条符合条件的线路最多尝试一次。首次接入之后，增减渠道不需要再次修改客户端配置。

## 界面

- 已去掉 `CodeArts · DeepSeek /` 这类厂商前缀。
- 原生 select 替换为应用内浅蓝色 Popover，包含搜索、选中标记、渠道数量、可滚动列表和自适应展开方向。
- 支持名称/版本多词搜索，上下键、Home/End、Enter 选择、Esc 或外部点击关闭。
- 真实 Electron 中已展开并检查外观；搜索 `deepseek` 后只剩 `DeepSeek V4.1 Flash`，按 Enter 后配置预览中使用统一 ID，而不是厂商 ID。

## 验证

- `npm test`：206 项通过。
- `npm run test:e2e`：429 后切换备用渠道通过。
- 五种协议的本地夹具：CodeArts 配额耗尽 → TRAE 的 V4.1 Flash 1017 接替；Responses、Messages、Chat、Gemini、Desktop Gateway 均 HTTP 200。
- 新渠道动态加入后，复用同一个路由运行时和旧配置即可成功；同版本不同档位不混用；不会重复调用已失败线路。
- 新接入配置将旧厂商前缀转换为稳定逻辑 ID。
- 用户实际账号调用：请求与响应模型都是 `deepseek-v4.1-flash`，HTTP 200，约 1.55 秒，返回指定测试短语。
- `git diff --check` 通过。

当前用户实际 DeepSeek 池只有已授权的 CodeArts 一条线路；跨厂商配额耗尽通过上述夹具验证，不宣称已经使用用户未授权的 TRAE 账号。后续授权后，匹配的模型会自动并入，界面渠道数量随目录更新。

未改写用户现有客户端配置，未移除账号或凭据。运行日志与回归输出留在本机 `/tmp/codex-relay-model-pools-tests.log`、`/tmp/codex-relay-model-pools-live.json`。
