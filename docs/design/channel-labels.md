# 渠道名称与厂商标识

核对日期：2026-10-26。映射位于 `ui/channels.js`，只影响展示，不改变账号 ID、授权参数或统一模型池。

- 下拉框显示「产品名 + 已有中文名 · 所属厂商」，第二行保留原始渠道 ID。
- 总览渠道标签、账号列表、客户端接入的授权提示共用同一映射。
- 产品英文名、中文名、厂商名和原始 ID 均可用于搜索；未知渠道直接显示原始 ID，不推测厂商。
- 不给 Cline、TRAE、Loomy 等硬造中文译名。Gemini 账号渠道具体接入的是 Gemini Code Assist，不混同下游 Gemini CLI。

## 来源

| 渠道 | 名称与厂商核对依据 |
| --- | --- |
| CodeArts | [华为云码道官网](https://codearts.huaweicloud.com/index.html) |
| LobsterAI | [有道龙虾官网](https://lobsterai.youdao.com/en) |
| Qoder / Qoder CN | [阿里云官方发布](https://developer.aliyun.com/article/1758676)、[Qoder CN 账号说明](https://docs.qoder.cn/product-overview/account-subscription-faq) |
| TRAE | [TRAE 官网](https://www.trae.cn/)，本地渠道包同时声明 `TRAE (字节)` |
| Cline | [Cline Bot Inc. 服务条款](https://cline.bot/tos) |
| Loomy | [讯飞 Loomy 官网](https://loomy.xunfei.cn/)，本地适配器声明 `Loomy (讯飞)` |
| Raccoon | 本地适配器声明 `Raccoon (商汤)`，渠道指向商汤服务；[商汤发布的小浣熊说明](https://www.sohu.com/a/1067374847_99963310) |
| MiniMax Code | [MiniMax 官网的产品列表](https://www.minimax.cn/) |
| Gemini Code Assist | 本地适配器声明 `Gemini Code Assist`，接入 Google 服务 |
| ZCode | [ZCode 用户协议中的智谱运营主体](https://zcode.z.ai/cn/terms) |

展示的厂商信息用于识别账号来源，不代表该厂商提供的所有模型都由它自行研发。
