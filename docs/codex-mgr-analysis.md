# Codex-Manager (qxcnm/Codex-Manager) 架构分析报告

仓库根:`/tmp/codex-mgr`,Rust workspace:
`crates/core`(领域模型 + 存储)、`crates/service`(网关/账号/用量/配置)、`crates/rusqlite`、`crates/storage-seaorm`、`crates/web`、`crates/start`、`apps/src-tauri`(桌面端)。

---

## 1. 网关入口与暴露的 HTTP 路由

### 1.1 生产路由表(Axum,唯一生产 socket)

文件:`crates/service/src/http/proxy_runtime.rs:620` `build_front_proxy_app_with_limits()`

```rust
let gateway_routes = Router::new()
    .route("/rpc", post(rpc_endpoint::handle_rpc_http)
        .layer(RequestBodyLimitLayer::new(RPC_BODY_LIMIT_BYTES))
        .layer(from_fn(middleware::require_rpc_auth)))
    .route("/events/usage-refresh", get(usage_events::handle_usage_refresh_events_http)...)
    .route("/events/account-test",  get(account_test_events::handle_account_test_events_http)...)
    .route("/auth/callback", get(callback_endpoint::handle_callback_http))
    .route("/v1/responses",       any(responses_handler))     // ← 唯一特殊处理
    .route("/v1/chat/completions",any(proxy_handler))
    .route("/proxy-test-upload",  post(proxy_test_upload))
    .fallback(any(proxy_handler))                            // ← 兜底：其它一切路径
    .layer(from_fn(middleware::concurrency_gate))
    .layer(CatchPanicLayer::custom(...));

Router::new()
    .route("/health", get(health_handler))
    .route("/metrics", get(metrics_handler))
    .route("/__shutdown", get(shutdown_endpoint::shutdown).layer(require_rpc_auth))
    .merge(gateway_routes)
    .layer(TraceLayer...) .layer(request_timeout) .layer(request_id)
```

**关键结论:所有路径都支持。** 因为 `.fallback(any(proxy_handler))` 兜底:

| 路径 | 是否支持 | 处理逻辑位置 |
|---|---|---|
| `/v1/responses` | ✅ 专门路由 | `responses_handler` → 若 GET 且是 WS 升级头 → `responses_websocket::upgrade_responses_websocket`;否则 `proxy_handler` |
| `/v1/chat/completions` | ✅ 专门路由 | `proxy_handler` |
| `/v1/models` | ✅ 走 fallback | `proxy_handler` → `gateway_endpoint::handle_gateway_http` → 网关域逻辑(本地模型目录 `gateway/request/local_models.rs`,或转发上游) |
| `/responses`(无 `/v1`) | ✅ 走 fallback | 同上,路径原样透传给上游 |
| `/v1/messages`(Anthropic) | ✅ 走 fallback | `protocol_adapter::adapt_request_for_protocol` 识别并改写 |
| `/v1/responses/compact` | ✅ | `CODEXMANAGER_COMPACT_API_PATH` 可配 |
| Gemini `:generateContent` / `:countTokens` | ✅ | `apikey_profile::is_gemini_*_request_path` |
| `/health` `/metrics` | ✅ | Axum 直出,不进并发闸门(见下) |
| `/rpc` `/events/*` `/auth/callback` `/__shutdown` | ✅ | 管理面,需 `x-codexmanager-rpc-token` |

### 1.2 两层架构(容易看错的地方)

- **`crates/service/src/http/router.rs`** — `build_router(state)` 只是把上面的 axum app 包一层 `Extension(state)`,`serve()` 负责 `axum::serve` + 优雅关闭 + `drain_deferred_responses()`。**它不定义路由。**
- **`crates/service/src/http/backend_router.rs`** — 遗留 tiny_http 兼容后端的路由分发(`resolve_backend_route`):`/rpc`→Rpc、`/auth/callback`→AuthCallback、`/events/usage-refresh`、`/events/account-test`、`/metrics`,**其余全部落到 `BackendRoute::Gateway`**。生产路径已被 Axum 取代,但同样的"fallback 兜底"设计在两层都存在。
- **`crates/service/src/http/gateway_endpoint.rs`** — 网关域入口:
  - `static GATEWAY_DOMAIN_WORKERS: Semaphore = 32` —— 路由任务并发上限,满则 503 "service busy"。
  - `handle_gateway_http(parts, body)` → `GatewayRequest::new` → `reserve_deferred_response` → `tokio::spawn(scope_response_cancellation(...))` → `crate::gateway::handle_gateway_request_async(request)` → 通过 `oneshot` 把 `Response<Body>` 回给 axum。
  - 取消语义:`CancelResponseOnDrop` + `watch` 通道;客户端断开 → 取消上游。

### 1.3 前置代理的工程细节(值得抄)

`crates/service/src/http/proxy_runtime.rs::proxy_handler`:
- 请求体大小限制 + **zstd 请求体解压**(Codex CLI 会压缩上传),解压有独立信号量(`ZSTD_MAX_CONCURRENT_DECODES=4`)和上限。
- **流式请求不做整体超时**:先只解析 `{"stream": bool}`(轻量 serde struct,避免整棵 JSON 树)判断是否 SSE,流式请求不套 `http_request_timeout`。
- 并发闸门 `middleware::concurrency_gate` 区分流式/非流式配额;`/health`、`/metrics` 在闸门外,保证饱和时探针仍可答。
- 客户端断连被记为 HTTP **499**(`DisconnectTrackingBody` 的 `Drop`)。
- `x-request-id` 在最外层注入,panic/超时响应也带同一 id。

---

## 2. Codex 客户端适配:如何识别"这是 Codex 发来的"

### 2.1 识别逻辑(唯一权威处)

文件:`crates/service/src/gateway/local_validation/request.rs:1443` `is_native_codex_client_request()`

```rust
fn is_native_codex_client_request(incoming_headers: &IncomingHeaderSnapshot) -> bool {
    let user_agent = ...to_ascii_lowercase();
    let originator = ...to_ascii_lowercase();

    let has_codex_header_signals = incoming_headers.client_request_id().is_some()   // x-client-request-id
        || incoming_headers.subagent().is_some()        // x-openai-subagent
        || incoming_headers.beta_features().is_some()   // x-codex-beta-features
        || incoming_headers.window_id().is_some()       // x-codex-window-id
        || incoming_headers.turn_metadata().is_some()   // x-codex-turn-metadata
        || incoming_headers.turn_state().is_some()      // x-codex-turn-state
        || incoming_headers.parent_thread_id().is_some();// x-codex-parent-thread-id

    user_agent.contains("codex_cli_rs")
        || originator.contains("codex_cli_rs")
        || user_agent.contains("codex_exec")
        || originator.contains("codex_exec")
        || has_codex_header_signals
}
```

