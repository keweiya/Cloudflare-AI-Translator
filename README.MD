# 🌐 CF-Worker-AI-Translator

基于 **Cloudflare Workers** 构建的高性能 AI 翻译助手。集成了流式传输 (SSE)、长句翻译、单词深度解析以及 Cloudflare Turnstile 安全校验。

### ✨ 项目特性

* **⚡ 边缘加速**：运行在 Cloudflare 全球边缘网络，响应极速。
* **🤖 AI 智能识别**：自动判断输入内容：
    * **输入单词/短语**：自动转为“词典模式”，输出含义、词性、搭配及例句。
    * **输入长句/段落**：自动转为“翻译模式”，输出纯净、自然的译文。
* **🌊 流式输出**：基于 Server-Sent Events (SSE)，结果逐字呈现，无需漫长等待。
* **🛡️ 安全防护**：内置 **Cloudflare Turnstile** 人机验证，防止 API 接口被恶意刷取。
* **🌓 极致体验**：支持暗黑模式切换、翻译历史本地存储、一键复制。

---

### 🚀 快速部署 (极简版)

本项目采用**单文件部署**模式，无需本地开发环境。

#### 第一步：创建 Worker
1.  登录 [Cloudflare 控制台](https://dash.cloudflare.com/)。
2.  进入 **Workers & Pages** -> **Create application** -> **Create Worker**。
3.  设置名称（如 `ai-translator`）并点击 **Deploy**。
4.  点击 **Edit Code**，将本仓库 `worker.js` 中的全部代码复制并替换掉原有代码。
5.  点击右上角 **Save and Deploy**。

#### 第二步：配置环境变量 (必需)
在 Worker 管理界面，进入 **Settings** -> **Variables**，添加以下环境变量：

| 变量名称 | 类型 | 说明 | 示例值 |
| :--- | :--- | :--- | :--- |
| **`CUSTOM_API_BASE_URL`** | Text | AI 接口的基础地址（旧名 `BASE_URL` 仍兼容） | `https://api.openai.com/v1` |
| **`CUSTOM_API_MODEL`** | Text | 使用的模型名（旧名 `API_MODEL` 仍兼容，强烈建议显式配置） | `gpt-4o-mini` |
| **`CUSTOM_API_KEY`** | **Secret** | 你的 AI 接口密钥（旧名 `API_KEY` 仍兼容） | `sk-xxxxxx` |
| **`ENABLE_TURNSTILE`** | Text | 是否启用 Turnstile 验证，设为 `false` 可关闭 | `true` |
| **`TURNSTILE_SITE_KEY`** | Text | Turnstile 的站点密钥 | `0x4AAAAAA...` |
| **`TURNSTILE_SECRET_KEY`** | **Secret** | Turnstile 的私钥 | `0x4AAAAAA...` |
| **`SESSION_SECRET`** | **Secret** | 随机字符串，用于会话签名 | `随便输入一段长字符` |

> **注意**：敏感信息请务必使用 **Secret** 类型存储（点击 `Encrypt` 加密）。

#### 使用 Cloudflare Workers AI（可选）

不接第三方接口时，可以绑定 Workers AI：

| 变量名称 | 类型 | 说明 | 示例值 |
| :--- | :--- | :--- | :--- |
| **`CF_AI`** | Text | 设为 `true` 时使用 Workers AI 绑定（无需 `CUSTOM_API_*`） | `false` |
| **`CF_MODEL`** | Text | Workers AI 模型名，`CF_AI=true` 时必填 | `@cf/meta/llama-3.2-3b-instruct` |
| **`CF_MODEL_FALLBACK`** | Text | 备用模型，逗号分隔；主模型失败自动降级（可选） | `@cf/ibm-granite/granite-4.0-h-micro` |
| **`CF_MAX_TOKENS`** | Text | 单次生成的最大 token 数（默认 `4096`） | `8192` |
| **`CF_EXTRA_PARAMS`** | Text | 透传给模型的额外参数（JSON 字符串，可选） | `{"chat_template_kwargs":{"enable_thinking":false}}` |

同时在 **Settings** -> **Bindings** 中添加 `AI` 绑定（Workers AI）。

> **`CF_MAX_TOKENS` 很重要**：部分 Workers AI 模型默认输出上限极小（例如 `llama-3.2-3b-instruct` 默认只有 256 token），不显式指定会导致长文译文被截断。翻译长文章时建议调到 `8192`。

#### 怎么选模型（内容翻译场景）

挑模型时看模型页上的标签，避开两个坑：

1. **带 `Reasoning` 标记的模型**（如 `glm-4.7-flash`、`qwen3-30b-a3b-fp8`、`gemma-4-26b-a4b-it`）会先"思考"再回答：慢，思考的 token 同样计费，小 `max_tokens` 下还可能把答案挤没，表现为"失败几次才成功"。**翻译用不带 Reasoning 的模型更稳。**
2. **带「第三方」标记的模型**（GPT / Claude / Grok 等）属于 AI Gateway 目录，需要预付余额并指定 `gateway`，**用不了每天的免费 Neurons 额度**。

推荐组合（均为 Cloudflare 托管、免费额度可用）：

| 定位 | 模型 | 上下文 | 单价(输入/输出 每 M) |
| :--- | :--- | :--- | :--- |
| 主力（快、稳、便宜） | `@cf/meta/llama-3.2-3b-instruct` | 80,000 | $0.0509 / $0.335 |
| 极致省钱 | `@cf/ibm-granite/granite-4.0-h-micro` | 131,000 | $0.017 / $0.112 |
| 质量优先 | `@cf/openai/gpt-oss-120b` | 见模型页 | $0.35 / $0.75 |

想先试效果，可以直接用官方 Playground（无需配置）：

```text
https://playground.ai.cloudflare.com/?model=@cf/meta/llama-3.2-3b-instruct
```

#### 超时与稳定性调优（可选）

| 变量名称 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| **`UPSTREAM_IDLE_TIMEOUT_MS`** | Text | `40000` | 上游多久没有任何数据返回就判定超时并重试 |
| **`UPSTREAM_TOTAL_TIMEOUT_MS`** | Text | `300000` | 单次翻译请求的总时间上限，超过后直接报错 |
| **`UPSTREAM_MAX_ATTEMPTS`** | Text | `3` | 上游失败自动重试次数（1-5），第 2 次起自动改用 `CF_MODEL_FALLBACK` |
| **`SSE_HEARTBEAT_MS`** | Text | `15000` | 流式心跳间隔，避免网关/浏览器掐断长时间空闲的连接 |
| **`REPAIR_TIMEOUT_MS`** | Text | `25000` | 词汇模式例句修复的超时时间 |

> 如果模型本身较慢（例如带思考链的推理模型），可把 `UPSTREAM_IDLE_TIMEOUT_MS` 调大（如 `90000`）。


#### 快捷关闭认证

如果只是自己使用，想临时关闭 Cloudflare Turnstile 认证，可在 Worker 的 **Settings** -> **Variables** 中添加：

```env
ENABLE_TURNSTILE=false
```

关闭后：

- 访问页面时将不再显示 Turnstile 验证层
- `/api/session` 和 `/api/verify` 会直接放行
- 翻译接口不再校验会话 cookie
- `TURNSTILE_SITE_KEY`、`TURNSTILE_SECRET_KEY`、`SESSION_SECRET` 可不配置

如需重新开启认证，将该变量删除，或改回：

```env
ENABLE_TURNSTILE=true
```

#### 第三步：设置 Turnstile
1.  在 Cloudflare 侧边栏进入 **Turnstile**。
2.  添加站点，域名填写你的 Worker 域名（例如 `xxx.workers.dev`）。
3.  将生成的 `Site Key` 和 `Secret Key` 填入上方的环境变量中。

---

### 🛠️ 进阶配置

如果你想更换使用的 AI 模型，推荐直接配置环境变量 `CUSTOM_API_MODEL`（旧名 `API_MODEL` 仍兼容）。

> 建议：不同 OpenAI 兼容平台的默认模型名可能不同。若出现“偶发无结果”，请优先确认 `CUSTOM_API_MODEL` 是否为该平台支持的模型。

### ⏱️ 关于“AI 翻译超时”

早期版本在下列环节会让请求无限期挂起，表现为前端一直转圈、最终超时失败：

1. 上游 `fetch` 没有任何超时控制，模型卡住时请求永久挂起。
2. 流式响应没有心跳，长时间无数据时容易被网关/浏览器掐断。
3. 首字节之前不返回任何内容，慢模型会让浏览器长时间空等。
4. Cloudflare Workers AI 的流式数据是 `{"response":"..."}` 格式，与 OpenAI 的 `choices[].delta.content` 不同，解析不到内容就一直重试。
5. 词汇模式的“例句修复”二次调用会拖住整个请求。
6. 调用 Workers AI 时没有传 `max_tokens`，而部分模型默认输出上限极小（`llama-3.2-3b-instruct` 默认仅 256 token），长文会被截断、推理模型更是会把答案挤成空内容，最终表现为“失败几次才成功”。

现已修复：

* 上游请求增加 **空闲超时** 与 **总超时**，并支持自动重试（重试时前端会收到 `reset` 事件，不会出现两次结果拼接）。
* 显式传入 **`max_tokens`**（`CF_MAX_TOKENS`，默认 4096），长文不会再被模型默认的小上限截断。
* 支持 **`CF_MODEL_FALLBACK`**：主模型失败后自动降级到备用模型，而不是反复重试同一个不稳定的模型；报错时会列出尝试过的模型。
* 增加 **SSE 心跳**（`event: ping`），长时间无内容也不会断开连接。
* 请求一开始就返回 `start` 事件，浏览器立刻拿到响应头。
* 同时兼容 **OpenAI 兼容接口** 与 **Cloudflare Workers AI** 的流式格式，并兜底处理“忽略 `stream:true` 直接返回整段 JSON”的平台。
* 客户端增加 **看门狗**：服务端彻底失联时自动中断并给出超时提示，而不是无限等待。
* 词汇模式先返回结果再做例句修复，二次调用超时也不会卡住请求。
* 客户端断开连接时，立即中止上游请求，不再浪费配额。

### 📜 开源协议

本项目基于 **MIT** 协议开源。

---

**完成部署后，直接访问你的 Worker 链接即可开启你的专属 AI 翻译站！**
