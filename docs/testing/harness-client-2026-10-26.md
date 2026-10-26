# DeepSeek Harness 接入验证

日期：2026-10-26。原生客户端版本：`dsh 0.2.1-rc.2`。所有写配置测试均使用临时 HOME / DSH_HOME；用户现有 `.dsh` 配置与官方凭据未修改。

## 已观测

1. **真实配置加载**：先由 BaiUse 写入 Web patch，再运行真实 `dsh --profile web --dump-config`；首次初始化后 BaiUse 供应商仍存在，未被默认配置覆盖。
2. **真实 CLI + 本地 SSE 端点**：初始化 Headless 后一键接入，真实 `dsh headless` 返回精确标记 `BAIUSE_HARNESS_OK`，退出码 0。端点验证 Bearer 凭据、模型 ID、25 个工具定义；主请求显式 `max_tokens: 131072` 未被截断。辅助标题生成请求单独使用 4096，这是 Harness 自身的辅助调用预算，不是 BaiUse 对主请求施加的上限。
3. **真实上游链路**：临时 profile → 真实 `dsh headless` → 本机 BaiUse → `deepseek-v4.1-flash`。纯文本 stdout 精确为 `BAIUSE_HARNESS_LIVE_OK`，退出码 0，耗时约 65.7 秒；未使用 JSON 事件中回显的用户提示冒充模型回答。
4. **配置还原**：Web / Desktop、初始化过的 TUI / Headless、DSH_HOME、其他供应商、插件、注释、原始凭据均有隔离测试。原件未再编辑时按字节恢复；后来新增插件 / 调整顺序保留；字段冲突保留备份，多文件预检失败不部分写入。
5. **管理接口与 UI**：正常预览掩码 YAML / `.env` 敏感值，明确复制时才返回完整内容；真实 Electron 中六个官方图标均加载，Harness 页签可用，1440 / 1080 / 390px 无整页横向溢出。

## 可重复命令

```bash
npm test
npm run test:ui
npm run test:e2e
npm run test:harness
# CLI 不在 PATH 时：
DSH_BIN=/absolute/path/to/dsh npm run test:harness
```

`test:harness` 只使用夹具 Key 与本地 SSE 服务，不消耗真实模型额度。真实上游测试使用本机已授权连接，凭据不写入仓库，也不作为默认自动化测试重跑。

## 边界

- 已验证真实 CLI 请求与 Web 配置组合；未在用户已运行的 Harness Desktop 中点击接入或完成 GUI 对话。桌面 profile 路径和格式依据官方源码，界面仍需客户端自身重启加载。
- 25 个工具定义已传递，不等于本轮在 Harness 中执行过全部工具。本轮真实上游验收为纯文本回复。
- 未声称兼容所有历史 Harness 配置格式；当前接入针对采用 Cordis profile patch 的版本。无法解析的文件保留原状并提示。
- 官方图标来源与文件校验见 [素材说明](../../ui/assets/clients/README.md)。