**要点:**
- **不看 OAuth Bearer**。`Authorization: Bearer` 在本项目里是"平台 Key"(本项目自己的 API Key)或上游 ChatGPT token,不用于识别客户端。
- **不看 `chatgpt-account-id`**。该头是**出站**注入的(`upstream/headers/codex_headers.rs:304`、`account/account_models.rs:268`),来源是 `account.chatgpt_account_id`,用于选路后的上游鉴权。
- **不看 `session_id` 单独出现**。有明确测试 `opencode_headers_with_only_session_id_are_not_treated_as_native_codex_clients`(opencode 只带 session_id → 不算 native codex)。
- UA / originator 是主信号(`codex_cli_rs`、`codex_exec`),header 组合是兜底信号。

### 2.2 header 快照层

`crates/service/src/gateway/request/incoming_headers.rs` — `IncomingHeaderSnapshot` 把所有关心的头一次性抓成结构体:
`authorization_present / authorization_bearer_strict / authorization_bearer_case_insensitive / x_api_key / user_agent / originator / session_id / session_affinity / client_request_id / subagent / beta_features / window_id / turn_metadata / turn_state / parent_thread_id / codex_installation_id / codex_inference_call_id / oai_attestation / passthrough_codex_headers / conversation_id`。

- `session_id` 接受 `session-id` 与 `session_id` 两种拼写;若缺失则从 `x-codex-turn-metadata` JSON 里解析 `session_id`(带安全字符校验 `is_safe_derived_session_id`)。
- `platform_key()` = `x-api-key` 或严格大小写的 `authorization_bearer`。
- `sticky_key_material()` = `session_id` → `x-api-key` → 大小写不敏感 bearer(**会话粘性锚点优先级**)。

### 2.3 Codex 专属常量

`crates/service/src/http/codex_source.rs`:
```rust
pub(crate) const X_CODEX_TURN_STATE_HEADER: &str = "x-codex-turn-state";
pub(crate) const X_CODEX_TURN_METADATA_HEADER: &str = "x-codex-turn-metadata";
pub(crate) const X_CODEX_PARENT_THREAD_ID_HEADER: &str = "x-codex-parent-thread-id";
pub(crate) const X_CODEX_WINDOW_ID_HEADER: &str = "x-codex-window-id";
pub(crate) const X_OPENAI_SUBAGENT_HEADER: &str = "x-openai-subagent";
pub(crate) const X_RESPONSESAPI_INCLUDE_TIMING_METRICS_HEADER: &str = "x-responsesapi-include-timing-metrics";
pub(crate) const RESPONSES_ENDPOINT: &str = "/v1/responses";
```
同文件还定义 WebSocket 的 `response.create` 事件结构 `ResponseCreateWsRequest` / `ResponsesWsRequest`(`#[serde(tag="type")]`),字段与 HTTP `/v1/responses` body 对齐(`model/instructions/input/tools/tool_choice/parallel_tool_calls/reasoning/store/stream/include/service_tier/prompt_cache_key/text/generate/client_metadata` + `#[serde(flatten)] extra`)。

### 2.4 Codex CLI 用 ChatGPT 账号登录 → 请求带 session_id 的处理

链路:
1. Codex CLI 用 ChatGPT 账号登录 → 本项目用 OAuth PKCE 登录(`crates/service/src/auth/auth_login.rs` / `auth_callback.rs` / `auth_login_completion.rs`),拿到 `id_token/access_token/refresh_token`。
2. Codex CLI 指向本网关后,请求落到 `/v1/responses`,带 `Authorization: Bearer <平台Key>`、`session_id`、`originator`/`User-Agent: codex_cli_rs/...`。
3. 网关用平台 Key 选出 ChatGPT 账号(`selection.rs`),用该账号的 `access_token` + `ChatGPT-Account-ID` 头发往 `https://chatgpt.com/backend-api/codex`。
4. `session_id` 参与会话粘性(见第 4 节),并被透传/改写为上游 `session-id` 头(`upstream/headers/codex_headers.rs:245-255`,`resolve_optional_session_id(incoming, fallback)`)。

### 2.5 Responses WebSocket(Codex CLI 的 WS 模式)

`crates/service/src/http/responses_websocket.rs`(4400+ 行)+ `responses_websocket_rebase.rs`:
- `responses_handler` 检测 GET + `is_websocket_upgrade_request(headers)` → 升级为 WS。
- WS 通道内实现 `response.create` 事件、`client_metadata`、preamble 重连、连接数上限、**rebase**(在同一条流中途换账号时剥离旧账号的 `encrypted_content`,见 `gateway::strip_cross_account_encrypted_content`)。
- `crates/core/Cargo.toml` 里 `[patch.crates-io] tokio-tungstenite` 指向 openai-oss-forks —— 因为 Codex CLI 用的 WS 帧格式需要定制。

---

## 3. 账号模型(存储)

### 3.1 表结构

`crates/core/migrations/001_init.sql` + 后续迁移:

```sql
CREATE TABLE accounts (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, issuer TEXT NOT NULL,
  chatgpt_account_id TEXT, workspace_id TEXT, workspace_name TEXT,
  note TEXT, tags TEXT, group_name TEXT, sort INTEGER DEFAULT 0,
  status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE tokens (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  id_token TEXT NOT NULL, access_token TEXT NOT NULL, refresh_token TEXT NOT NULL,
  last_refresh INTEGER NOT NULL
);
CREATE TABLE usage_snapshots (
  id INTEGER PK AUTOINCREMENT, account_id TEXT NOT NULL,
  used_percent REAL, window_minutes INTEGER, resets_at INTEGER,
  credits_json TEXT, captured_at INTEGER NOT NULL
);
```
后续迁移补充:`008` 加 `tokens.api_key_access_token`;`011`/`036` 加 `chatgpt_account_id/group_name/sort/…`;`007` 加 secondary 窗口列;`030_accounts_scale_indexes`、`080_accounts_identity_lookup_indexes`、`098_accounts_list_order_index`;`045_accounts_preferred`;`052_account_subscriptions`;`130_accounts_subject_identity`。

Rust 结构体:`crates/core/src/storage/mod.rs`
- `Account`(L80):`id/label/issuer/chatgpt_account_id/workspace_id/group_name/sort/status/created_at/updated_at`
- `Token`(L599):`account_id/id_token/access_token/refresh_token/api_key_access_token/last_refresh`
- `UsageSnapshotRecord`(L700):`account_id/used_percent/window_minutes/resets_at/secondary_used_percent/secondary_window_minutes/secondary_resets_at/credits_json/captured_at`
- `AccountAgentIdentity`(L94):`agent_runtime_id/agent_private_key/task_id/chatgpt_user_id/chatgpt_account_is_fedramp/auth_mode/workspace_id` —— Codex 的 agent 身份注册。
- `AggregateApi`(L1315):第三方渠道表,见第 8 节。

