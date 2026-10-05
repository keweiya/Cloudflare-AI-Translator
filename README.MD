# 🌐 CF-Worker-AI-Translator

基于 **Cloudflare Workers** 构建的高性能 AI 翻译助手。集成了流式传输 (SSE)、长句翻译、单词深度解析以及 Cloudflare Turnstile 安全校验。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/keweiya/Cloudflare-AI-Translator)

> 点上面的按钮即可把本项目部署到自己的 Cloudflare 账号（自动创建 Worker 并绑定 Workers AI）。
> 仓库需为公开仓库；部署完成后按提示补齐密钥即可使用。

### ✨ 项目特性

* **⚡ 边缘加速**：运行在 Cloudflare 全球边缘网络，响应极速。
* **🤖 AI 智能识别**：自动判断输入内容：
    * **输入单词/短语**：自动转为“词典模式”，输出含义、词性、搭配及例句。
    * **输入长句/段落**：自动转为“翻译模式”，输出纯净、自然的译文。
* **🌊 流式输出**：基于 Server-Sent Events (SSE)，结果逐字呈现，无需漫长等待。
* **🛡️ 安全防护**：内置 **Cloudflare Turnstile** 人机验证，防止 API 接口被恶意刷取。
* **🎨 现代界面**：
    * 双栏工作台（原文 / 译文），卡片式布局，移动端自动单栏。
    * 明暗主题，首次访问跟随系统设置。
    * 状态胶囊（翻译中 / 完成 / 失败）、加载骨架屏、打字光标。
    * 历史记录抽屉，支持关键字搜索、单条删除、点击回填。
    * 一键复制、示例快捷输入、Toast 轻提示、`Ctrl/Cmd + Enter` 立即翻译。
    * Markdown 渲染增强：标题、列表、**加粗**、*斜体*、引用、代码块、链接。

---

### 🚀 部署方式（三选一）

**方式 A：一键部署（推荐）** — 点本文顶部的 **Deploy to Cloudflare** 按钮，按提示授权即可，Workers AI 绑定和默认参数会自动配置。

**方式 B：Wrangler CLI** — 仓库已内置 [`wrangler.toml`](wrangler.toml)：

```bash
git clone https://github.com/keweiya/Cloudflare-AI-Translator.git
cd Cloudflare-AI-Translator
npx wrangler deploy
```

**方式 C：手动粘贴（极简）**

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)，进入 **Workers & Pages** -> **Create application** -> **Create Worker**。
2. 设置名称并点击 **Deploy**。
3. 点击 **Edit Code**，将本仓库 `worker.js` 中的全部代码复制并替换掉原有代码，点击 **Save and Deploy**。
4. 在 **Settings** -> **Bindings** 添加 **Workers AI** 绑定，变量名必须是 `AI`。

#### 配置环境变量 (必需)
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
>
> ⚠️ `ENABLE_TURNSTILE=false` 时接口完全开放，**任何知道地址的人都能消耗你的 AI 额度**。公开部署请务必开启验证。

#### 使用 Cloudflare Workers AI（可选）

不接第三方接口时，可以绑定 Workers AI：

| 变量名称 | 类型 | 说明 | 默认值 |
| :--- | :--- | :--- | :--- |
| **`CF_AI`** | Text | 设为 `true` 时使用 Workers AI 绑定（无需 `CUSTOM_API_*`） | `false` |
| **`CF_MODEL`** | Text | Workers AI 模型名 | `@cf/zai-org/glm-4.7-flash` |
| **`CF_MAX_TOKENS`** | Text | 单次生成的最大 token 数 | `8192` |
| **`CF_EXTRA_PARAMS`** | Text | 透传给模型的额外参数（JSON 字符串） | `{"chat_template_kwargs":{"enable_thinking":false}}` |

同时在 **Settings** -> **Bindings** 中添加 `AI` 绑定（Workers AI）。

> **三个默认值都可以不配**：不设置这些变量时，代码内置的默认值就是上表右列，也就是 `glm-4.7-flash` + 关闭思考链 + `max_tokens=8192`。
>
> **`CF_MAX_TOKENS` 很重要**：部分 Workers AI 模型默认输出上限极小（例如 `llama-3.2-3b-instruct` 默认只有 256 token），不显式指定会导致长文译文被截断。

#### 怎么选模型（内容翻译场景）

挑模型时看模型页上的标签，避开两个坑：

1. **带 `Reasoning` 标记的模型**（如 `qwen3-30b-a3b-fp8`、`gemma-4-26b-a4b-it`）会先"思考"再回答：慢，思考的 token 同样计费，小 `max_tokens` 下还可能把答案挤没，表现为"失败几次才成功"。
   > 本项目**默认已关闭思考链**（`CF_EXTRA_PARAMS` 里的 `enable_thinking: false`），`glm-4.7-flash` 默认即为推荐配置，可放心使用。
2. **带「第三方」标记的模型**（GPT / Claude / Grok 等）属于 AI Gateway 目录，需要预付余额并指定 `gateway`，**用不了每天的免费 Neurons 额度**。

如果想换更轻量的模型：

| 定位 | 模型 | 上下文 | 单价(输入/输出 每 M) |
| :--- | :--- | :--- | :--- |
| **默认（推荐）** | `@cf/zai-org/glm-4.7-flash` | 131,072 | $0.0605 / $0.40 |
| 极致省钱 | `@cf/ibm-granite/granite-4.0-h-micro` | 131,000 | $0.017 / $0.112 |
| 无思考链、更快 | `@cf/meta/llama-3.2-3b-instruct` | 80,000 | $0.0509 / $0.335 |
| 质量优先 | `@cf/openai/gpt-oss-120b` | 见模型页 | $0.35 / $0.75 |