### 3.2 一个 ChatGPT 账号存了什么

- **身份**:`issuer`(如 `https://auth.openai.com`)、`chatgpt_account_id`(从 id_token/access_token JWT claim 解析,`crates/core/src/auth/mod.rs::extract_chatgpt_account_id`)、`workspace_id`、可选 `agent identity`。
- **凭据**:`id_token / access_token / refresh_token / api_key_access_token`(ChatGPT OAuth 的 API key 变体)、`last_refresh`。
- **分组与排序**:`group_name`(账号组,用于按组授权/过滤)、`sort`(轮询顺序)、`tags/note`。
- **状态**:`status`(`enabled` / `disabled` / `force_enabled` / `error` 等)。`force_enabled` 是特殊值:即使额度低也强行保留(见 `apply_quota_guard`)。
- **配额**:`usage_snapshots`(5 小时窗口 + 周窗口 + credits_json)。
- **订阅**:`account_subscriptions`(free/go/plus/pro 判定)。
- **代理设置**:`account_proxy_settings` / `proxy_profiles`(每个账号独立代理出网)。

### 3.3 token 怎么存 —— **明文,未加密**

全仓 grep `encrypt|decrypt|aes|keyring` 在 `crates/core/src/storage` 与 token 相关路径**没有命中任何静态加密实现**。命中的 `encrypted` 全部是:
- `reasoning.encrypted_content`(OpenAI Responses 的推理签名,与本地存储无关);
- `agent_identity` 的 `encryptedTaskId`(服务端下发的一次性任务 id,用 `secretbox` 解密,`agent_identity.rs:606`);
- ZIP skill 条目的 `encrypted()`。

结论:**`tokens.access_token/refresh_token/id_token` 以明文 TEXT 存在 SQLite 里**。`aggregate_api_secrets.secret_value` 同样明文(表 `037_aggregate_api_routing.sql`)。这是一个**明显的安全欠债**,你要做自己的项目时应该换成 OS keychain 或主密钥 AES-GCM 加密。

### 3.4 刷新怎么做

- `crates/service/src/usage/usage_token_refresh.rs`(`ENV_TOKEN_REFRESH_AHEAD_SECS` 控制提前刷新量)+ `crates/service/src/usage/usage_refresh/`。
- 调度器 `usage/usage_scheduler.rs`;`tokens` 表有 `025_tokens_refresh_schedule.sql` 索引,`097_tokens_refresh_due_order_index` 支持"到期的 token"批量查询。
- 账号维度的刷新调度: `AccountAuthRefreshTarget` / `AccountTokenRefreshIssuer` / `AccountUsageRefreshTokenTarget`(`crates/core/src/storage/mod.rs:108-140`)。
- 刷新调度环境变量:`CODEXMANAGER_TOKEN_REFRESH_POLLING_ENABLED` / `CODEXMANAGER_TOKEN_REFRESH_POLL_INTERVAL_SECS`。
- 刷新后若发现额度不可用 → `routing/failover.rs::should_failover_after_refresh`(刷新失败且错误以 "usage endpoint status" 开头 → 故障转移)。

---

## 4. 账号池与轮换(核心可借鉴部分)

目录:`crates/service/src/gateway/routing/`
`selection.rs` / `route_hint.rs` / `route_quality.rs` / `cooldown.rs` / `failover.rs` / `request_gate.rs` / `conversation_binding.rs`

### 4.1 候选集构建 `selection.rs`

```rust
pub(crate) fn collect_gateway_candidates_with_low_quota_mode(storage, low_quota_mode)
    -> Result<Vec<(Account, Token)>, String>
```
- 从 `storage.list_gateway_candidates()` 取可用账号 + token(存储层已按 `sort` 排序)。
- **候选快照缓存**:`CANDIDATE_SNAPSHOT_CACHE`(全局 Mutex + `Instant` TTL,默认 `CODEXMANAGER_CANDIDATE_CACHE_TTL_MS=500`),避免每次请求都打 DB;缓存 key 包含 db_path 与 low_quota_mode;改配置时 `clear_candidate_cache()`。
- **额度守卫(quota guard)**:`apply_quota_guard()`
  - 阈值:5 小时窗口 `primary_min_remaining_percent`(默认 5%),周窗口 `secondary_min_remaining_percent`(默认 10%);
    环境变量 `CODEXMANAGER_QUOTA_GUARD_5H_MIN_REMAINING_PERCENT` / `..._WEEKLY_MIN_REMAINING_PERCENT`,开关 `CODEXMANAGER_QUOTA_GUARD_ENABLED`,兜底 `CODEXMANAGER_QUOTA_GUARD_ALLOW_ALL_LOW_FALLBACK`(默认 true)。
  - 窗口判定:`window_minutes > 24*60+3` 视为周窗口,否则 5 小时窗口(`quota_guard_threshold_for_window`)。
  - 语义:**剩余额度低于阈值 → 移出正常候选池**;正常池空了才按兜底开关使用低额度账号;`status == "force_enabled"` 的账号永不被剔除。
  - `LowQuotaCandidateMode::{NormalOnly, AppendFallback}` —— 账号池被授权子集限定时,低额度账号**追加**而非替换(见 `collect_gateway_candidates_for_account_ids_with_low_quota_mode`:受限池绕过全局缓存,保证"额度判断发生在授权池内部",避免池外账号影响池内兜底)。**这个细节很关键,值得抄。**

### 4.2 顺序策略 `route_hint.rs`

```rust
const ROUTE_STRATEGY_ENV: &str = "CODEXMANAGER_ROUTE_STRATEGY"; // ordered | balanced(round_robin/rr)
```
两种模式:
1. **`ordered`(默认)** —— 保持存储层的 `sort` 顺序,第一个即选中。
2. **`balanced`** —— 严格轮询:
   ```rust
   fn apply_balanced_round_robin<T>(candidates: &mut [T], key_id: &str, model: Option<&str>) {
       let start = next_start_index(key_id, model, candidates.len());
       if start > 0 { candidates.rotate_left(start); }
   }
   ```
   游标状态按 **`key_id|model`** 维度存(`RouteRoundRobinState.next_start_by_key_model`),`Mutex` 保护。
   注意 `next_account_start_index`:游标记的是 **account_id**(而不是下标),池扩容/收缩后仍能找回正确后继,避免"用旧下标切到错账号"。
   单账号时也推进游标,保证池扩容后从正确位置继续。

3. **健康度 P2C(仅在头部小窗口内交换)**:
   ```rust
   fn apply_health_p2c(candidates, key_id, model, mode) {
       let window = route_health_window(mode).min(candidates.len()); // ordered=3, balanced=1
       let Some(challenger_idx) = p2c_challenger_index(key_id, model, window) else { return };
       if route_health_score(candidates[challenger_idx].0.id.as_str()) > route_health_score(candidates[0].0.id.as_str()) {
           candidates.swap(0, challenger_idx);   // 只交换头部,不整体 rotate
       }
   }
   ```
   P2C nonce 用 `stable_hash_u64(format!("{key}|{nonce}"))` 决定挑战者,保证不同 key 分布不同、同一 key 顺序稳定。`route_quality.rs` 维护每个账号的健康分(成功/失败/延迟)。
   环境变量:`CODEXMANAGER_ROUTE_HEALTH_P2C_ENABLED`、`..._ORDERED_WINDOW`、`..._BALANCED_WINDOW`。

4. **手动指定账号优先**:`rotate_to_manual_preferred_account()` —— 存储层 `preferred_account_id`,若命中则把该账号 rotate 到队首,直接短路其它策略。

5. **状态回收**:`CODEXMANAGER_ROUTE_STATE_TTL_SECS` / `CODEXMANAGER_ROUTE_STATE_CAPACITY`(默认 0 = 不限制),`maybe_maintain` 每 64 次触发一次 prune。

### 4.3 候选过滤与软约束 `upstream/support/candidates.rs`

`prepare_gateway_candidates(storage, request_model, account_group_filter, account_plan_filter, low_quota_mode)`:
1. `account_model_override_for_request` → 模型级支持覆盖;
2. `request_exceeds_free_account_model_ceiling` → free 账号不能跑超配模型;
3. 账号组过滤(`account_matches_group_filter`)、套餐过滤(`account_matches_plan_filter_with_snapshot`)、排除 free;
4. **`drop_known_unsupported_model_candidates`** —— 记住"该账号不支持该模型"(带 TTL,`CODEXMANAGER_ACCOUNT_MODEL_UNSUPPORTED_TTL_SECS`,默认 1800s),但**若全部候选都被标记则保留原列表**,让上游给出精确 400 而不是笼统的"无可用账号"。**这是很好的工程取舍。**
5. `candidate_skip_reason_for_proxy(account_id, idx, candidate_count, account_max_inflight, skip_last_cooldown)`:
   - **冷却**(`cooldown.rs`):账号在冷却期且还有其它候选 → 跳过;
   - **并发上限**(`CODEXMANAGER_ACCOUNT_MAX_INFLIGHT`,默认 0=不限):达到上限且还有其它候选 → 跳过;
   - **两个约束都是"软约束":最后一个候选仍然尝试**,避免把可恢复抖动放大成全局不可用。注释写得很清楚:
     > `并发上限是软约束，最后一个候选仍要尝试，避免把可恢复抖动直接放大成全局不可用。`

### 4.4 会话粘性(session affinity)

- `crates/service/src/gateway/request/session_affinity.rs`:`SessionAffinity { incoming_session_id, fallback_session_id }`,归一化锚点(`normalize_anchor`)。
- `crates/service/src/gateway/request/thread_anchor.rs`:thread 锚点(父/子线程)。
- `crates/service/src/gateway/routing/conversation_binding.rs`(675 行):**会话 → 账号的持久绑定**,让同一对话始终落到同一账号(Responses API 的 `previous_response_id` / reasoning `encrypted_content` 是账号作用域的,换号会 400 `invalid_encrypted_content`)。
- 锚点材料优先级:`sticky_key_material()` = `session_id` → `x-api-key` → bearer;`session_affinity` 头 `x-session-affinity` 也被单独采集。
- 上游出站时:`upstream/headers/sticky_ids.rs::stable_session_id_from_material` 生成稳定 session-id;`codex_headers.rs::resolve_optional_session_id(incoming, fallback)` 决定用哪个。

### 4.5 故障转移 / 重试

- `upstream/support/failover_policy.rs`、`upstream/attempt_flow/fallback_branch.rs`、`upstream/attempt_flow/stateless_retry.rs`。
- `upstream/support/retry.rs::retry_with_alternate_path` —— 400/404 时换一条路径重试(带指数退避 `backoff::sleep_with_exponential_jitter_async`,受总 deadline 约束);alt 路径网络失败 → `mark_account_cooldown(account, CooldownReason::Network)`,**且若还有候选账号必须优先切换**,而不是直接失败。
- `upstream/support/deadline.rs` 统一管理总超时;`support/outcome.rs` 定义尝试结果分类。
- `upstream/support/payload_rewrite.rs::strip_encrypted_content_from_body` —— 换号时剥离账号作用域的 `encrypted_content`(否则新账号校验失败)。
- `upstream/proxy_pipeline/` 是一条完整的状态机:`request_setup → candidate_state → candidate_executor → stream_preflight → response_finalize`,每次尝试都记 attempt chain(`032_request_logs_attempt_chain.sql`)。

### 4.6 并发上限汇总

| 层级 | 位置 | 默认 |
|---|---|---|
| 网关域 worker | `http/gateway_endpoint.rs` `GATEWAY_DOMAIN_WORKERS` | 32 |
| 请求体准备槽 | `http/proxy_runtime.rs` `GATEWAY_PREPARATION_SLOTS` | 32 |
| zstd 解压并发 | `http/proxy_runtime.rs` `ZSTD_DECODE_SEMAPHORE` | 4 |
| 流/非流并发闸门 | `http/middleware.rs::concurrency_gate` + `RequestLimits` | 256 / 64(测试构造) |
| 单账号 in-flight | `CODEXMANAGER_ACCOUNT_MAX_INFLIGHT` | 0(不限) |
| 异步流式上游 worker | `CODEXMANAGER_GATEWAY_ASYNC_STREAM_WORKERS` | 32 |

---

## 5. 协议适配(Responses ↔ Anthropic / Gemini / Chat Completions)

### 5.1 适配器枚举 `crates/service/src/gateway/protocol_adapter/types.rs`

```rust
pub(crate) enum ResponseAdapter {
    Passthrough,
    AnthropicMessagesFromResponses,   // 上游是 Anthropic → 响应转回 Responses
    ResponsesFromAnthropicMessages,   // 上游是 Anthropic(聚合桥接)→ 响应转回 Responses
    ChatCompletionsFromResponses,     // 上游是 chat/completions → 响应转回 Responses
    CompactFromChatCompletions,
    ImagesB64JsonFromResponses,
    ImagesUrlFromResponses,
    GeminiJson, GeminiSse,            // Gemini 原生
    GeminiCliJson, GeminiCliSse,      // Gemini CLI 内部端点 /v1internal:*
}
pub(crate) struct AdaptedGatewayRequest {
    path: String, body: Vec<u8>,
    response_adapter: ResponseAdapter,
    gemini_stream_output_mode: Option<GeminiStreamOutputMode>,
    tool_name_restore_map: ToolNameRestoreMap,   // 工具名短名 → 原名 回填表
}
```