想先试效果，可以直接用官方 Playground（无需配置）：

```text
https://playground.ai.cloudflare.com/?model=@cf/zai-org/glm-4.7-flash
```

#### 对外开放 API（可选）

除网页界面外，还提供 JSON 接口，方便脚本、插件或其它程序调用。

| 接口 | 方法 | 说明 |
| :--- | :--- | :--- |
| `/api/translate` | POST | 一次性返回 JSON 结果（**需要 API Key**） |
| `/api/translate/stream` | POST | 网页使用的 SSE 流式接口（受 Turnstile 会话保护） |

**第一步：在后台设置 API Key**（可配置多个，英文逗号分隔）：

```bash
# 在项目目录执行，按提示输入密钥
npx wrangler secret put API_KEYS
# 例如输入： sk-my-key-1,sk-my-key-2
```

也可以在控制台 **Settings → Variables → Add** 中添加名为 `API_KEYS` 的变量（建议选 **Secret** 类型）。

> ⚠️ **未配置 `API_KEYS` 时该接口默认关闭**（返回 403），避免额度被陌生人白嫖。
> 请勿把 Key 写进代码或提交到仓库。

**调用示例**：

```bash
curl -X POST "https://你的域名/api/translate" \
  -H "Authorization: Bearer sk-my-key-1" \
  -H "Content-Type: application/json" \
  -d '{"text":"hello","from":"en","to":"zh"}'
```

```json
{
  "ok": true,
  "result": "# 你好\n\n## 核心含义\n- 用于问候……",
  "mode": "word",
  "model": "@cf/zai-org/glm-4.7-flash",
  "from": "en",
  "to": "zh"
}
```

请求参数：

| 字段 | 必填 | 说明 |
| :--- | :--- | :--- |
| `text` | 是 | 要翻译的文本（≤ 12000 字符） |
| `from` | 否 | 源语言，默认 `auto`（自动检测），可选 `zh` / `en` / `ja` / `ko` |
| `to` | 否 | 目标语言，默认 `zh` |

鉴权也可以用 `X-API-Key: <key>` 请求头代替 `Authorization`。

响应状态码：`401` Key 缺失或错误 · `403` 未配置 `API_KEYS`（接口关闭）· `400` 参数问题 · `502` 上游调用失败。

浏览器/前端直接调用（跨域已开放）：

```js
const res = await fetch("https://你的域名/api/translate", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-API-Key": "sk-my-key-1" },
  body: JSON.stringify({ text: "Hello", to: "zh" }),
});
const data = await res.json();
console.log(data.result);
```

> 该接口没有内置限流（Workers 免费额度本身就是上限）。Key 一旦泄露请立即更换。

#### 超时与稳定性调优（可选）

| 变量名称 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| **`UPSTREAM_IDLE_TIMEOUT_MS`** | Text | `40000` | 上游多久没有任何数据返回就判定超时并重试 |
| **`UPSTREAM_TOTAL_TIMEOUT_MS`** | Text | `300000` | 单次翻译请求的总时间上限，超过后直接报错 |
| **`UPSTREAM_MAX_ATTEMPTS`** | Text | `3` | 上游失败自动重试次数（1-5） |
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
* 显式传入 **`max_tokens`**（`CF_MAX_TOKENS`，默认 8192），长文不会再被模型默认的小上限截断。
* 默认 **关闭思考链**（`enable_thinking: false`），推理模型不再"先思考"，速度与额度都更省。
* 增加 **SSE 心跳**（`event: ping`），长时间无内容也不会断开连接。
* 请求一开始就返回 `start` 事件，浏览器立刻拿到响应头。
* 同时兼容 **OpenAI 兼容接口** 与 **Cloudflare Workers AI** 的流式格式，并兜底处理“忽略 `stream:true` 直接返回整段 JSON”的平台。
* 客户端增加 **看门狗**：服务端彻底失联时自动中断并给出超时提示，而不是无限等待。
* 词汇模式先返回结果再做例句修复，二次调用超时也不会卡住请求。
* 客户端断开连接时，立即中止上游请求，不再浪费配额。

### ✅ 翻译质量保护

为了避免"译文不对、语言不对"这类问题：

* **输出语言自检**：译文生成后校验语言（例如目标中文却一个汉字都没有、目标英文却大段中文），命中时自动用**更严格的提示词重新生成一次**；重试后仍不正确则明确报错，而不会把语言不对的结果当成译文展示。
* **自动剥离模型多余输出**：`<think>` 思考链、```` ``` ```` 代码围栏、`译文：`／`Here is the translation:` 之类的前缀，以及末尾的"语境识别/Note"注释。
* **强制语言约束提示词**：明确告知模型源语言与目标语言，要求逐句翻译、不得遗留未翻译片段、不得输出解释。
* **超短内容不做语言判定**：避免把专有名词、技术术语误判为语言错误。
* 重试时前端收到 `reset` 事件，不会出现两次结果拼接。

### 📜 开源协议

本项目基于 **MIT** 协议开源。

---

**完成部署后，直接访问你的 Worker 链接即可开启你的专属 AI 翻译站！**