### 5.2 请求方向改写 `protocol_adapter/request_router.rs`(1677 行)

入口:
```rust
pub(crate) fn adapt_request_for_protocol(protocol_type: &str, path: &str, body: Vec<u8>)
    -> Result<AdaptedGatewayRequest, String>
```
- `protocol_type == anthropic_native && is_anthropic_request_path(path)` → `adapt_anthropic_messages_request`
- `protocol_type == gemini_native && is_gemini_generate_content_request_path(path)` → `adapt_gemini_generate_content_request`
- 否则 `Passthrough`

**Responses → Anthropic Messages**(`adapt_openai_responses_to_anthropic_messages`,L32):
- `instructions` + `input` → `system` + `messages`(`responses_input_to_anthropic_messages`);
- `max_output_tokens`/`max_tokens` → `max_tokens`(默认 4096);
- `tools` → Anthropic tools(`responses_tools_to_anthropic`),`tool_choice` → Anthropic 语义;
- `reasoning` → Anthropic `thinking`(带 `max_tokens` 预算分配)。

**Anthropic → Responses**(`adapt_anthropic_messages_request`,L107):
- `system` → developer message;`messages` → `input` items;`tools` → Responses tools(**生成 `tool_name_restore_map` 短名映射**,Claude Code 工具名超长需缩短,回程再还原);
- `thinking`/`output_config` → `reasoning {effort, summary}`;
- 固定补 `stream=true`、`store=false`、`include=["reasoning.encrypted_content"]`。

**Gemini → Responses**(`adapt_gemini_generate_content_request`,L169):
- `systemInstruction` → developer message;`contents` → `input`;`tools` → Responses tools;
- `generationConfig` → `reasoning`;同样补 `include=["reasoning.encrypted_content"]`;
- 特殊:`/v1internal:*` → `GeminiCliJson/Sse`;`?alt=sse` → `GeminiStreamOutputMode::Sse`,否则 `Raw`;
- `backfill_empty_gemini_function_response_names` —— Gemini 的 functionResponse 缺 name 时按前序 functionCall 回填。

### 5.3 响应方向(SSE 流式)转换

位于 `crates/service/src/gateway/observability/http_bridge/`:
- `stream_readers/openai_responses.rs`、`stream_readers/anthropic.rs`、`stream_readers/chat_completions.rs`、`stream_readers/responses_from_anthropic.rs`、`stream_readers/gemini.rs`、`stream_readers/passthrough.rs`、`stream_readers/sse_frame_buffer.rs`;
- `aggregate/openai_responses_event.rs`、`aggregate/sse_frame.rs`、`aggregate/sse_aggregate.rs`、`aggregate/chat_function_calls.rs`、`aggregate/output_text.rs`;
- `body_conversion.rs`、`compact_delivery.rs`、`compact_errors.rs`、`images.rs`。

**架构要点(非常值得抄):**
`http_bridge` 是一个**旁路观测器**:它在把上游字节原样转发给客户端的同时,**旁路解析 SSE 帧**以提取 usage(输入/输出/缓存 token、reasoning token)、终止事件、错误 hint、request-id。
注释解释了为什么要 `accept-encoding: identity`:
> `The gateway inspects SSE frames for terminal state and usage while it streams the same bytes to the client. Compressed upstream bytes would be valid for the client but unreadable to that observer, causing a successful request to be logged as a UTF-8/502 failure.`

这就是 `usage` 能被准确统计的根因 —— **不要为了统计而缓冲整个响应**。

### 5.4 上游协议枚举 `crates/service/src/apikey/apikey_profile.rs`

```rust
pub(crate) const PROTOCOL_OPENAI_COMPAT:   &str = "openai_compat";
pub(crate) const PROTOCOL_ANTHROPIC_NATIVE: &str = "anthropic_native";
pub(crate) const PROTOCOL_GEMINI_NATIVE:    &str = "gemini_native";
pub(crate) const AUTH_BEARER: &str = "authorization_bearer";
pub(crate) const AUTH_X_API_KEY: &str = "x_api_key";
```
`resolve_gateway_protocol_type(protocol_type, path)` —— **按路径通配**:Gemini 原生路径 → gemini;`/v1/messages*` → anthropic;其余 → openai/Codex。`profile_from_protocol` 据此决定鉴权头(bearer vs `x-api-key`)。

---

## 6. 用量 / 额度

### 6.1 采集

- `crates/service/src/usage/usage_http.rs` 拉取 ChatGPT usage 端点 → `usage_snapshot_store.rs` 落 `usage_snapshots`(主窗口 + secondary 窗口 + `credits_json`)。
- 调度:`usage/usage_scheduler.rs`;开关 `CODEXMANAGER_USAGE_POLLING_ENABLED` / `..._POLL_INTERVAL_SECS` / `CODEXMANAGER_USAGE_REFRESH_WORKERS`。
- `usage/usage_reset_credits.rs` 单独处理 reset credits(带 `chatgpt-account-id` 头)。
- 请求级用量:`gateway/request_log.rs` + `http_bridge` 观测到的 SSE usage → 写入 `request_logs`(含 `cached_input_tokens` / `cache_write_tokens` / `reasoning_output_tokens` / `first_response_ms` / `duration_ms`)。
- 聚合统计:`crates/core/src/storage/request_token_stats.rs`(+ hourly rollups `088`)。
- 可用性判定:`crates/service/src/account_availability.rs::evaluate_snapshot(snapshot) -> Availability{Available, Unavailable(reason)}`,`routing/failover.rs` 用它判断是否故障转移。

### 6.2 rate limit 感知

- 主路径靠**轮询 usage 快照** + `QuotaGuard`(第 4.1 节)而非响应头。轮询有周期延迟。
- `crates/service/src/gateway/auth/openai_fallback.rs` 处理上游 429 / 鉴权失败时的**降级**:把 ChatGPT 账号模式降级为 API-key 模式重试。
- `crates/service/src/gateway/upstream/support/failover_policy.rs` 定义可重试状态码集合。

### 6.3 能否按剩余额度排序账号?

**没有直接的"按剩余额度降序"排序器**。实现的是**阈值剔除**(低于 5%/10% 剩余 → 移出候选池)+ **P2C 健康分头部交换**。这是"闸门式"而不是"排序式"。如果你要"优先用额度最多的账号",需要自己加一个按 `100 - used_percent` 排序的 comparator(数据已经在 `UsageSnapshotRecord` 里,`storage.latest_usage_snapshots_for_accounts` 可批量取)。

### 6.4 配额池 / 模型目录(v2)

- `crates/core/src/storage/quota_pools.rs`、`model_catalog_v2.rs`(5800 行)、`model_groups.rs`、`model_options.rs`、`model_price_rules.rs`、`model_billing_v2.rs`、`model_sources.rs` —— 这是"模型 → 路由 → 渠道 → 价格"的多层映射体系,远比"账号池"复杂,属于 **Codex-Manager 特有业务**,不是网关必需。

---

## 7. 配置方式:把 Codex CLI 指向本网关

### 7.1 直接改 `~/.codex/config.toml`

`crates/service/src/codex_profile.rs:2968` `patch_config_for_gateway`:

```rust
doc["model_provider"] = "cm";
doc["model_catalog_json"] = <managed catalog path>;
doc["model_providers"]["cm"] = {
    name = "cm",
    requires_openai_auth = true,
    env_key / <bearer token>,     // set_provider_bearer_auth
    base_url = "<gateway base url>",
    wire_api = "responses",        // ← 关键:让 Codex CLI 走 /v1/responses
    supports_websockets = <bool>,
    http_headers = { "x-openai-actor-authorization" = ... },
};
```
默认 base url:`const DEFAULT_GATEWAY_BASE_URL: &str = "http://localhost:48760/v1";`
provider id: `"cm"`(网关模式)、`"cm_aggregate"`(直连聚合渠道模式)、`"openai"`(历史备份里的原 provider)。

### 7.2 一键切换 —— **有,且做得相当完整**

`crates/service/src/codex_profile.rs` 提供整套"Codex profile"管理:

| 函数 | 作用 |
|---|---|
| `apply_gateway_async(api_key_id, codex_home, base_url, supports_websockets, reload_after_switch)` | 把 Codex CLI 切到本网关(写 config.toml + 平台 Key) |
| `apply_direct_account_async(...)` | 直连单个 ChatGPT 账号 |
| `apply_direct_aggregate_async(...)` | 直连某个第三方渠道(不做网关中转) |
| `apply_models_async(codex_home, model_slugs, reload)` | 只切换模型目录 |
| `status_for_profile` / `get_status` | 探测当前处于哪个模式 |

- `CodexProfileMode`:`Missing / Unmanaged / DirectAccount / DirectAggregate / Gateway / ManagedUnknown` —— **能识别"用户原本手动配的 profile",避免误改**。
- 定位 `codex_home`:`CODEX_HOME` → `HOME/.codex` → `USERPROFILE` → `HOMEDRIVE+HOMEPATH`(`codex_runtime.rs:162-174`)。
- **备份**:`ensure_backup(&profile_dir)` 保存 `auth.json` / `config.toml` 原件;历史备份目录 `~/.codexmanager_history_backups`,保留策略默认最多 3 份、7 天。
- **原子写**:`write_atomic(path, content)`。
- **并发保护**:`PROFILE_MUTATION_LOCK: Mutex<()>` + `PROFILE_PHASE_WORKERS: Semaphore(8)`,所有 profile 变更串行化。
- **状态标记**:`.codexmanager_profile.json`(marker)+ `app_settings` 里的 `codex_profile.state` / `codex_profile.backups` / `codex_profile.codex_home`。
- **历史会话修复**:`history_repair` —— 切 provider 时同步修正 `state_5.sqlite` 的 `threads.model_provider` 与 rollout 文件,否则 Codex 历史会话会因 provider 不匹配报错。这个坑很少有人想到,值得抄。

### 7.3 环境变量覆盖规则 `crates/service/src/app_settings/env_overrides/`

目录:`manager.rs` / `normalize.rs` / `process.rs` / `snapshot.rs` / `catalog/{items.rs,mod.rs}`

- **白名单目录**:`ENV_OVERRIDE_CATALOG`,每项 = `(KEY, 中文说明, scope, apply_mode, 默认值)`;scope ∈ `service/desktop/web`,apply_mode ∈ `runtime/restart`。
- **不允许被 UI 覆盖**:`APP_SETTINGS_ENV_UNSUPPORTED_KEYS = [CODEXMANAGER_DB_PATH, CODEXMANAGER_RPC_TOKEN, CODEXMANAGER_RPC_TOKEN_FILE]`(安全相关)。
- **保留键**:`APP_SETTINGS_ENV_RESERVED_KEYS`(`CODEXMANAGER_ACCOUNT_MAX_INFLIGHT`、`CODEXMANAGER_ROUTE_STRATEGY`、`CODEXMANAGER_SERVICE_ADDR`…)—— 这些只能由专门的 settings 写入路径改,避免被环境变量编辑器绕过语义。
- **优先级**:**显式 settings 字段 > 环境变量编辑器值**。`PreparedEnvOverrides::align_runtime_settings()` 在同一事务里把 settings 值对齐进 env map(如 `APP_SETTING_GATEWAY_QUOTA_GUARD_KEY` → 4 个 `CODEXMANAGER_QUOTA_GUARD_*` 变量),注释:
  > `An explicit settings field wins over an environment editor value in the same transaction. Keep any existing overlapping override in agreement so a later environment patch or restart cannot restore a stale value.`
- **稀疏语义**:普通 settings 写入不会顺手生成一份完整默认 env 快照(`prepare_env_overrides_for_settings` 只在已存在覆盖快照时才动手)。
- **发布时机**:先 `prepare`(算 next/previous diff)→ 持久化 JSON → 再 `publish` 到进程环境(`std::env::set_var`),保证崩溃一致。
- **NUL 校验**:`set_var` 不接受 NUL,写入前统一拒绝。

---

## 8. 是否支持非 ChatGPT 上游 —— **支持,且是一等公民**

### 8.1 两条路径

**(a) 平台 Key 级 `upstream_base_url`**(`crates/service/src/apikey/apikey_profile.rs`)
```rust
pub(crate) fn normalize_upstream_base_url(value: Option<String>) -> Result<Option<String>, String> {
    // 必须是 http/https,去掉尾部 '/'
}
```
一个平台 Key 可以指定自己的上游 base_url(配合 `protocol_type` + `static_headers_json`)。

**(b) 聚合渠道表 `aggregate_apis`**(`crates/core/src/storage/mod.rs:1315`,迁移 `037_aggregate_api_routing.sql`)

```rust
pub struct AggregateApi {
    id, provider_type,          // codex | claude | gemini | compatible
    supplier_name: Option<String>,
    sort: i64, url: String,
    auth_type: String,          // apikey | userpass
    auth_params_json: Option<String>,  // {"location":"header|query","name":"...","headerValueFormat":"bearer|raw"}
    action: Option<String>,     // 覆写请求路径
    model_override: Option<String>,
    user_agent: Option<String>,
    status, created_at, updated_at,
    last_test_at/status/error,
    balance_query_enabled, balance_query_template, balance_query_base_url, ...,
    last_balance_at/status/error/json,
}
```
常量定义:`crates/service/src/aggregate_api.rs:29-34`
```rust
pub(crate) const AGGREGATE_API_PROVIDER_CODEX:     &str = "codex";
pub(crate) const AGGREGATE_API_PROVIDER_CLAUDE:     &str = "claude";
pub(crate) const AGGREGATE_API_PROVIDER_GEMINI:     &str = "gemini";
pub(crate) const AGGREGATE_API_PROVIDER_COMPATIBLE: &str = "compatible";
pub(crate) const AGGREGATE_API_AUTH_APIKEY:  &str = "apikey";
pub(crate) const AGGREGATE_API_AUTH_USERPASS:&str = "userpass";
```
`normalize_provider_type_value()` 接受别名:`claude|anthropic|anthropic_native|claude_code`、`gemini|gemini_native|google|google_ai|google_gemini`、`compatible`,默认落到 `codex`。

### 8.2 鉴权注入 `crates/service/src/gateway/upstream/protocol/aggregate_api.rs::parse_auth_config`

支持 7 种形态:
`ApiKeyDefaultBearer` / `ApiKeyHeader{name,format:bearer|raw}` / `ApiKeyQuery{name}` / `UserPassBasic` / `UserPassHeaderPair{username,password}` / `UserPassQueryPair`。

### 8.3 渠道轮转策略 `crates/service/src/apikey/apikey_profile.rs`

```rust
pub(crate) const ROTATION_ACCOUNT:              &str = "account_rotation";
pub(crate) const ROTATION_AGGREGATE_API:         &str = "aggregate_api_rotation";
pub(crate) const ROTATION_HYBRID:                &str = "hybrid_rotation";
pub(crate) const ROTATION_HYBRID_AGGREGATE_FIRST:&str = "hybrid_aggregate_first_rotation";
```
`normalize_rotation_strategy` 接受中英文别名(`账号轮转`/`聚合api`/`混合轮转`/`聚合优先`)。

- `resolve_aggregate_api_rotation_candidates(storage, protocol_type, aggregate_api_id)` —— 按 protocol 选 provider_type,`list_active_aggregate_apis_by_provider_type`,`normalize_candidate_order`(按 `sort` → `created_at desc` → `id`),指定 id 则 `promote_preferred_aggregate_candidate` 提到队首。
- `apply_gateway_route_strategy_to_aggregate_candidates` —— 渠道之间也复用同一套 round-robin/P2C(优先渠道保持队首时只轮转其余)。
- **桥接**:`should_bridge_responses_to_anthropic(candidate, path)` —— 当渠道 provider 是 `claude` 而请求是 `/v1/responses` 时,调用 `adapt_openai_responses_to_anthropic_messages` 改写到 `/v1/messages`,响应侧用 `ResponseAdapter::ResponsesFromAnthropicMessages` 转回。**这正是"Responses 协议 → 第三方厂商"的关键胶水。**
- **每渠道重试**:`AGGREGATE_API_RETRY_ATTEMPTS_PER_CHANNEL = 3`,渠道内重试 + 渠道间切换。
- **兜底策略**:`AggregateFailurePolicy::{RespondError, ReleaseRequest}` —— `ReleaseRequest` 用于"聚合优先、账号兜底":聚合路径失败且请求未被消费时**把请求归还给调用方**,继续走账号池。

### 8.4 Ollama / 第三方 base_url

- 任意 http/https base_url 都可配(`normalize_upstream_base_url` 只校验 scheme),所以 Ollama(`http://localhost:11434`)作为 `compatible` 渠道在原理上可行。
- 但**没有 Ollama 专用适配器**:`compatible` 类型只是把 Responses 请求原样发过去(`Passthrough`),Ollama 的 `/v1/chat/completions` 需要 `ChatCompletionsFromResponses` 适配器。**本项目的 `ChatCompletionsFromResponses` 变体在 `ResponseAdapter` 枚举中存在,但请求方向的"Responses → chat/completions"改写函数我没有在 `protocol_adapter/request_router.rs` 中看到对应实现(`adapt_openai_responses_to_anthropic_messages` 有,chat/completions 方向的请求改写缺失)。这是本项目的一个空档,你要做多厂商网关必须自己补。**

---

## 9. 总结:哪些值得照抄,哪些是 ChatGPT 专属耦合

### 9.1 ✅ 强烈建议照抄(与厂商无关的通用网关能力)

| # | 能力 | 参考文件 | 为什么值得 |
|---|---|---|---|
| 1 | **axum fallback 兜底 + 少量专用路由** | `http/proxy_runtime.rs:620` | 所有路径都能进网关,新协议只需加一条路由;`/health` `/metrics` 放闸门外保证饱和可探活 |
| 2 | **传输层与领域层解耦** | `http/gateway_request.rs` `GatewayRequest` | `GatewayRequest` 抽象掉 HTTP,`respond_async` 用 `mpsc(2)` 有界通道做背压,下游断开 → `watch` 取消上游;idle 流不占 blocking worker |
| 3 | **旁路 SSE 观测器** | `gateway/observability/http_bridge/` | 转发原始字节的同时旁路解析 usage/终止事件/错误,`accept-encoding: identity` 解决"压缩导致观测失败"。**做用量统计的正确姿势。** |
| 4 | **候选快照缓存 + 额度守卫** | `routing/selection.rs` | 500ms TTL 快照 + 阈值剔除 + `force_enabled` 豁免 + 受限池内独立判定 |
| 5 | **ordered / balanced 轮询 + P2C 健康交换** | `routing/route_hint.rs` | 游标按 account_id 记(池变动不串位);P2C 只在前 window 内 swap 头部;按 `key_id|model` 隔离状态 |
| 6 | **软约束的冷却/并发跳过** | `upstream/support/candidates.rs` | 最后一个候选永不跳过,把可恢复抖动挡在全局不可用之前 |
| 7 | **模型不支持记忆(带 TTL,全被标记时不剔除)** | `candidates.rs::drop_known_unsupported_model_candidates` | 保持错误可诊断性 |
| 8 | **协议适配的"请求改写 + 响应适配器 + 工具名回填表"三件套** | `protocol_adapter/{request_router.rs,types.rs}` | `AdaptedGatewayRequest{path, body, response_adapter, tool_name_restore_map}` 是干净的抽象;工具名短名映射解决长工具名问题 |
| 9 | **通道化的认证注入** | `upstream/protocol/aggregate_api.rs::parse_auth_config` | 7 种 auth 形态统一建模 |
| 10 | **配置改写 + 备份 + 原子写 + 状态机识别** | `codex_profile.rs` | `Unmanaged` 模式识别、`ensure_backup`、`write_atomic`、全局 mutation 锁 |
| 11 | **切 provider 时修历史会话** | `codex_profile.rs::history_repair` | `state_5.sqlite` 的 `threads.model_provider` + rollout 文件同步。**极实用的坑位知识。** |
| 12 | **env 覆盖目录化 + settings 优先 + 先持久化后发布** | `app_settings/env_overrides/` | 白名单目录、保留键、NUL 校验、稀疏快照 |
| 13 | **attempt chain 观测** | `032_request_logs_attempt_chain.sql` + `proxy_pipeline/` | 每次尝试的 URL/状态/耗时都留痕,排障成本极低 |
| 14 | **客户端断连记 499** | `proxy_runtime.rs::DisconnectTrackingBody` | 与 502 区分开 |
| 15 | **zstd 请求体解压 + 流式请求不套整体超时** | `proxy_runtime.rs` | 直接对接 Codex CLI 的实际传输行为 |

### 9.2 ⚠️ ChatGPT 专属耦合,必须替换

| 耦合点 | 文件 | 替换方向 |
|---|---|---|
| **账号表 `issuer/chatgpt_account_id/workspace_id` + `tokens(id_token/access_token/refresh_token)`** | `core/src/storage/mod.rs:80,599`;`migrations/001,011` | 抽象为 `Channel` + `ChannelCredential`(通用 secret),把 ChatGPT OAuth 换成通用 `api_key` / `bearer` / `userpass` 形态 |
| **OAuth PKCE 登录流程** | `service/src/auth/{auth_login,auth_callback,auth_login_completion}.rs` | 换成各厂商 OAuth/API Key 管理;`login_sessions` 表可保留 |
| **ChatGPT usage 端点轮询 + 5h/周窗口语义** | `service/src/usage/*` | 抽象为 `QuotaProvider` trait:ChatGPT 用窗口百分比,Anthropic 用 `x-ratelimit-*` 头,OpenAI API Key 用 `rate_limits` 响应体,第三方渠道用余额查询(`balance_query_*` 那套已经存在,可直接泛化) |
| **`chatgpt-account-id` 出站头 / `originator` / `x-codex-turn-state` / `x-codex-turn-metadata`** | `upstream/headers/codex_headers.rs`;`http/codex_source.rs` | 这些是 OpenAI 内部协议,只在"上游真是 ChatGPT"时才注入;应做成 per-provider 的 header profile |
| **`chatgpt.com/backend-api/codex` 硬编码路径** | `upstream/config.rs::should_send_chatgpt_account_header`;`codex_model_catalog.rs::official_chatgpt_account_id` | 改为渠道级 `upstream_path_template` |
| **`reasoning.encrypted_content` 账号作用域** | `upstream/support/payload_rewrite.rs`;`responses_websocket_rebase.rs` | 保留(Responses 协议本身就依赖它),但换号时剥离逻辑必须保留;非 OpenAI 上游若不支持需主动丢弃 |
| **Codex CLI 客户端识别(UA `codex_cli_rs` + 一堆 `x-codex-*` 头)** | `gateway/local_validation/request.rs:1443` | **保留**,这正是你要的"识别 Codex CLI"的实现,直接抄 |
| **`model_catalog_v2` / `model_groups` / `model_billing_v2` / `model_price_rules`(约 1.5 万行)** | `core/src/storage/` | 这是 Codex-Manager 的"产品化目录"业务,不是网关必需。你的项目可只保留 `slug → 上游模型名` 的最小映射 |
| **明文 token 存储** | `core/src/storage/tokens.rs`、`aggregate_api_secrets` | **必须改**:OS keychain 或主密钥 AES-GCM 加密 |
| **Responses WebSocket 实现(4400+ 行 + 定制 tungstenite fork)** | `http/responses_websocket.rs` | 需求存在时才抄;依赖 openai-oss-forks 的 tungstenite patch(`Cargo.toml` `[patch.crates-io]`),移植成本高 |
| **`usage_snapshots` 的 used_percent/window_minutes 语义** | `core/src/storage/mod.rs:700` | 泛化为 `QuotaSnapshot { used, limit, window, resets_at, raw_json }` |
| **free/go/plus/pro 套餐判定** | `account_plan.rs`、`account_subscriptions` | 泛化为渠道的 `tier` + `cost_class` |
| **`AgentIdentity` / `encryptedTaskId`** | `core/src/storage/mod.rs:94`;`service/src/agent_identity.rs` | OpenAI 特有,丢弃 |
| **RPC 管理面(`/rpc` + `x-codexmanager-rpc-token`)** | `http/rpc_endpoint.rs` | 保留形状(便于 Web UI/CLI 控制),但可换成自己的 |

### 9.3 做"多厂商聚合网关给 Codex CLI"时的最小可行路线

1. **入口**:照抄 `proxy_runtime.rs` 的 axum 结构 —— `/v1/responses`(含 WS 升级)、`/v1/chat/completions`、`/health`、`/metrics`,其余 fallback。
2. **识别**:直接抄 `is_native_codex_client_request()`(UA + `x-codex-*` 头组合),这是"Codex CLI 专用模式"的开关(WS、turn-state 透传、model_catalog 注入等行为都挂在它上面)。
3. **渠道抽象**:把 `Account` 换成 `Channel { id, kind: ChatGpt|ApiKey|OpenAi|Anthropic|Gemini|Ollama, base_url, auth, model_map, weight, priority, quota }`。**`aggregate_apis` 的表结构已经非常接近这个目标,可以直接借鉴其字段**(`provider_type / url / auth_type / auth_params_json / action / model_override / user_agent / sort / status / balance_query_*`)。
4. **选路**:抄 `route_hint.rs`(ordered/balanced + P2C)+ `selection.rs`(候选快照 + 额度守卫)。把 `Account` 换成 `Channel` 即可;`QuotaGuard` 的阈值剔除改成"按渠道剩余额度百分比"通用化。**再加一个"按剩余额度降序"**(本项目没有)。
5. **协议适配**:抄 `protocol_adapter/{types.rs, request_router.rs}` 的 `AdaptedGatewayRequest` 抽象。**必须自己补 "Responses → chat/completions" 的请求改写**(本项目缺),这样 Ollama / DeepSeek / Qwen 兼容端点才能用。SSE 响应侧照抄 `http_bridge/stream_readers/{openai_responses,chat_completions,responses_from_anthropic}.rs`。
6. **失败处理**:抄 `upstream/support/{candidates,retry,failover_policy,deadline,backoff}.rs` 的"软约束 + 渠道内重试 + 渠道间切换 + 总 deadline"。
7. **接入 Codex CLI**:直接抄 `codex_profile.rs::patch_config_for_gateway` 的 TOML 形态:
   ```toml
   model_provider = "cm"
   [model_providers.cm]
   name = "cm"
   base_url = "http://127.0.0.1:PORT/v1"
   wire_api = "responses"
   requires_openai_auth = true
   ```
   并把 `apply_gateway_async` 的备份/原子写/历史会话修复一并搬过来。
8. **务必自研的两块**:token 加密存储;请求级 rate-limit 感知(读 `x-ratelimit-*` 头,而不是只靠轮询)。
