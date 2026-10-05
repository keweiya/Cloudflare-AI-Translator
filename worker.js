// ============================================================================
// 默认配置（环境变量未设置时生效；wrangler.toml 中配置了同样的值）
// ============================================================================
const DEFAULT_CF_MODEL = "@cf/zai-org/glm-4.7-flash";
const DEFAULT_CF_MAX_TOKENS = 8192;
// 默认关闭思考链：推理模型先"思考"再回答，既慢又费额度，小 token 上限下还会把正文挤空
const DEFAULT_CF_EXTRA_PARAMS = { chat_template_kwargs: { enable_thinking: false } };

// 前端实时刷新节流：避免每个 token 都做一次全量字符串处理（节省 Worker CPU）
const LIVE_PUSH_INTERVAL_MS = 100;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  ...CORS_HEADERS,
};

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
  Connection: "keep-alive",
  ...CORS_HEADERS,
};

// ============================================================================
// 1. 入口与路由
// ============================================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return handleOptions();
    if (url.pathname === "/") {
      const turnstileEnabled = isTurnstileEnabled(env);
      return htmlResponse(getHtml(turnstileEnabled ? (env.TURNSTILE_SITE_KEY || "") : "", turnstileEnabled));
    }
    if (url.pathname === "/api/session" && request.method === "GET") {
      return handleSessionCheck(request, env);
    }
    if (url.pathname === "/api/verify" && request.method === "POST") {
      return handleVerify(request, env);
    }
    if (url.pathname === "/api/translate/stream" && request.method === "POST") {
      return handleTranslateStream(request, env);
    }
    return new Response("Not Found", { status: 404 });
  },
};

// ============================================================================
// 2. 会话与 Turnstile 校验
// ============================================================================
function isTurnstileEnabled(env) {
  const raw = String(env.ENABLE_TURNSTILE ?? "true").trim().toLowerCase();
  return !["false", "0", "off", "no"].includes(raw);
}

async function handleSessionCheck(request, env) {
  try {
    if (!isTurnstileEnabled(env)) return json({ ok: true, bypass: true });
    if (!env.SESSION_SECRET) return json({ error: "SESSION_SECRET 未配置" }, 500);
    const ok = await verifySessionCookie(request, env);
    return json({ ok: !!ok });
  } catch {
    return json({ ok: false });
  }
}

async function handleVerify(request, env) {
  try {
    if (!isTurnstileEnabled(env)) return json({ ok: true, bypass: true });
    if (!env.TURNSTILE_SECRET_KEY) return json({ error: "TURNSTILE_SECRET_KEY 未配置" }, 500);
    if (!env.SESSION_SECRET) return json({ error: "SESSION_SECRET 未配置" }, 500);
    const body = await request.json();
    const token = body?.turnstileToken;
    if (!token) return json({ error: "缺少 Turnstile token" }, 400);
    const ip = getClientIP(request);
    const verifyResult = await verifyTurnstile({
      secret: env.TURNSTILE_SECRET_KEY,
      token,
      ip,
    });
    if (!verifyResult.success) return json({ error: "Turnstile 校验失败" }, 403);
    const cookie = await buildSessionCookie(ip, env.SESSION_SECRET);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...JSON_HEADERS, "Set-Cookie": cookie },
    });
  } catch {
    return json({ error: "验证失败，请重试" }, 500);
  }
}

// ============================================================================
// 3. 翻译核心流程
// ============================================================================
async function handleTranslateStream(request, env) {
  try {
    const turnstileEnabled = isTurnstileEnabled(env);
    const upstream = resolveUpstreamConfig(env);
    if (upstream.useCFAI) {
      if (!env.AI || !upstream.model) {
        return json({ error: "CF AI configuration incomplete: need AI binding and CF_MODEL" }, 500);
      }
    } else if (!upstream.baseUrl || !upstream.apiKey || !upstream.model) {
      return json({ error: "Custom API configuration incomplete: need CUSTOM_API_BASE_URL, CUSTOM_API_KEY, and CUSTOM_API_MODEL" }, 500);
    }
    if (turnstileEnabled && !env.SESSION_SECRET) {
      return json({ error: "SESSION_SECRET is not configured" }, 500);
    }
    if (turnstileEnabled) {
      const validSession = await verifySessionCookie(request, env);
      if (!validSession) return json({ error: "Session invalid, please verify again" }, 401);
    }
    const body = await request.json();
    const text = body?.text || "";
    const requestedFrom = body?.from || "auto";
    const from = requestedFrom === "auto" ? inferSourceLangByText(text) : requestedFrom;
    const to = body?.to || "zh";
    const langProfile = detectTextLanguageProfile(text);
    if (!text.trim()) return json({ error: "Please enter text to translate" }, 400);
    if (text.length > 12000) return json({ error: "Text is too long. Please keep it under 12000 characters." }, 400);
    const isSingleWord = detectSingleWordQuery(text, from);
    const hasMixedSource = from === "mixed" || langProfile.isMixed;
    const isSameLang = from !== "auto" && !hasMixedSource && from === to;
    if (isSameLang) {
      return createImmediateTranslateStream(text);
    }

    const isShortText = text.length < 300 && text.split('\n').length <= 5;
    let messages = [];
    let wordTemplate = null;

    // 强制全局要求：禁止思考，只输出结果
    const NO_THINKING_PROMPT = "\nCRITICAL INSTRUCTION: Do NOT perform thinking, analysis, or reasoning. Do NOT use <think> or <analysis> tags. Directly output the final translation result immediately.";

    if (isSingleWord) {
      wordTemplate = getWordExplainTemplate(to);
      messages = [
        {
          role: "system",
          content:
            "You are a professional bilingual vocabulary assistant." + NO_THINKING_PROMPT + "\n" +
            "Output structured markdown only.\n" +
            "Use only unordered list items starting with '- '.\n" +
            "Do not use numbered lists.\n" +
            "Do not output explanations about your process.\n" +
            "All section titles and descriptions must be in target language.\n" +
            "IMPORTANT RULES:\n" +
            "1. The SOURCE WORD is the English word given by the user. You are explaining THIS English word.\n" +
            "2. The top heading (#) must be the DIRECT WORD-FOR-WORD translation, NOT a description or category.\n" +
            "   CORRECT examples: '# 你好' for hello, '# 员工' for employees, '# 猫' for cat.\n" +
            "   WRONG examples: '# 问候语' (this is a description, not a translation), '# [该词的中文对应词]' (placeholder).\n" +
            "3. Meaning and usage descriptions should be written in target language, explaining the SOURCE English word.\n" +
            "4. Collocations must be in the SOURCE language (English), with target language translation in parentheses.\n" +
            "5. Example sentences must be in the SOURCE language (English), with target language translation in parentheses.",
        },
        {
          role: "user",
          content:
            `The source word to explain is: "${text.trim()}" (English).\n` +
            `Explain this English word in ${mapLangName(to)}.\n\n` +
            `Use this exact structure:\n` +
            `# [Most common ${mapLangName(to)} translation of "${text.trim()}"]\n\n` +
            `## ${wordTemplate.meaning}\n` +
            `- (describe the meaning of the English word "${text.trim()}" in ${mapLangName(to)})\n` +
            `## ${wordTemplate.usage}\n` +
            `- (explain part of speech and usage of "${text.trim()}" in ${mapLangName(to)})\n` +
            `## ${wordTemplate.collocations}\n` +
            `- English collocation (${mapLangName(to)} translation)\n` +
            `## ${wordTemplate.examples}\n` +
            `- English example sentence. (${mapLangName(to)} translation)\n\n` +
            `Replace ALL bracket placeholders with actual content.\n` +
            `Except the top title, only use \`##\` headings and \`-\` bullet items.`,
        },
      ];
      if (messages[0]?.role === "system") {
        messages[0].content += "\n\n" + buildWordExampleRule(from, to, wordTemplate);
      }
    } else if (isShortText) {
      messages = [
        {
          role: "system",
          content:
            "You are a precise technical translator." + NO_THINKING_PROMPT + "\n" +
            "Output ONLY the translation result in the target language.\n" +
            "TRANSLATE EVERY PART of the input into the target language.\n" +
            "If input is mixed-language (e.g. Chinese + English), translate ALL of it.\n" +
            "Do not output explanations, reasoning, annotations, or extra notes.\n" +
            "Never leave any part untranslated.",
        },
        {
          role: "user",
          content:
            "Translate ALL of the following text entirely into " + mapLangName(to) + ".\n" +
            "Every single word must be translated into " + mapLangName(to) + ". Do not skip any part.\n\n" +
            "Source text:\n" + text,
        },
      ];
    } else {
      messages = [
        {
          role: "system",
          content:
            "You are a technical document translator." + NO_THINKING_PROMPT + "\n" +
            "Preserve original paragraph structure and markdown format.\n" +
            "TRANSLATE EVERY PART of the input into the target language.\n" +
            "If input contains mixed languages, translate ALL fragments.\n" +
            "Output translation only, without extra commentary.\n" +
            "Never leave any sentence or phrase untranslated.",
        },
        {
          role: "user",
          content:
            "Translate ALL of the following text entirely into " + mapLangName(to) + ".\n" +
            "Every paragraph, every sentence must be in " + mapLangName(to) + ".\n\n" +
            "Source text:\n" + text,
        },
      ];
    }
    if (messages[0]?.role === "system") {
      messages[0].content += "\n\n" + buildLanguageGuard(from, to, isSingleWord ? "word" : "translate");
      if (!isSingleWord && hasMixedSource) {
        messages[0].content +=
          "\n\nMixed-language handling (MUST follow):\n" +
          "- Input may contain multiple languages in one sentence.\n" +
          "- Translate all translatable parts into target language.\n" +
          "- Do not skip English/foreign fragments just because some parts are already in target language.\n" +
          "- Keep essential technical terms only when translating them would reduce clarity.";
      }
    }

    const targetModel = upstream.model;
    const timeouts = resolveTimeouts(env);
    const upstreamCtx = {
      useCFAI: upstream.useCFAI,
      baseUrl: upstream.baseUrl,
      apiKey: upstream.apiKey,
      model: targetModel,
      maxTokens: upstream.maxTokens,
      extraParams: upstream.extraParams,
      messages,
      env,
    };

    const encoder = new TextEncoder();
    let liveAbort = null;

    const stream = new ReadableStream({
      async start(controller) {
        const decoder = new TextDecoder();
        const deadline = Date.now() + timeouts.totalMs;
        let clientGone = false;
        let currentAttemptAbort = null;
        let activeReader = null;
        let fullText = "";
        let sentLive = "";
        let lastLiveAt = 0;
        let strictLanguage = false;

        const send = (event, data) => {
          if (clientGone) return false;
          try {
            controller.enqueue(
              encoder.encode("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n")
            );
            return true;
          } catch {
            clientGone = true;
            return false;
          }
        };

        const onClientGone = () => {
          clientGone = true;
          try {
            currentAttemptAbort?.abort(new Error("client disconnected"));
          } catch {}
        };
        if (request.signal) {
          if (request.signal.aborted) onClientGone();
          else request.signal.addEventListener("abort", onClientGone);
        }

        const heartbeat = setInterval(() => {
          send("ping", { t: Date.now() });
        }, timeouts.heartbeatMs);

        let closed = false;
        const finish = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          try {
            controller.close();
          } catch {}
        };

        try {
          // 先发 start，立即让浏览器拿到响应头，避免首字节等待导致网关超时
          send("start", { ok: true, mode: isSingleWord ? "word" : "translate" });

          // 实时推送节流：长文时逐 token 做全量字符串处理很费 CPU（免费版只有 10ms CPU）
          const pushLive = (force = false) => {
            if (clientGone) return;
            const now = Date.now();
            if (!force && now - lastLiveAt < LIVE_PUSH_INTERVAL_MS) return;
            lastLiveAt = now;
            if (isSingleWord) {
              const live = normalizeWordMarkdownOutput(
                cleanupModelOutput(fullText, {
                  allowPartialFence: true,
                  allowPartialReasoning: true,
                }),
                wordTemplate
              );
              if (live.trim() && live !== sentLive) {
                sentLive = live;
                send("delta", { content: live, replace: true });
              }
              return;
            }
            const safe = stripReasoningArtifacts(fullText, true);
            if (!safe || safe === sentLive) return;
            if (safe.startsWith(sentLive)) {
              send("delta", { content: safe.slice(sentLive.length) });
            } else {
              send("delta", { content: safe, replace: true });
            }
            sentLive = safe;
          };

          let attempt = 0;
          let succeeded = false;
          let lastError = null;

          while (attempt < timeouts.maxAttempts && !succeeded && !clientGone) {
            if (Date.now() >= deadline) {
              lastError = lastError || new Error("Upstream request exceeded the total time limit.");
              break;
            }
            attempt++;
            if (attempt > 1) {
              fullText = "";
              sentLive = "";
              lastLiveAt = 0;
              send("reset", { attempt });
              await sleepMs(Math.min(600 * attempt, 2000));
              if (clientGone) break;
            }

            const attemptBudget = Math.max(3000, Math.min(timeouts.totalMs, deadline - Date.now()));
            const ac = new AbortController();
            currentAttemptAbort = ac;
            liveAbort = ac;
            let idleTimer = null;
            const armIdle = () => {
              clearTimeout(idleTimer);
              idleTimer = setTimeout(() => {
                try {
                  ac.abort(new Error("No data from upstream for " + timeouts.idleMs + "ms"));
                } catch {}
              }, timeouts.idleMs);
            };
            const attemptTimer = setTimeout(() => {
              try {
                ac.abort(new Error("Upstream attempt timed out"));
              } catch {}
            }, attemptBudget);

            try {
              const attemptMessages = strictLanguage
                ? buildStrictLanguageMessages(messages, to)
                : messages;
              const upstreamBody = await openUpstreamStream(
                { ...upstreamCtx, messages: attemptMessages },
                ac.signal
              );
              const reader = upstreamBody.getReader();
              activeReader = reader;
              armIdle();
              let buffer = "";
              let rawBody = "";
              let hasChunks = false;

              while (true) {
                // 即使上游忽略 abort 信号，这里也能被超时中断，避免请求永久挂起
                const { value, done } = await raceWithSignal(reader.read(), ac.signal);
                if (done) break;
                if (!value || !value.length) continue;
                hasChunks = true;
                // 任何字节（包括思维链 token）都代表上游仍然存活，重置空闲计时
                armIdle();
                const decoded = decoder.decode(value, { stream: true });
                rawBody += decoded;
                buffer += decoded;
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                let appended = "";
                for (const line of lines) {
                  const delta = extractStreamDelta(line);
                  if (delta) appended += delta;
                }
                if (appended) fullText += appended;
                pushLive();
              }

              if (buffer.trim()) {
                const rest = extractStreamDelta(buffer);
                if (rest) fullText += rest;
              }
              if (!fullText.trim() && rawBody.trim()) {
                fullText = extractWholeBodyText(rawBody);
              }
              if (!hasChunks && !fullText.trim()) {
                throw new Error("Upstream returned an empty body.");
              }
              if (!fullText.trim()) {
                throw new Error("Upstream returned no usable text tokens.");
              }
              // 语言自检：译文语言不对时用更严格的提示词重来；最后一次仍不对则直接报错，
              // 宁可提示失败，也不把"语言不对的结果"当成译文交给用户
              if (!isSingleWord && isOutputLanguageMismatch(stripReasoningArtifacts(fullText, true), to)) {
                if (attempt < timeouts.maxAttempts) {
                  strictLanguage = true;
                  throw new Error("Output language mismatch, retrying with a stricter prompt.");
                }
                throw new Error("Model kept answering in the wrong language.");
              }
              pushLive(true);
              succeeded = true;
            } catch (err) {
              lastError = err;
              console.error(
                JSON.stringify({
                  timestamp: new Date().toISOString(),
                  level: "ERROR",
                  event: "API_FETCH_FAILED",
                  message: err && err.message ? err.message : String(err),
                  retry: `${attempt}/${timeouts.maxAttempts}`,
                  model: targetModel,
                  sourceTextSnippet: text.slice(0, 100),
                })
              );
            } finally {
              clearTimeout(idleTimer);
              clearTimeout(attemptTimer);
              if (activeReader) {
                const stale = activeReader;
                activeReader = null;
                try {
                  stale.cancel().catch(() => {});
                } catch {}
              }
              currentAttemptAbort = null;
              liveAbort = null;
            }
          }

          if (!succeeded) {
            if (!clientGone) {
              send("error", {
                error: describeUpstreamFailure(lastError),
                retryable: isRetryableUpstreamError(lastError),
              });
            }
            return;
          }

          const cleaned = cleanupModelOutput(fullText, {
            stripMetaNotes: !isSingleWord,
            allowPartialReasoning: false,
          });

          let finalOut = isSingleWord ? normalizeWordMarkdownOutput(cleaned, wordTemplate) : cleaned;

          if (!finalOut.trim()) {
            finalOut = isSingleWord ? `# 暂无释义\n\n- 抱歉，未能为该输入生成有效的词汇解析。` : text;
          }

          // 先把结果发给前端，再做可选的例句修复；这样二次调用再慢也不会让请求卡住
          send("final", { content: finalOut });

          if (isSingleWord && !clientGone) {
            try {
              const repaired = await repairWordExamplesIfNeeded(finalOut, {
                from,
                to,
                wordTemplate,
                env,
                model: targetModel,
                maxTokens: upstreamCtx.maxTokens,
                extraParams: upstreamCtx.extraParams,
                useCFAI: upstreamCtx.useCFAI,
                baseUrl: upstreamCtx.baseUrl,
                apiKey: upstreamCtx.apiKey,
                timeoutMs: timeouts.repairMs,
              });
              if (repaired && repaired !== finalOut) {
                finalOut = repaired;
                send("final", { content: finalOut });
              }
            } catch {}
          }

          send("done", { done: true });
        } catch (streamErr) {
          console.error(
            JSON.stringify({
              timestamp: new Date().toISOString(),
              level: "ERROR",
              event: "TRANSLATE_STREAM_ABORTED",
              message: streamErr && streamErr.message ? streamErr.message : String(streamErr),
            })
          );
          send("error", { error: "Processing interrupted. Please retry.", retryable: true });
        } finally {
          // 无论成功、失败还是客户端断开，都必须关闭流，否则请求会一直挂着
          finish();
        }
      },
      cancel() {
        try {
          liveAbort?.abort(new Error("client disconnected"));
        } catch {}
      },
    });

    return new Response(stream, {
      status: 200,
      headers: SSE_HEADERS,
    });
  } catch (globalErr) {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "CRITICAL",
        event: "TRANSLATE_STREAM_CRASH",
        message: globalErr.message,
      })
    );
    return json({ error: "Processing failed. Please retry." }, 500);
  }
}

// ============================================================================
// 4. 上游配置、超时与请求执行
// ============================================================================
function envNumber(env, key, fallback) {
  const raw = env ? env[key] : undefined;
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isCFAI(env) {
  const raw = String((env && env.CF_AI) ?? "false").trim().toLowerCase();
  return ["true", "1", "on", "yes"].includes(raw);
}

function resolveUpstreamConfig(env) {
  const useCFAI = isCFAI(env);
  const baseUrl = String(env.CUSTOM_API_BASE_URL || env.BASE_URL || "").trim();
  const apiKey = String(env.CUSTOM_API_KEY || env.API_KEY || "").trim();
  const model = String(
    useCFAI
      ? env.CF_MODEL || DEFAULT_CF_MODEL
      : env.CUSTOM_API_MODEL || env.API_MODEL || ""
  ).trim();
  return {
    useCFAI,
    baseUrl,
    apiKey,
    model,
    // 部分 Workers AI 模型默认 max_tokens 很小（如 llama-3.2-3b 仅 256），不显式指定会被截断
    maxTokens: envNumber(env, "CF_MAX_TOKENS", DEFAULT_CF_MAX_TOKENS),
    extraParams: parseJsonObject(env.CF_EXTRA_PARAMS) || DEFAULT_CF_EXTRA_PARAMS,
  };
}

function parseJsonObject(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Workers AI 入参：显式带上 max_tokens，避免模型默认值过小导致译文被截断
function buildCFInputs(ctx, stream, withExtraParams = true) {
  const inputs = { messages: ctx.messages, stream: !!stream };
  const maxTokens = Number(ctx.maxTokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) inputs.max_tokens = Math.round(maxTokens);
  if (withExtraParams && ctx.extraParams) Object.assign(inputs, ctx.extraParams);
  return inputs;
}

function resolveTimeouts(env) {
  return {
    idleMs: envNumber(env, "UPSTREAM_IDLE_TIMEOUT_MS", 40000),
    totalMs: envNumber(env, "UPSTREAM_TOTAL_TIMEOUT_MS", 300000),
    maxAttempts: Math.max(1, Math.min(5, Math.round(envNumber(env, "UPSTREAM_MAX_ATTEMPTS", 3)))),
    heartbeatMs: Math.max(1000, envNumber(env, "SSE_HEARTBEAT_MS", 15000)),
    repairMs: envNumber(env, "REPAIR_TIMEOUT_MS", 25000),
  };
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortError(signal) {
  const reason = signal && signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(reason ? String(reason) : "Upstream request aborted");
  err.name = "AbortError";
  return err;
}

function raceWithSignal(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}

function textOf(value) {
  return typeof value === "string" ? value : "";
}

// 同时兼容 OpenAI 兼容接口 (choices[].delta.content) 与 Cloudflare Workers AI (response)
function extractStreamDelta(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith(":")) return "";
  let payload = trimmed;
  if (payload.startsWith("data:")) payload = payload.slice(5).trim();
  else if (payload.startsWith("event:") || payload.startsWith("id:")) return "";
  if (!payload || payload === "[DONE]") return "";
  let chunk;
  try {
    chunk = JSON.parse(payload);
  } catch {
    return "";
  }
  if (typeof chunk === "string") return chunk;
  const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : null;
  return (
    textOf(choice?.delta?.content) ||
    textOf(choice?.message?.content) ||
    textOf(choice?.text) ||
    textOf(chunk?.response) ||
    textOf(chunk?.result?.response) ||
    ""
  );
}

// 兜底：部分平台忽略 stream:true，直接返回一整段 JSON
function extractWholeBodyText(body) {
  const raw = String(body || "").trim();
  if (!raw) return "";
  if (/^data:/m.test(raw)) {
    const parts = [];
    for (const line of raw.split("\n")) {
      const piece = extractStreamDelta(line);
      if (piece) parts.push(piece);
    }
    return parts.join("");
  }
  try {
    return extractResultText(JSON.parse(raw));
  } catch {
    return "";
  }
}

function extractResultText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  const choice = Array.isArray(result.choices) ? result.choices[0] : null;
  return (
    textOf(result.response) ||
    textOf(choice?.message?.content) ||
    textOf(choice?.delta?.content) ||
    textOf(choice?.text) ||
    textOf(result.result?.response) ||
    ""
  );
}

function textToStream(text) {
  const payload = new TextEncoder().encode(
    "data: " + JSON.stringify({ response: String(text || "") }) + "\n\ndata: [DONE]\n\n"
  );
  return new ReadableStream({
    start(controller) {
      controller.enqueue(payload);
      controller.close();
    },
  });
}

async function openUpstreamStream(ctx, signal) {
  if (ctx.useCFAI) {
    // 依次尝试：带扩展参数流式 -> 去掉扩展参数流式 -> 去掉扩展参数一次性返回
    // 换模型时若某个模型不认 CF_EXTRA_PARAMS，也不会因此报错
    const attempts = [
      () => ctx.env.AI.run(ctx.model, buildCFInputs(ctx, true, true)),
      () => ctx.env.AI.run(ctx.model, buildCFInputs(ctx, true, false)),
      () => ctx.env.AI.run(ctx.model, buildCFInputs(ctx, false, false)),
    ];
    let result = null;
    let lastErr = null;
    for (let i = 0; i < attempts.length; i++) {
      try {
        result = await raceWithSignal(attempts[i](), signal);
        break;
      } catch (err) {
        if (signal && signal.aborted) throw abortError(signal);
        lastErr = err;
      }
    }
    if (!result) throw lastErr || new Error("Workers AI request failed.");
    if (result && typeof result.getReader === "function") return result;
    if (result && result.body && typeof result.body.getReader === "function") return result.body;
    if (result && typeof result[Symbol.asyncIterator] === "function") {
      return asyncIterableToStream(result);
    }
    const text = extractResultText(result);
    if (!text.trim()) throw new Error("Workers AI returned an empty response.");
    return textToStream(text);
  }

  const res = await fetch(stripSlash(ctx.baseUrl) + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + ctx.apiKey,
    },
    body: JSON.stringify({
      model: ctx.model,
      temperature: 0.1,
      stream: true,
      messages: ctx.messages,
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {}
    const err = new Error(detail || "HTTP Error " + (res && res.status));
    err.status = res && res.status;
    throw err;
  }
  return res.body;
}

function asyncIterableToStream(iterable) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for await (const item of iterable) {
        if (typeof item === "string") {
          controller.enqueue(encoder.encode(item));
        } else if (item instanceof Uint8Array) {
          controller.enqueue(item);
        } else {
          controller.enqueue(
            encoder.encode("data: " + JSON.stringify(item) + "\n\n")
          );
        }
      }
      controller.close();
    },
  });
}

function isRetryableUpstreamError(err) {
  if (!err) return true;
  if (err.name === "AbortError") return false;
  const message = String(err.message || "");
  // 已经重试过仍超时的，交给用户决定，避免前端再叠加重试把等待时间翻倍
  if (/no data from upstream|timed? ?out|exceeded the total time limit|client disconnected/i.test(message)) {
    return false;
  }
  // 多次重试后语言仍然不对，再重试也是同样结果
  if (/wrong language|language mismatch/i.test(message)) return false;
  const status = Number(err.status);
  if (Number.isFinite(status) && status >= 400 && status < 500 && status !== 429) return false;
  if (/no usable text tokens|empty body|empty response/i.test(message)) return false;
  return true;
}

function describeUpstreamFailure(err) {
  const message = String((err && err.message) || "").trim();
  if (err && err.name === "AbortError") {
    return "上游模型长时间没有返回数据（超时），已自动重试。请稍后再试，或更换响应更快的模型。";
  }
  if (/wrong language|language mismatch/i.test(message)) {
    return "模型没有按目标语言输出（重试后仍不正确）。请重新点击翻译，或换一个模型。";
  }
  if (/no data from upstream|timed? ?out|exceeded the total time limit/i.test(message)) {
    return "上游模型响应超时。请稍后再试，或更换响应更快的模型。";
  }
  if (/no usable text tokens|empty body|empty response/i.test(message)) {
    return "上游返回了空内容，可能是模型拒绝回答，请换个说法或更换模型后重试。";
  }
  if (!message) return "Upstream service error or empty response after retries.";
  return "上游服务错误：" + message.slice(0, 200);
}

// ============================================================================
// 5. 模型输出清理（思维链、代码围栏、前缀、元注释）
// ============================================================================
function cleanupTail(text) {
  let t = String(text || "").trim();
  const tailPatterns = [
    /\n*[-*]?\s*if you want[^\n]*$/gi,
    /\n*[-*]?\s*if needed[^\n]*$/gi,
    /\n*[-*]?\s*i can also[^\n]*$/gi,
    /\n*[-*]?\s*let me know[^\n]*$/gi,
    /\n*[-*]?\s*(?:如需|如果需?要|希望)[^\n]*(?:帮助|有用|告知)[^\n]*$/g,
  ];
  for (const p of tailPatterns) t = t.replace(p, "");
  return t.trim();
}

function cleanupModelOutput(text, options = {}) {
  let t = String(text || "").replace(/\r\n?/g, "\n").trim();
  // ★ 如果原始内容就很短，不要过度清洗
  if (t.length < 50) {
    t = unwrapMarkdownFence(t, !!options.allowPartialFence);
    if (options.stripMetaNotes) t = stripTranslationMetaLines(t);
    return t.trim();
  }
  t = unwrapMarkdownFence(t, !!options.allowPartialFence);
  t = stripReasoningArtifacts(t, !!options.allowPartialReasoning);
  t = cleanupTail(t);
  if (options.stripMetaNotes) t = stripTranslationMetaLines(t);
  return t.trim();
}

function stripReasoningArtifacts(text, allowPartial = false) {
  let t = String(text || "").replace(/\r\n?/g, "\n");
  t = t.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "");
  t = t.replace(/<analysis\b[^>]*>[\s\S]*?<\/analysis>/gi, "");
  if (allowPartial) {
    t = t.replace(/<think\b[^>]*>[\s\S]*$/i, "");
    t = t.replace(/<analysis\b[^>]*>[\s\S]*$/i, "");
  }
  t = t
    .split("\n")
    .filter((line) => !/^\s*\[(?:WebSearch|Search|Tool|Browse|Lookup|Reasoning)\][^\n]*$/i.test(line))
    .join("\n");
  t = t.replace(/^\s*<\/?(?:think|analysis)\b[^>]*>\s*$/gim, "");
  return t.trim();
}

// 去掉模型爱加的"译文："前缀和末尾的说明性注释，只保留纯译文
function stripTranslationMetaLines(text) {
  let t = String(text || "");
  // 前导前缀：译文： / 翻译结果： / Here is the translation: ...
  t = t.replace(
    /^\s*(?:译文|翻译结果|翻译如下|以下是(?:译文|翻译(?:结果)?)|下面是(?:译文|翻译(?:结果)?))\s*[:：]?\s*/i,
    ""
  );
  t = t.replace(
    /^\s*(?:here(?:'| i)?s? (?:is )?the translation|translation|translated (?:text|version)|output)\s*[:：]\s*/i,
    ""
  );
  // 末尾元注释：语境识别：xxx / Note: xxx
  t = t.replace(
    /\n?[-*]?\s*\*?\(?(?:语境识别|context\s*recognition|context|note)[:?][^\n]*\)?\*?\s*$/i,
    ""
  );
  return t.trim();
}

function normalizeWordMarkdownOutput(text, template = null) {
  let t = String(text || "").replace(/\r\n?/g, "\n");
  t = t.replace(/([^\n])(?=#{1,6}\s*)/g, "$1\n");
  t = t.replace(/(^|\n)(#{1,6})(?=\S)/g, "$1$2 ");
  t = t.replace(/^(#{1,6}\s*[^#\n]+?)\s*(?:-|:|\uFF1A)\s*(.+)$/gm, "$1\n- $2");
  t = t.replace(/([^\n\s])(?=[-*]\s+)/g, "$1\n");
  t = t.replace(/([^\n\s])(?=\d+\.\s+)/g, "$1\n");
  t = t.replace(/(^|\n)([-*])(?=\S)/g, "$1$2 ");
  const sections = getWordSectionNames(template);
  const normalizedToSection = new Map();
  for (const section of sections) {
    normalizedToSection.set(normalizeWordSectionKey(section), section);
  }
  const lines = t.split("\n");
  const out = [];
  for (const rawLine of lines) {
    const raw = String(rawLine || "");
    const line = raw.trim();
    if (line === "#") continue;
    if (line) {
      const headingMatch = line.match(/^#{1,6}\s*(.+)$/);
      if (headingMatch) {
        const key = normalizeWordSectionKey(headingMatch[1]);
        if (normalizedToSection.has(key)) {
          out.push("## " + normalizedToSection.get(key));
          continue;
        }
      } else {
        const key = normalizeWordSectionKey(line);
        if (normalizedToSection.has(key)) {
          out.push("## " + normalizedToSection.get(key));
          continue;
        }
      }
    }
    out.push(raw);
  }
  t = out.join("\n");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

function getExampleSectionKeys(template) {
  const keys = new Set();
  const add = (label) => {
    const key = normalizeWordSectionKey(label);
    if (key) keys.add(key);
  };
  add(String(template?.examples || ""));
  const aliases = [
    "Example Sentences",
    "Examples",
    "Example Sentence",
    "Sample Sentences",
    "\u4F8B\u53E5",
    "\u4F8B\u6587",
    "\u7528\u4F8B",
    "\u6587\u4F8B",
    "\u4F7F\u7528\u4F8B",
    "\uC608\uBB38",
    "\uC608\uC2DC \uBB38\uC7A5",
    "\uC608\uC2DC",
    "Exemples",
    "Beispiele",
    "Ejemplos",
    "\u041F\u0440\u0438\u043C\u0435\u0440\u044B",
  ];
  for (const alias of aliases) add(alias);
  return keys;
}

function extractWordExampleItems(text, template) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const exampleKeys = getExampleSectionKeys(template);
  let inExamples = false;
  let sawHeading = false;
  let currentSectionBullets = [];
  let lastSectionBullets = [];
  const items = [];
  const flushSection = () => {
    if (currentSectionBullets.length) {
      lastSectionBullets = currentSectionBullets.slice();
      currentSectionBullets = [];
    }
  };
  for (const raw of lines) {
    const line = String(raw || "").trim();
    const heading = line.match(/^#{1,6}\s*(.+)$/);
    if (heading) {
      sawHeading = true;
      flushSection();
      const key = normalizeWordSectionKey(heading[1]);
      inExamples = exampleKeys.has(key);
      continue;
    }
    const li = line.match(/^[-*]\s+(.+)$/);
    if (!li) continue;
    const item = li[1].trim();
    if (inExamples) items.push(item);
    if (sawHeading) currentSectionBullets.push(item);
  }
  flushSection();
  if (items.length) return items;
  if (sawHeading && lastSectionBullets.length) return lastSectionBullets;
  if (!sawHeading) {
    return lines
      .map((line) => {
        const li = String(line || "").trim().match(/^[-*]\s+(.+)$/);
        return li ? li[1].trim() : "";
      })
      .filter(Boolean);
  }
  return [];
}

function hasExampleTranslation(item, from, to) {
  const s = String(item || "").trim();
  if (!s) return false;
  if (/\uFF08[^\uFF09]+\uFF09/.test(s)) return true;
  if (/\([^)]+\)/.test(s)) return true;
  if (/\s(?:->|=>|\u2192|\u2014|\-|:)\s*\S+/.test(s)) return true;
  const src = String(from || "").toLowerCase();
  const dst = String(to || "").toLowerCase();
  if (src === "en" && dst === "ja" && /[A-Za-z]/.test(s) && /[\u3040-\u30FF\u4E00-\u9FFF]/.test(s)) return true;
  if (src === "en" && dst === "ko" && /[A-Za-z]/.test(s) && /[\uAC00-\uD7AF]/.test(s)) return true;
  if (src === "en" && dst === "zh" && /[A-Za-z]/.test(s) && /[\u4E00-\u9FFF]/.test(s)) return true;
  return false;
}

function needsWordExampleRepair(text, from, to, template) {
  const src = String(from || "auto").trim().toLowerCase();
  const dst = String(to || "zh").trim().toLowerCase();
  if (!src || src === "auto" || !dst || src === dst) return false;
  const items = extractWordExampleItems(text, template);
  if (!items.length) return false;
  return items.some((it) => !hasExampleTranslation(it, src, dst));
}

async function repairWordExamplesIfNeeded(text, ctx) {
  const draft = String(text || "").trim();
  if (!draft) return draft;
  if (!needsWordExampleRepair(draft, ctx?.from, ctx?.to, ctx?.wordTemplate)) return draft;
  const timeoutMs = Number(ctx?.timeoutMs) > 0 ? Number(ctx.timeoutMs) : 25000;
  const ac = new AbortController();
  const timer = setTimeout(() => {
    try {
      ac.abort(new Error("Repair pass timed out"));
    } catch {}
  }, timeoutMs);
  try {
    // 整段修复请求都参与超时竞争：即使上游不响应 abort，也不会拖住整个翻译请求
    const repaired = await raceWithSignal(runWordExampleRepair(draft, ctx, ac.signal), ac.signal);
    if (!repaired) return draft;
    const cleaned = cleanupModelOutput(repaired, {
      stripMetaNotes: false,
      allowPartialReasoning: false,
    });
    const normalized = normalizeWordMarkdownOutput(cleaned, ctx.wordTemplate);
    if (!normalized) return draft;
    return normalized;
  } catch {
    return draft;
  } finally {
    clearTimeout(timer);
  }
}

async function runWordExampleRepair(draft, ctx, signal) {
  const src = String(ctx?.from || "auto").trim().toLowerCase();
  const dst = String(ctx?.to || "zh").trim().toLowerCase();
  const sectionName = String(ctx?.wordTemplate?.examples || "Example Sentences").trim();
  const repairSystem =
    "You repair markdown for vocabulary explanation output.\n" +
    "Keep all headings and all non-example sections unchanged.\n" +
    "Only edit bullets in the example section when needed.\n" +
    "Do not add or remove sections or bullets.";
  const repairUser =
    "Source language code: " + src + "\n" +
    "Target language code: " + dst + "\n" +
    'Example section heading: "' + sectionName + '"\n' +
    "Rules:\n" +
    "1) If source and target are different, every example bullet must contain source sentence + target translation.\n" +
    "2) Keep bullet count unchanged.\n" +
    "3) Use this format: Source sentence. (translation in target language)\n" +
    "4) Return markdown only, no code fences.\n\n" +
    "Input markdown:\n" + draft;
  const messages = [
    { role: "system", content: repairSystem },
    { role: "user", content: repairUser },
  ];
  if (ctx.useCFAI) {
    if (!ctx.env.AI) return "";
    const result = await raceWithSignal(
      ctx.env.AI.run(ctx.model, buildCFInputs({ messages, maxTokens: ctx.maxTokens, extraParams: ctx.extraParams }, false)),
      signal
    );
    return extractResultText(result);
  }
  const baseUrl = String(ctx.baseUrl || ctx.env.CUSTOM_API_BASE_URL || ctx.env.BASE_URL || "").trim();
  const apiKey = String(ctx.apiKey || ctx.env.CUSTOM_API_KEY || ctx.env.API_KEY || "").trim();
  if (!baseUrl || !apiKey) return "";
  const res = await fetch(stripSlash(baseUrl) + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify({
      model: ctx.model,
      temperature: 0,
      stream: false,
      messages,
    }),
    signal,
  });
  if (!res.ok) return "";
  const data = await res.json();
  return textOf(data?.choices?.[0]?.message?.content) || extractResultText(data);
}

function getWordSectionNames(template) {
  const fromTemplate = [
    template?.meaning,
    template?.usage,
    template?.collocations,
    template?.examples,
  ]
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  return fromTemplate;
}

function normalizeWordSectionKey(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .replace(/[\s`"'(){}\[\].,:;!?/\-_\u3000\uFF1A]+/g, "");
}

function unwrapMarkdownFence(text, allowPartial = false) {
  const raw = String(text || "").trim();
  const m = raw.match(/^```(?:md|markdown|text)?\s*\n([\s\S]*?)\n```$/i);
  if (m) return m[1].trim();
  if (!allowPartial) return raw;
  return raw
    .replace(/^```(?:md|markdown|text)?\s*\n?/i, "")
    .replace(/\n?```$/i, "")
    .trim();
}

// ============================================================================
// 6. 语言检测、提示词与词汇模式
// ============================================================================
function detectSingleWordQuery(text, from) {
  const t = (text || "").trim();
  if (!t) return false;
  if (t.length > 40) return false;
  if (/\n/.test(t)) return false;
  if (!(from === "auto" || from === "en")) return false;
  if (!/^[A-Za-z][A-Za-z\s'-]*$/.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  return words.length <= 3;
}

function inferSourceLangByText(text) {
  const profile = detectTextLanguageProfile(text);
  if (!profile.total) return "auto";
  if (profile.isMixed) return "mixed";
  if (profile.ja > 0) return "ja";
  if (profile.ko > 0) return "ko";
  if (profile.zh > 0) return "zh";
  if (profile.ru > 0) return "ru";
  if (profile.en > 0) return "en";
  return "auto";
}

function detectTextLanguageProfile(text) {
  const t = String(text || "");
  const zh = (t.match(/[\u4E00-\u9FFF]/g) || []).length;
  const ja = (t.match(/[\u3040-\u30FF]/g) || []).length;
  const ko = (t.match(/[\uAC00-\uD7AF]/g) || []).length;
  const ru = (t.match(/[\u0400-\u04FF]/g) || []).length;
  const en = (t.match(/[A-Za-z]/g) || []).length;
  const total = zh + ja + ko + ru + en;
  const nonZeroLangCount = [zh, ja, ko, ru, en].filter((n) => n > 0).length;
  return {
    zh,
    ja,
    ko,
    ru,
    en,
    total,
    isMixed: nonZeroLangCount >= 2,
  };
}

function mapLangName(code) {
  const m = {
    auto: "Auto Detect",
    mixed: "Mixed Language",
    zh: "Chinese",
    en: "English",
    ja: "Japanese",
    ko: "Korean",
    fr: "French",
    de: "German",
    es: "Spanish",
    ru: "Russian",
  };
  return m[code] || code || "Target Language";
}

// ============================================================================
// 输出语言自检
// 只做"明显不对"的判定（例如目标中文却一个汉字都没有），避免误伤专有名词、
// 技术术语和代码片段。命中时用更严格的提示词重新生成一次。
// ============================================================================
function countMatches(text, re) {
  const found = String(text || "").match(re);
  return found ? found.length : 0;
}

function isOutputLanguageMismatch(text, to) {
  const t = String(text || "").trim();
  if (!t) return false;
  const dst = String(to || "").trim().toLowerCase();
  const cjk = countMatches(t, /[\u4E00-\u9FFF]/g);
  const kana = countMatches(t, /[\u3040-\u30FF]/g);
  const hangul = countMatches(t, /[\uAC00-\uD7AF]/g);
  const cyrillic = countMatches(t, /[\u0400-\u04FF]/g);
  const latin = countMatches(t, /[A-Za-z]/g);
  // 内容太短时不做判断，避免把专有名词、术语、代码当成"语言不对"
  if (cjk + kana + hangul + cyrillic + latin < 12) return false;
  switch (dst) {
    case "zh":
      return cjk === 0 && latin >= 12;
    case "ja":
      return kana === 0 && cjk === 0;
    case "ko":
      return hangul === 0;
    case "ru":
      return cyrillic === 0 && latin >= 12;
    case "en":
      return cjk + kana + hangul > 10 || (cjk + kana + hangul > 0 && latin < 20);
    default:
      // fr / de / es 与英文同为拉丁字母，无法可靠区分，不做判定
      return false;
  }
}

// 语言不对时的补救：在系统提示后追加一条强制要求，再生成一次
function buildStrictLanguageMessages(messages, to) {
  const target = mapLangName(to);
  const reminder = {
    role: "system",
    content:
      "STRICT LANGUAGE REQUIREMENT (the previous attempt was rejected):\n" +
      "- Your entire answer MUST be written in " + target + " only.\n" +
      "- Do not leave any sentence in the source language.\n" +
      "- Translate every sentence, including headings, list items and table cells.\n" +
      "- Output the translation only, with no explanation and no notes.",
  };
  const out = Array.isArray(messages) ? messages.slice() : [];
  const firstSystem = out.findIndex((m) => m && m.role === "system");
  if (firstSystem === -1) out.unshift(reminder);
  else out.splice(firstSystem + 1, 0, reminder);
  return out;
}

function buildLanguageGuard(from, to, mode) {
  const src = String(from || "auto").trim().toLowerCase();
  const dst = String(to || "zh").trim().toLowerCase();
  const task = mode === "word" ? "word explanation" : "translation";
  const sameLang = src !== "auto" && src === dst;
  const lines = [
    "Language constraint (ABSOLUTELY MUST follow):",
    "- Task: " + task,
    "- Source language code: " + src,
    "- Target language code: " + dst,
    "- Do not output explanations, annotations, or meta notes.",
  ];
  if (mode === "word") {
    if (sameLang) {
      lines.push("- Output should stay in the same language (" + dst + ").");
      lines.push("- Do not add extra bilingual content.");
    } else {
      lines.push("- Output language should be target language (" + dst + ").");
      lines.push(
        "- Bilingual text is allowed only in the example section when providing source sentence + target translation."
      );
    }
  } else {
    lines.push("- The ENTIRE output MUST be written in " + mapLangName(dst) + " (" + dst + ") ONLY.");
    lines.push("- Translate ALL parts of the input into " + mapLangName(dst) + ", regardless of what language they are in.");
    lines.push("- If input contains Chinese and English mixed together, translate EVERYTHING into " + mapLangName(dst) + ".");
    lines.push("- NEVER output any Chinese characters unless the target language IS Chinese.");
    lines.push("- NEVER output any English words unless the target language IS English or they are proper nouns/technical terms.");
    lines.push("- IMPORTANT: Even if you see Chinese in the input, your output must be 100% in " + mapLangName(dst) + ".");
    lines.push("- Do not output bilingual text unless explicitly requested.");
  }
  return lines.join("\n");
}

function buildWordExampleRule(from, to, wordTemplate) {
  const src = String(from || "auto").trim().toLowerCase();
  const dst = String(to || "zh").trim().toLowerCase();
  const sameLang = src !== "auto" && src === dst;
  const targetName = mapLangName(to);
  const sourceName = mapLangName(from);
  const sectionName = String(wordTemplate?.examples || "Example Sentences").trim();
  if (sameLang) {
    return [
      "Word mode example rule (MUST follow):",
      '- In section "' + sectionName + '", every bullet should be a source-language example sentence only (' + sourceName + ").",
      "- Do not append extra translated text for examples when source and target are the same language.",
    ].join("\n");
  }
  if (src === "en") {
    return [
      "Word mode example rule (MUST follow):",
      '- In section "' + sectionName + '", every bullet must be: English sentence + ' + targetName + " translation.",
      "- Required format for each bullet: English sentence. (translation in target language)",
      "- Never output an example sentence without translation.",
    ].join("\n");
  }
  return [
    "Word mode example rule (MUST follow):",
    '- In section "' + sectionName + '", every bullet must include source-language sentence + target-language translation.',
    "- Required format for each bullet: Source-language sentence. (translation in target language)",
    "- Never output an example sentence without translation when source and target are different languages.",
  ].join("\n");
}

function getWordExplainTemplate(code) {
  const templates = {
    en: {
      title: "[Most common equivalent in English]",
      meaning: "Core Meaning",
      usage: "Part of Speech & Notes",
      collocations: "Common Collocations",
      examples: "Example Sentences",
    },
    ja: {
      title: "[\u65E5\u672C\u8A9E\u3067\u6700\u3082\u4E00\u822C\u7684\u306A\u5BFE\u5FDC\u8A9E]",
      meaning: "\u4E2D\u6838\u7684\u306A\u610F\u5473",
      usage: "\u54C1\u8A5E\u3068\u8AAC\u660E",
      collocations: "\u3088\u304F\u3042\u308B\u7D44\u307F\u5408\u308F\u305B",
      examples: "\u4F8B\u6587",
    },
    ko: {
      title: "[\uD55C\uAD6D\uC5B4\uC5D0\uC11C \uAC00\uC7A5 \uC77C\uBC18\uC801\uC778 \uB300\uC751\uC5B4]",
      meaning: "\uD575\uC2EC \uC758\uBBF8",
      usage: "\uD488\uC0AC\uC640 \uC124\uBA85",
      collocations: "\uC790\uC8FC \uC4F0\uB294 \uACB0\uD569",
      examples: "\uC608\uBB38",
    },
    fr: {
      title: "[\u00C9quivalent le plus courant en fran\u00E7ais]",
      meaning: "Sens essentiel",
      usage: "Nature grammaticale et remarques",
      collocations: "Collocations courantes",
      examples: "Exemples",
    },
    de: {
      title: "[Gebr\u00E4uchlichste Entsprechung im Deutschen]",
      meaning: "Kernbedeutung",
      usage: "Wortart und Hinweise",
      collocations: "H\u00E4ufige Verbindungen",
      examples: "Beispiele",
    },
    es: {
      title: "[Equivalente m\u00E1s com\u00FAn en espa\u00F1ol]",
      meaning: "Significado principal",
      usage: "Categor\u00EDa gramatical y notas",
      collocations: "Colocaciones comunes",
      examples: "Ejemplos",
    },
    ru: {
      title: "[\u041D\u0430\u0438\u0431\u043E\u043B\u0435\u0435 \u0443\u043F\u043E\u0442\u0440\u0435\u0431\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u0439 \u044D\u043A\u0432\u0438\u0432\u0430\u043B\u0435\u043D\u0442 \u043D\u0430 \u0440\u0443\u0441\u0441\u043A\u043E\u043C \u044F\u0437\u044B\u043A\u0435]",
      meaning: "\u041E\u0441\u043D\u043E\u0432\u043D\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435",
      usage: "\u0427\u0430\u0441\u0442\u044C \u0440\u0435\u0447\u0438 \u0438 \u043F\u043E\u044F\u0441\u043D\u0435\u043D\u0438\u0435",
      collocations: "\u0427\u0430\u0441\u0442\u044B\u0435 \u0441\u043E\u0447\u0435\u0442\u0430\u043D\u0438\u044F",
      examples: "\u041F\u0440\u0438\u043C\u0435\u0440\u044B",
    },
    zh: {
      title: "[\u8BE5\u8BCD\u5728\u4E2D\u6587\u4E2D\u7684\u6700\u5E38\u7528\u5BF9\u5E94\u8BCD]",
      meaning: "\u6838\u5FC3\u542B\u4E49",
      usage: "\u8BCD\u6027\u4E0E\u8BF4\u660E",
      collocations: "\u5E38\u89C1\u642D\u914D",
      examples: "\u4F8B\u53E5",
    },
    auto: {
      title: "[Most common equivalent in target language]",
      meaning: "Core Meaning",
      usage: "Part of Speech & Notes",
      collocations: "Common Collocations",
      examples: "Example Sentences",
    },
  };
  return templates[code] || templates.zh;
}

// ============================================================================
// 7. 工具函数
// ============================================================================
async function verifyTurnstile({ secret, token, ip }) {
  const formData = new FormData();
  formData.append("secret", secret);
  formData.append("response", token);
  if (ip) formData.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: formData,
  });
  return await res.json();
}

async function buildSessionCookie(ip, secret) {
  const expireAt = Date.now() + 1000 * 60 * 60 * 24 * 3;
  const sig = await signText(ip + "|" + expireAt + "|" + secret);
  const value = encodeURIComponent(String(expireAt) + "." + sig);
  return "translator_session=" + value + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=259200";
}

async function verifySessionCookie(request, env) {
  const ip = getClientIP(request);
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies = parseCookies(cookieHeader);
  const raw = cookies.translator_session;
  if (!raw) return false;
  const decoded = decodeURIComponent(raw);
  const parts = decoded.split(".");
  if (parts.length !== 2) return false;
  const expireAt = Number(parts[0]);
  const sig = parts[1];
  if (!Number.isFinite(expireAt) || Date.now() > expireAt) return false;
  const expected = await signText(ip + "|" + expireAt + "|" + env.SESSION_SECRET);
  return sig === expected;
}

function parseCookies(cookieHeader) {
  const out = {};
  cookieHeader.split(";").forEach((p) => {
    const item = p.trim();
    if (!item) return;
    const idx = item.indexOf("=");
    if (idx === -1) return;
    out[item.slice(0, idx)] = item.slice(idx + 1);
  });
  return out;
}

async function signText(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getClientIP(request) {
  return request.headers.get("CF-Connecting-IP") || "";
}

function stripSlash(url) {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function createImmediateTranslateStream(content) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode('event: start\ndata: {"ok":true,"mode":"translate"}\n\n')
      );
      controller.enqueue(
        encoder.encode("event: final\ndata: " + JSON.stringify({ content: String(content || "") }) + "\n\n")
      );
      controller.enqueue(encoder.encode('event: done\ndata: {"done":true}\n\n'));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: SSE_HEADERS,
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS,
  });
}

function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

function htmlResponse(html) {
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// ============================================================================
// 8. 前端页面（单文件内联，无需额外静态资源）
// ============================================================================
function getHtml(siteKey, turnstileEnabled) {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <meta name="color-scheme" content="light dark" />
  <meta name="theme-color" content="#4f46e5" />
  <title>AI 智能翻译</title>
  ${turnstileEnabled ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ""}
  <style>
    /* ---------- 设计变量 ---------- */
    :root{
      --bg:#f6f7fb;
      --card:#ffffff;
      --card-soft:#fafbfe;
      --text:#0f172a;
      --muted:#64748b;
      --faint:#94a3b8;
      --line:#e6e9f0;
      --line-strong:#d3d9e6;
      --brand:#4f46e5;
      --brand-2:#7c3aed;
      --brand-soft:rgba(79,70,229,.10);
      --ok:#0ea371;
      --ok-soft:rgba(14,163,113,.12);
      --warn:#d97706;
      --warn-soft:rgba(217,119,6,.12);
      --danger:#e11d48;
      --danger-soft:rgba(225,29,72,.10);
      --shadow-sm:0 1px 2px rgba(15,23,42,.06);
      --shadow:0 10px 30px -12px rgba(15,23,42,.18), 0 2px 8px -4px rgba(15,23,42,.08);
      --shadow-lg:0 30px 70px -30px rgba(15,23,42,.35);
      --r-lg:20px;
      --r-md:14px;
      --r-sm:10px;
    }
    html[data-theme="dark"]{
      --bg:#080d18;
      --card:#0f1729;
      --card-soft:#0c1424;
      --text:#e8ecf5;
      --muted:#93a1b8;
      --faint:#6b7a94;
      --line:#1e2a42;
      --line-strong:#2b3a58;
      --brand:#6366f1;
      --brand-2:#a855f7;
      --brand-soft:rgba(99,102,241,.16);
      --ok:#34d399;
      --ok-soft:rgba(52,211,153,.14);
      --warn:#fbbf24;
      --warn-soft:rgba(251,191,36,.14);
      --danger:#fb7185;
      --danger-soft:rgba(251,113,133,.14);
      --shadow-sm:0 1px 2px rgba(0,0,0,.4);
      --shadow:0 12px 34px -14px rgba(0,0,0,.65);
      --shadow-lg:0 30px 70px -30px rgba(0,0,0,.85);
    }

    /* ---------- 基础 ---------- */
    *,*::before,*::after{box-sizing:border-box}
    *{margin:0;padding:0}
    body{
      min-height:100vh;
      font-family:"Inter","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,-apple-system,sans-serif;
      background:var(--bg);
      color:var(--text);
      line-height:1.65;
      -webkit-font-smoothing:antialiased;
      text-rendering:optimizeLegibility;
    }
    body::before{
      content:"";position:fixed;left:0;right:0;top:0;height:460px;z-index:-1;pointer-events:none;
      background:radial-gradient(58% 100% at 50% 0,var(--brand-soft),transparent 72%);
    }
    button,input,select,textarea{font:inherit;color:inherit}
    ::selection{background:var(--brand-soft)}
    .hidden{display:none !important}
    .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

    /* 滚动条 */
    *::-webkit-scrollbar{width:10px;height:10px}
    *::-webkit-scrollbar-thumb{background:var(--line-strong);border-radius:99px;border:3px solid transparent;background-clip:content-box}
    *::-webkit-scrollbar-thumb:hover{background:var(--faint);background-clip:content-box}
    *::-webkit-scrollbar-track{background:transparent}

    /* ---------- 按钮 ---------- */
    .btn{
      display:inline-flex;align-items:center;justify-content:center;gap:6px;
      height:38px;padding:0 14px;border:1px solid var(--line);border-radius:var(--r-sm);
      background:var(--card);color:var(--text);font-size:13.5px;font-weight:500;
      cursor:pointer;white-space:nowrap;transition:transform .15s,border-color .15s,background .15s,box-shadow .15s;
    }
    .btn:hover{border-color:var(--line-strong);background:var(--card-soft);transform:translateY(-1px)}
    .btn:active{transform:translateY(0)}
    .btn:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
    .btn[disabled]{opacity:.55;cursor:not-allowed;transform:none}
    .btn-sm{height:30px;padding:0 10px;font-size:12.5px;border-radius:9px}
    .btn-icon{width:38px;padding:0;font-size:15px}
    .btn-icon.btn-sm{width:30px;font-size:13px}
    .btn-primary{
      border-color:transparent;color:#fff;
      background:linear-gradient(135deg,var(--brand),var(--brand-2));
      box-shadow:0 8px 20px -10px var(--brand);
    }
    .btn-primary:hover{filter:brightness(1.06);background:linear-gradient(135deg,var(--brand),var(--brand-2))}

    /* ---------- 验证闸门 ---------- */
    .gate{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
    .gate-card{
      width:100%;max-width:440px;padding:30px 28px 26px;text-align:center;
      background:var(--card);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow-lg);
      animation:rise .45s cubic-bezier(.22,1,.36,1) both;
    }
    @keyframes rise{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}
    .gate-card .brand{justify-content:center;margin-bottom:6px}
    .gate-hint{color:var(--muted);font-size:13.5px;margin:14px 0 18px}
    .gate-tip{color:var(--faint);font-size:12.5px;margin-top:16px;min-height:18px}
    .ts-wrap{display:flex;justify-content:center;align-items:center;overflow-x:auto;-webkit-overflow-scrolling:touch}
    .ts-wrap .cf-turnstile{margin:0 auto !important}

    /* ---------- 品牌 ---------- */
    .brand{display:flex;align-items:center;gap:11px;min-width:0}
    .brand-mark{
      flex:none;width:38px;height:38px;border-radius:12px;display:grid;place-items:center;
      color:#fff;font-size:17px;font-weight:700;letter-spacing:.5px;
      background:linear-gradient(135deg,var(--brand),var(--brand-2));
      box-shadow:0 8px 20px -10px var(--brand);
    }
    .brand-text{display:flex;flex-direction:column;min-width:0;line-height:1.25;text-align:left}
    .brand-text b{font-size:15.5px;font-weight:650;letter-spacing:.2px}
    .brand-text span{font-size:11.5px;color:var(--faint)}
    .brand-lg .brand-mark{width:46px;height:46px;border-radius:14px;font-size:20px}
    .brand-lg .brand-text b{font-size:19px}
    .brand-lg .brand-text span{font-size:12.5px}

    /* ---------- 顶栏 ---------- */
    .topbar{position:sticky;top:0;z-index:20;border-bottom:1px solid var(--line);background:var(--bg);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);background:color-mix(in srgb,var(--bg) 82%,transparent)}
    .topbar-inner{max-width:1240px;margin:0 auto;padding:12px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px}
    .topbar-actions{display:flex;align-items:center;gap:8px}

    /* ---------- 主体 ---------- */
    .wrap{max-width:1240px;margin:0 auto;padding:22px 20px 60px}
    .lang-bar{
      display:flex;align-items:center;gap:10px;flex-wrap:wrap;
      padding:12px;margin-bottom:18px;
      background:var(--card);border:1px solid var(--line);border-radius:var(--r-md);box-shadow:var(--shadow-sm);
    }
    .sel{
      appearance:none;-webkit-appearance:none;
      height:38px;padding:0 32px 0 14px;border:1px solid var(--line);border-radius:var(--r-sm);
      background:var(--card-soft) url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>") no-repeat right 11px center;
      font-size:13.5px;font-weight:500;cursor:pointer;transition:border-color .15s,background .15s;
    }
    .sel:hover{border-color:var(--line-strong)}
    .sel:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}
    .lang-bar-right{margin-left:auto;display:flex;gap:8px}
    .lang-arrow{color:var(--faint);font-size:15px;user-select:none}

    .workspace{display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:start}
    .pane{
      display:flex;flex-direction:column;min-height:400px;
      background:var(--card);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow);
      overflow:hidden;transition:border-color .2s,box-shadow .2s;
    }
    .pane:focus-within{border-color:var(--line-strong);box-shadow:var(--shadow-lg)}
    .pane-head{
      display:flex;align-items:center;justify-content:space-between;gap:10px;
      padding:12px 16px;border-bottom:1px solid var(--line);background:var(--card-soft);
    }
    .pane-title{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:620;letter-spacing:.3px;color:var(--muted)}
    .pane-title::before{content:"";width:3px;height:14px;border-radius:2px;background:linear-gradient(180deg,var(--brand),var(--brand-2))}
    .pane-meta{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--faint)}
    .pane-body{flex:1;display:flex;flex-direction:column;padding:16px;min-height:0}
    .pane-foot{
      display:flex;align-items:center;justify-content:space-between;gap:10px;
      padding:10px 16px;border-top:1px solid var(--line);background:var(--card-soft);
      font-size:11.5px;color:var(--faint);
    }

    /* ---------- 输入区 ---------- */
    .editor{
      flex:1;width:100%;min-height:200px;border:none;outline:none;background:transparent;resize:none;
      font-size:15.5px;line-height:1.95;color:var(--text);overflow:hidden;display:block;
    }
    .editor::placeholder{color:var(--faint)}
    .examples{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}
    .examples.hidden{display:none}
    .chip{
      border:1px dashed var(--line-strong);background:transparent;color:var(--muted);
      border-radius:99px;padding:5px 11px;font-size:12px;cursor:pointer;transition:.16s;
    }
    .chip:hover{color:var(--brand);border-color:var(--brand);background:var(--brand-soft);border-style:solid}
    .kbd{
      display:inline-block;padding:1px 6px;border:1px solid var(--line);border-bottom-width:2px;
      border-radius:6px;background:var(--card);font-size:11px;color:var(--muted);font-family:inherit;
    }

    /* ---------- 结果区 ---------- */
    .result{flex:1;min-height:200px;font-size:15.5px;line-height:1.95;word-break:break-word;overflow-wrap:anywhere}
    .result[data-state="empty"]{display:flex;align-items:center;justify-content:center}
    .empty{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:8px;padding:28px 12px;color:var(--faint)}
    .empty-icon{
      width:44px;height:44px;border-radius:14px;display:grid;place-items:center;font-size:20px;
      background:var(--brand-soft);color:var(--brand);margin-bottom:2px;
    }
    .empty-title{font-size:14px;font-weight:600;color:var(--text)}
    .empty-sub{font-size:12.5px;max-width:280px;line-height:1.7}
    .empty.error .empty-icon{background:var(--danger-soft);color:var(--danger)}

    .md h1,.md h2,.md h3,.md h4{line-height:1.4;margin:18px 0 10px;font-weight:650}
    .md > :first-child{margin-top:0}
    .md h1{font-size:23px}
    .md h2{font-size:18.5px;padding-bottom:6px;border-bottom:1px solid var(--line)}
    .md h3{font-size:16.5px}
    .md p{margin:0 0 12px}
    .md ul,.md ol{margin:0 0 12px 22px}
    .md li{margin:5px 0}
    .md li::marker{color:var(--brand)}
    .md strong{font-weight:680}
    .md em{font-style:italic}
    .md a{color:var(--brand);text-decoration:none;border-bottom:1px solid var(--brand-soft)}
    .md a:hover{border-bottom-color:var(--brand)}
    .md code{
      padding:2px 6px;border-radius:6px;background:var(--brand-soft);color:var(--brand);
      font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;
    }
    .md pre{
      margin:0 0 12px;padding:14px 16px;border-radius:var(--r-md);overflow-x:auto;
      background:var(--card-soft);border:1px solid var(--line);
    }
    .md pre code{padding:0;background:none;color:var(--text);font-size:.88em;line-height:1.7}
    .md blockquote{
      margin:0 0 12px;padding:6px 14px;border-left:3px solid var(--brand);
      background:var(--brand-soft);border-radius:0 var(--r-sm) var(--r-sm) 0;color:var(--muted);
    }
    .md hr{border:none;border-top:1px solid var(--line);margin:18px 0}
    .caret{display:inline-block;width:2px;height:1.05em;vertical-align:-2px;margin-left:2px;background:var(--brand);animation:blink 1s steps(2,start) infinite}
    @keyframes blink{0%,100%{opacity:1}50%{opacity:0}}

    .skeleton{display:flex;flex-direction:column;gap:12px;padding-top:6px}
    .skeleton span{display:block;height:13px;border-radius:99px;background:linear-gradient(90deg,var(--line) 25%,var(--card-soft) 50%,var(--line) 75%);background-size:200% 100%;animation:shimmer 1.4s infinite linear}
    .skeleton span:nth-child(1){width:92%}
    .skeleton span:nth-child(2){width:78%}
    .skeleton span:nth-child(3){width:56%}
    @keyframes shimmer{from{background-position:200% 0}to{background-position:-200% 0}}

    /* ---------- 状态胶囊 ---------- */
    .pill{
      display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:99px;
      font-size:11.5px;font-weight:520;white-space:nowrap;
      background:var(--card);border:1px solid var(--line);color:var(--muted);
    }
    .pill::before{content:"";width:6px;height:6px;border-radius:99px;background:currentColor;opacity:.75}
    .pill-idle{border-color:var(--line);color:var(--faint)}
    .pill-busy{background:var(--warn-soft);border-color:transparent;color:var(--warn)}
    .pill-busy::before{animation:pulse 1.1s infinite ease-in-out}
    .pill-ok{background:var(--ok-soft);border-color:transparent;color:var(--ok)}
    .pill-err{background:var(--danger-soft);border-color:transparent;color:var(--danger)}
    @keyframes pulse{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1.15)}}

    /* ---------- 历史抽屉 ---------- */
    .drawer-mask{position:fixed;inset:0;background:rgba(8,13,24,.5);backdrop-filter:blur(2px);opacity:0;pointer-events:none;transition:opacity .22s;z-index:30}
    .drawer-mask.show{opacity:1;pointer-events:auto}
    .drawer{
      position:fixed;top:0;right:0;height:100vh;height:100dvh;width:400px;max-width:92vw;z-index:40;
      display:flex;flex-direction:column;background:var(--card);border-left:1px solid var(--line);
      transform:translateX(102%);transition:transform .26s cubic-bezier(.22,1,.36,1);
    }
    .drawer.show{transform:none;box-shadow:var(--shadow-lg)}
    .drawer-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line)}
    .drawer-head b{font-size:14px;font-weight:620}
    .drawer-head-actions{display:flex;gap:6px}
    .drawer-search{padding:12px 16px 4px}
    .drawer-search input{
      width:100%;height:36px;padding:0 12px;border:1px solid var(--line);border-radius:var(--r-sm);
      background:var(--card-soft);font-size:13px;outline:none;transition:.15s;
    }
    .drawer-search input:focus{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}
    .history{flex:1;overflow:auto;padding:12px 16px 20px;display:flex;flex-direction:column;gap:10px}
    .item{
      border:1px solid var(--line);border-radius:var(--r-md);padding:12px;background:var(--card-soft);
      cursor:pointer;transition:.16s;
    }
    .item:hover{border-color:var(--brand);background:var(--brand-soft);transform:translateY(-1px)}
    .item p{font-size:13px;line-height:1.6;color:var(--text);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .item .meta{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;font-size:11.5px;color:var(--faint)}
    .item-actions{display:flex;justify-content:flex-end;margin-top:8px}
    .history-empty{color:var(--faint);font-size:13px;text-align:center;padding:30px 10px}

    /* ---------- 提示条 ---------- */
    .toast{
      position:fixed;left:50%;bottom:28px;transform:translate(-50%,14px);
      padding:10px 18px;border-radius:99px;font-size:13px;font-weight:500;
      background:var(--text);color:var(--bg);box-shadow:var(--shadow-lg);
      opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;z-index:60;
    }
    .toast.show{opacity:1;transform:translate(-50%,0)}

    /* ---------- 响应式 ---------- */
    @media (max-width:960px){
      .workspace{grid-template-columns:1fr}
      .pane{min-height:340px}
      .lang-bar-right{width:100%;margin-left:0}
      .lang-bar-right .btn{flex:1}
    }
    @media (max-width:560px){
      .wrap{padding:16px 14px 48px}
      .topbar-inner{padding:10px 14px}
      .brand-text span{display:none}
      .pane-head,.pane-body,.pane-foot{padding-left:13px;padding-right:13px}
      .editor,.result{font-size:15px}
      .drawer{width:100%;max-width:100%}
      .gate-card{padding:24px 18px}
    }
    @media (prefers-reduced-motion:reduce){
      *,*::before,*::after{animation-duration:.001ms !important;animation-iteration-count:1 !important;transition-duration:.001ms !important}
    }
  </style>
</head>
<body>
  <!-- ================= 验证闸门 ================= -->
  <div id="gate" class="gate hidden">
    <div class="gate-card">
      <div class="brand brand-lg">
        <span class="brand-mark">译</span>
        <div class="brand-text">
          <b>AI 智能翻译</b>
          <span>Cloudflare Workers AI 驱动</span>
        </div>
      </div>
      <p class="gate-hint">请完成安全验证后开始使用</p>
      <div class="ts-wrap">
        <div class="cf-turnstile"
            data-sitekey="${escapeHtmlAttr(siteKey)}"
            data-callback="onTurnstileSuccess"
            data-expired-callback="onTurnstileExpired"
            data-error-callback="onTurnstileError"></div>
      </div>
      <p id="gateTip" class="gate-tip">等待验证...</p>
    </div>
  </div>

  <!-- ================= 主界面 ================= -->
  <div id="app" class="app hidden">
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand">
          <span class="brand-mark">译</span>
          <div class="brand-text">
            <b>AI 智能翻译</b>
            <span>单词解析 · 长文翻译</span>
          </div>
        </div>
        <div class="topbar-actions">
          <button id="themeBtn" class="btn btn-icon" type="button" title="切换主题" aria-label="切换主题">◐</button>
          <button id="historyBtn" class="btn" type="button">历史记录</button>
          <button id="clearBtn" class="btn" type="button">清空</button>
        </div>
      </div>
    </header>

    <main class="wrap">
      <section class="lang-bar">
        <label class="sr" for="fromLang">源语言</label>
        <select id="fromLang" class="sel">
          <option value="auto">自动检测</option>
          <option value="zh">中文</option>
          <option value="en">英文</option>
          <option value="ja">日文</option>
          <option value="ko">韩文</option>
        </select>
        <button id="swapBtn" class="btn btn-icon" type="button" title="切换语言" aria-label="切换语言">⇄</button>
        <label class="sr" for="toLang">目标语言</label>
        <select id="toLang" class="sel">
          <option value="zh" selected>中文</option>
          <option value="en">英文</option>
          <option value="ja">日文</option>
          <option value="ko">韩文</option>
        </select>
        <div class="lang-bar-right">
          <button id="goBtn" class="btn btn-primary" type="button">立即翻译</button>
        </div>
      </section>

      <section class="workspace">
        <article class="pane">
          <header class="pane-head">
            <div class="pane-title">原文输入</div>
            <div class="pane-meta"><span id="sourceCount">0 字</span></div>
          </header>
          <div class="pane-body">
            <textarea id="sourceText" class="editor" spellcheck="false" placeholder="输入单词、句子或整篇文章…"></textarea>
            <div id="examples" class="examples">
              <button class="chip" type="button" data-text="hello">hello</button>
              <button class="chip" type="button" data-text="How are you today?">How are you today?</button>
              <button class="chip" type="button" data-text="Cloudflare Workers 是一个边缘计算平台。">试试中译英</button>
            </div>
          </div>
          <footer class="pane-foot">
            <span><span class="kbd">Ctrl</span> + <span class="kbd">Enter</span> 立即翻译</span>
            <span>自动翻译已开启</span>
          </footer>
        </article>

        <article class="pane">
          <header class="pane-head">
            <div class="pane-title">翻译结果</div>
            <div class="pane-meta">
              <span id="statusInfo" class="pill pill-idle">会话检查中…</span>
              <button id="copyBtn" class="btn btn-sm" type="button">复制</button>
            </div>
          </header>
          <div class="pane-body">
            <div id="result" class="result" data-state="empty"></div>
          </div>
          <footer class="pane-foot">
            <span id="resultCount">0 字</span>
            <span id="modeInfo"></span>
          </footer>
        </article>
      </section>
    </main>
  </div>

  <!-- ================= 历史抽屉 ================= -->
  <div id="mask" class="drawer-mask"></div>
  <aside id="drawer" class="drawer" aria-hidden="true">
    <header class="drawer-head">
      <b>历史记录</b>
      <div class="drawer-head-actions">
        <button id="clearHistoryBtn" class="btn btn-sm" type="button">清空</button>
        <button id="closeHistoryBtn" class="btn btn-sm btn-icon" type="button" aria-label="关闭">✕</button>
      </div>
    </header>
    <div class="drawer-search">
      <input id="historySearch" type="search" placeholder="搜索历史记录…" autocomplete="off" />
    </div>
    <div id="historyList" class="history"></div>
  </aside>

  <div id="toast" class="toast" role="status" aria-live="polite"></div>

  <script>
    "use strict";
    const HISTORY_KEY = "translator_history_v10";
    const THEME_KEY = "translator_theme_v1";
    const MAX_RETRY = 3;
    const WATCHDOG_MS = 60000;
    const TURNSTILE_ENABLED = ${JSON.stringify(!!turnstileEnabled)};
    // 用字符码构造反引号相关正则，避免与外层模板字符串冲突
    const TICK = String.fromCharCode(96);
    const RE_INLINE_CODE = new RegExp(TICK + "([^" + TICK + "]+)" + TICK, "g");
    const RE_FENCE = new RegExp("^" + TICK + TICK + TICK);

    let verified = false;
    let debounceTimer = null;
    let currentController = null;
    let lastSubmittedText = "";
    let lastSubmittedFrom = "";
    let lastSubmittedTo = "";
    let currentMode = "translate";
    let toastTimer = null;
    let historyQuery = "";

    const byId = function (id) { return document.getElementById(id); };
    const gate = byId("gate");
    const app = byId("app");
    const gateTip = byId("gateTip");
    const sourceText = byId("sourceText");
    const result = byId("result");
    const sourceCount = byId("sourceCount");
    const resultCount = byId("resultCount");
    const statusInfo = byId("statusInfo");
    const modeInfo = byId("modeInfo");
    const fromLang = byId("fromLang");
    const toLang = byId("toLang");
    const historyList = byId("historyList");
    const historySearch = byId("historySearch");
    const drawer = byId("drawer");
    const mask = byId("mask");
    const toastEl = byId("toast");
    const examples = byId("examples");

    initTheme();
    bindEvents();
    renderHistory();
    renderEmptyResult();
    checkSession();
    requestAnimationFrame(function () { autoGrowTextarea(); syncPanelHeights(); });

    /* ---------------- 界面状态 ---------------- */
    function setStatus(text, kind) {
      statusInfo.innerText = text;
      statusInfo.className = "pill pill-" + (kind || "idle");
    }
    function showToast(message) {
      toastEl.innerText = message;
      toastEl.classList.add("show");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 2000);
    }
    function setMode(mode) {
      currentMode = mode === "word" ? "word" : "translate";
      modeInfo.innerText = currentMode === "word" ? "词汇解析模式" : "整句翻译模式";
    }

    function bindEvents() {
      byId("themeBtn").addEventListener("click", toggleTheme);
      byId("historyBtn").addEventListener("click", openHistory);
      byId("clearBtn").addEventListener("click", clearAll);
      byId("goBtn").addEventListener("click", function () { translateText(true); });
      byId("swapBtn").addEventListener("click", swapLanguage);
      byId("copyBtn").addEventListener("click", copyResult);
      byId("clearHistoryBtn").addEventListener("click", clearHistory);
      byId("closeHistoryBtn").addEventListener("click", closeHistory);
      mask.addEventListener("click", closeHistory);
      sourceText.addEventListener("input", onInput);
      sourceText.addEventListener("blur", function () { autoTranslate(); });
      sourceText.addEventListener("keydown", function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          translateText(true);
        }
      });
      fromLang.addEventListener("change", function () {
        if (!sourceText.value.trim()) return;
        immediateRetranslate();
      });
      toLang.addEventListener("change", function () {
        if (!sourceText.value.trim()) return;
        immediateRetranslate();
      });
      examples.addEventListener("click", function (e) {
        const chip = e.target.closest(".chip");
        if (!chip) return;
        sourceText.value = chip.getAttribute("data-text") || "";
        syncExampleChips();
        autoGrowTextarea();
        sourceCount.innerText = sourceText.value.length + " 字";
        immediateRetranslate();
      });
      historySearch.addEventListener("input", function () {
        historyQuery = historySearch.value || "";
        renderHistory();
      });
      historyList.addEventListener("click", function (e) {
        const del = e.target.closest("[data-action='delete']");
        if (del) {
          e.stopPropagation();
          deleteHistoryItem(del.getAttribute("data-id"));
          return;
        }
        const item = e.target.closest(".item");
        if (item) loadHistory(item.getAttribute("data-id"));
      });
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") closeHistory();
      });
      window.addEventListener("resize", function () {
        autoGrowTextarea();
        syncPanelHeights();
      });
    }

    function syncExampleChips() {
      examples.classList.toggle("hidden", !!sourceText.value.trim());
    }
    function sleep(ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }
    function immediateRetranslate() {
      clearTimeout(debounceTimer);
      lastSubmittedText = "";
      lastSubmittedFrom = "";
      lastSubmittedTo = "";
      translateText(false);
    }
    function autoGrowTextarea() {
      sourceText.style.height = "auto";
      sourceText.style.height = Math.max(sourceText.scrollHeight, 200) + "px";
    }
    function syncPanelHeights() {
      const leftH = Math.max(sourceText.scrollHeight, 200);
      const rightH = Math.max(result.scrollHeight, 200);
      const target = Math.max(leftH, rightH, 200);
      sourceText.style.height = target + "px";
      result.style.minHeight = target + "px";
    }

    /* ---------------- 会话与验证 ---------------- */
    async function checkSession() {
      if (!TURNSTILE_ENABLED) {
        verified = true;
        gate.classList.add("hidden");
        app.classList.remove("hidden");
        setStatus("可以开始翻译", "ok");
        requestAnimationFrame(syncPanelHeights);
        return;
      }
      try {
        const r = await fetch("/api/session");
        const d = await r.json();
        if (d.ok) {
          verified = true;
          gate.classList.add("hidden");
          app.classList.remove("hidden");
          setStatus("会话有效", "ok");
          requestAnimationFrame(syncPanelHeights);
        } else {
          gate.classList.remove("hidden");
          app.classList.add("hidden");
        }
      } catch (e) {
        gate.classList.remove("hidden");
        app.classList.add("hidden");
      }
    }
    async function onTurnstileSuccess(token) {
      gateTip.innerText = "验证成功，正在进入…";
      try {
        const r = await fetch("/api/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ turnstileToken: token })
        });
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.error || "验证失败");
        verified = true;
        gate.classList.add("hidden");
        app.classList.remove("hidden");
        setStatus("会话有效", "ok");
        requestAnimationFrame(syncPanelHeights);
      } catch (e) {
        gateTip.innerText = "验证失败，请重试";
      }
    }
    function onTurnstileExpired() {
      verified = false;
      gateTip.innerText = "验证已过期，请重新验证";
    }
    function onTurnstileError() {
      verified = false;
      gateTip.innerText = "验证异常，请刷新页面重试";
    }

    /* ---------------- 输入 ---------------- */
    function onInput() {
      const text = sourceText.value;
      sourceCount.innerText = text.length + " 字";
      syncExampleChips();
      autoGrowTextarea();
      if (!text.trim()) {
        clearTimeout(debounceTimer);
        lastSubmittedText = "";
        lastSubmittedFrom = "";
        lastSubmittedTo = "";
        if (currentController) currentController.abort();
        renderEmptyResult();
        resultCount.innerText = "0 字";
        setStatus("可以开始翻译", "ok");
        syncPanelHeights();
        return;
      }
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () { autoTranslate(); }, 900);
      syncPanelHeights();
    }
    function autoTranslate() {
      const text = sourceText.value.trim();
      if (!verified || !text) return;
      if (text === lastSubmittedText && fromLang.value === lastSubmittedFrom && toLang.value === lastSubmittedTo) return;
      translateText(false);
    }
    function swapLanguage() {
      if (fromLang.value === "auto") {
        showToast("自动检测模式下无法直接切换源语言");
        return;
      }
      const tmp = fromLang.value;
      fromLang.value = toLang.value;
      toLang.value = tmp;
      if (sourceText.value.trim()) immediateRetranslate();
    }

    /* ---------------- 请求 ---------------- */
    async function doTranslateRequest(text, signal) {
      let timedOut = false;
      const localAbort = new AbortController();
      const relayAbort = function () { try { localAbort.abort(); } catch (e) {} };
      if (signal) {
        if (signal.aborted) relayAbort();
        else signal.addEventListener("abort", relayAbort, { once: true });
      }
      let watchdog = null;
      const armWatchdog = function () {
        clearTimeout(watchdog);
        watchdog = setTimeout(function () { timedOut = true; relayAbort(); }, WATCHDOG_MS);
      };
      armWatchdog();
      try {
        const res = await fetch("/api/translate/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify({ text: text, from: fromLang.value, to: toLang.value }),
          signal: localAbort.signal
        });
        if (!res.ok || !res.body) {
          let msg = "服务暂时不可用，请再次尝试";
          try {
            const ct = (res.headers.get("content-type") || "").toLowerCase();
            if (ct.indexOf("application/json") !== -1) {
              const data = await res.json();
              if (data && data.error) msg = String(data.error);
            } else {
              const txt = (await res.text()).trim();
              if (txt) msg = txt.slice(0, 300);
            }
          } catch (e) {}
          const err = new Error(msg);
          if (res.status === 400 || res.status === 401 || res.status === 403) err.retryable = false;
          throw err;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let finalText = "";
        let receivedAnyData = false;
        let chunkCount = 0;
        while (true) {
          const step = await reader.read();
          if (step.done) break;
          armWatchdog();
          buffer += decoder.decode(step.value, { stream: true });
          chunkCount++;
          const blocks = buffer.split("\\n\\n");
          buffer = blocks.pop() || "";
          for (let i = 0; i < blocks.length; i++) {
            const evt = parseSSE(blocks[i]);
            if (!evt) continue;
            receivedAnyData = true;
            armWatchdog();
            if (evt.event === "ping") continue;
            if (evt.event === "start") setMode(evt.data && evt.data.mode);
            if (evt.event === "reset") {
              finalText = "";
              result.dataset.state = "typing";
              result.innerHTML = "";
              resultCount.innerText = "0 字";
              continue;
            }
            if (evt.event === "delta") {
              if (evt.data && evt.data.replace) finalText = evt.data.content || finalText;
              else finalText += (evt.data && evt.data.content) || "";
              renderResult(finalText, true);
              resultCount.innerText = finalText.length + " 字";
            }
            if (evt.event === "final") {
              finalText = (evt.data && evt.data.content) || finalText;
              renderResult(finalText, false);
              resultCount.innerText = finalText.length + " 字";
            }
            if (evt.event === "done") return finalText;
            if (evt.event === "error") {
              const err = new Error((evt.data && evt.data.error) || "处理失败，请再次尝试");
              if (evt.data && evt.data.retryable === false) err.retryable = false;
              throw err;
            }
          }
        }
        if (buffer.trim()) {
          const evt = parseSSE(buffer);
          if (evt) {
            if (evt.event === "final") finalText = (evt.data && evt.data.content) || finalText;
            if (evt.event === "delta") finalText += (evt.data && evt.data.content) || "";
          }
        }
        if (!finalText.trim()) {
          if (!receivedAnyData) throw new Error("上游未返回任何数据，请检查模型配置或稍后重试");
          throw new Error("上游返回空内容（收到 " + chunkCount + " 个数据块），可能是模型拒绝回答，请换个说法重试");
        }
        return finalText;
      } catch (err) {
        if (timedOut && err && err.name === "AbortError") {
          throw new Error("请求超时：模型长时间没有响应，请重试或更换更快的模型");
        }
        throw err;
      } finally {
        clearTimeout(watchdog);
        if (signal) signal.removeEventListener("abort", relayAbort);
      }
    }

    async function translateText(manual) {
      const text = sourceText.value.trim();
      if (!verified) {
        showToast("请先完成安全验证");
        return;
      }
      if (!text) {
        renderEmptyResult();
        return;
      }
      lastSubmittedText = text;
      lastSubmittedFrom = fromLang.value;
      lastSubmittedTo = toLang.value;
      if (currentController) currentController.abort();
      currentController = new AbortController();
      result.dataset.state = "typing";
      result.innerHTML = renderSkeleton();
      resultCount.innerText = "0 字";
      setStatus(manual ? "正在翻译…" : "自动翻译中…", "busy");
      requestAnimationFrame(syncPanelHeights);
      let attempt = 0;
      while (attempt < MAX_RETRY) {
        attempt++;
        try {
          if (attempt > 1) setStatus("请求失败，正在重试（" + attempt + "/" + MAX_RETRY + "）", "busy");
          const finalText = await doTranslateRequest(text, currentController.signal);
          setStatus(currentMode === "word" ? "解析完成" : "翻译完成", "ok");
          saveHistory({
            id: Date.now() + "_" + Math.random().toString(36).slice(2, 8),
            source: text,
            from: fromLang.value,
            to: toLang.value,
            result: finalText,
            mode: currentMode,
            time: new Date().toISOString()
          });
          return;
        } catch (err) {
          if (err.name === "AbortError") return;
          if (err.retryable === false || attempt >= MAX_RETRY) {
            setStatus("处理失败", "err");
            renderFriendlyError(err && err.message);
            return;
          }
          await sleep(700 * attempt);
        }
      }
    }

    /* ---------------- 渲染 ---------------- */
    function renderSkeleton() {
      return '<div class="skeleton"><span></span><span></span><span></span></div>';
    }
    function renderResult(text, typing) {
      result.dataset.state = typing ? "typing" : "done";
      const caret = typing ? '<span class="caret"></span>' : "";
      result.innerHTML = '<div class="md">' + renderMarkdown(text) + caret + "</div>";
      requestAnimationFrame(syncPanelHeights);
    }
    function renderEmptyResult() {
      result.dataset.state = "empty";
      setMode("translate");
      result.innerHTML =
        '<div class="empty">' +
          '<div class="empty-icon">✦</div>' +
          '<div class="empty-title">等待翻译内容</div>' +
          '<div class="empty-sub">输入单词会给出释义与例句；输入句子或段落会直接翻译</div>' +
        "</div>";
      requestAnimationFrame(syncPanelHeights);
    }
    function renderFriendlyError(message) {
      result.dataset.state = "error";
      result.innerHTML =
        '<div class="empty error">' +
          '<div class="empty-icon">⚠</div>' +
          '<div class="empty-title">处理失败</div>' +
          '<div class="empty-sub">' + escapeHtml(message || "服务暂时繁忙，请稍后再次尝试") + "</div>" +
        "</div>";
      resultCount.innerText = "0 字";
      requestAnimationFrame(syncPanelHeights);
    }
    function parseSSE(block) {
      const lines = block.split("\\n");
      let event = "message";
      let data = "";
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.indexOf("event: ") === 0) event = line.slice(7).trim();
        else if (line.indexOf("data: ") === 0) data += line.slice(6);
      }
      if (!data) return null;
      try {
        return { event: event, data: JSON.parse(data) };
      } catch (e) {
        return null;
      }
    }

    /* ---------------- Markdown ---------------- */
    function renderMarkdown(md) {
      const lines = String(md || "").replace(/\\r\\n?/g, "\\n").split("\\n");
      let out = "";
      let inP = false;
      let inOl = false;
      let inUl = false;
      let inQuote = false;
      let inCode = false;
      const codeBuf = [];
      const closeP = function () { if (inP) { out += "</p>"; inP = false; } };
      const closeOl = function () { if (inOl) { out += "</ol>"; inOl = false; } };
      const closeUl = function () { if (inUl) { out += "</ul>"; inUl = false; } };
      const closeQuote = function () { if (inQuote) { out += "</blockquote>"; inQuote = false; } };
      const closeAll = function () { closeP(); closeOl(); closeUl(); closeQuote(); };
      const inline = function (text) {
        let s = escapeHtml(text);
        s = s.replace(RE_INLINE_CODE, "<code>$1</code>");
        s = s.replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>");
        s = s.replace(/(^|[\\s(])\\*(?!\\*)([^*]+)\\*(?!\\*)/g, "$1<em>$2</em>");
        s = s.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
        return s;
      };
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const line = raw.trim();
        if (RE_FENCE.test(line)) {
          if (inCode) {
            out += "<pre><code>" + escapeHtml(codeBuf.join("\\n")) + "</code></pre>";
            codeBuf.length = 0;
            inCode = false;
          } else {
            closeAll();
            inCode = true;
          }
          continue;
        }
        if (inCode) { codeBuf.push(raw); continue; }
        if (!line) { closeAll(); continue; }
        if (/^(-{3,}|\\*{3,}|_{3,})$/.test(line)) {
          closeAll();
          out += "<hr>";
          continue;
        }
        const h = line.match(/^(#{1,6})\\s*(.+)$/);
        if (h) {
          closeAll();
          const level = h[1].length;
          out += "<h" + level + ">" + inline(h[2]) + "</h" + level + ">";
          continue;
        }
        const quote = line.match(/^>\\s?(.*)$/);
        if (quote) {
          closeP(); closeOl(); closeUl();
          if (!inQuote) { out += "<blockquote>"; inQuote = true; }
          out += "<p>" + inline(quote[1]) + "</p>";
          continue;
        }
        // 列表标记后必须跟空白，否则 "**加粗**" 会被误判成无序列表
        const ol = line.match(/^\\d+[.)]\\s+(.+)$/);
        if (ol) {
          closeP(); closeUl(); closeQuote();
          if (!inOl) { out += "<ol>"; inOl = true; }
          out += "<li>" + inline(ol[1]) + "</li>";
          continue;
        }
        const ul = line.match(/^[-*]\\s+(.+)$/);
        if (ul) {
          closeP(); closeOl(); closeQuote();
          if (!inUl) { out += "<ul>"; inUl = true; }
          out += "<li>" + inline(ul[1]) + "</li>";
          continue;
        }
        closeOl(); closeUl(); closeQuote();
        if (!inP) {
          out += "<p>";
          inP = true;
          out += inline(line);
        } else {
          out += "<br>" + inline(line);
        }
      }
      if (inCode && codeBuf.length) out += "<pre><code>" + escapeHtml(codeBuf.join("\\n")) + "</code></pre>";
      closeAll();
      return out || "<p></p>";
    }

    /* ---------------- 历史记录 ---------------- */
    function getHistory() {
      try {
        return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      } catch (e) {
        return [];
      }
    }
    function saveHistory(item) {
      const list = getHistory();
      list.unshift(item);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 30)));
      } catch (e) {}
      renderHistory();
    }
    function filteredHistory() {
      const list = getHistory();
      const q = historyQuery.trim().toLowerCase();
      if (!q) return list;
      return list.filter(function (it) {
        return String(it.source || "").toLowerCase().indexOf(q) !== -1 ||
               String(it.result || "").toLowerCase().indexOf(q) !== -1;
      });
    }
    function renderHistory() {
      const list = filteredHistory();
      if (!list.length) {
        historyList.innerHTML = '<div class="history-empty">' +
          (historyQuery.trim() ? "没有匹配的记录" : "暂无历史记录") + "</div>";
        return;
      }
      historyList.innerHTML = list.map(function (it) {
        const label = it.mode === "word" ? "词汇解析" : (escapeHtml(it.from || "") + " → " + escapeHtml(it.to || ""));
        return '<div class="item" data-id="' + escapeHtml(it.id) + '">' +
          "<p>" + escapeHtml(it.source || "") + "</p>" +
          '<div class="meta"><span>' + label + "</span><span>" + formatTime(it.time) + "</span></div>" +
          '<div class="item-actions"><button class="btn btn-sm" type="button" data-action="delete" data-id="' +
            escapeHtml(it.id) + '">删除</button></div>' +
        "</div>";
      }).join("");
    }
    function loadHistory(id) {
      const item = getHistory().filter(function (x) { return x.id === id; })[0];
      if (!item) return;
      fromLang.value = item.from || "auto";
      toLang.value = item.to || "zh";
      sourceText.value = item.source || "";
      sourceCount.innerText = sourceText.value.length + " 字";
      setMode(item.mode);
      renderResult(item.result || "", false);
      resultCount.innerText = (item.result || "").length + " 字";
      lastSubmittedText = item.source || "";
      lastSubmittedFrom = item.from || "auto";
      lastSubmittedTo = item.to || "zh";
      closeHistory();
      syncExampleChips();
      autoGrowTextarea();
      requestAnimationFrame(syncPanelHeights);
    }
    function deleteHistoryItem(id) {
      const list = getHistory().filter(function (x) { return x.id !== id; });
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
      } catch (e) {}
      renderHistory();
      showToast("已删除该条记录");
    }
    function clearHistory() {
      try {
        localStorage.removeItem(HISTORY_KEY);
      } catch (e) {}
      renderHistory();
      showToast("历史记录已清空");
    }
    function openHistory() {
      drawer.classList.add("show");
      drawer.setAttribute("aria-hidden", "false");
      mask.classList.add("show");
    }
    function closeHistory() {
      drawer.classList.remove("show");
      drawer.setAttribute("aria-hidden", "true");
      mask.classList.remove("show");
    }
    function clearAll() {
      sourceText.value = "";
      sourceCount.innerText = "0 字";
      resultCount.innerText = "0 字";
      lastSubmittedText = "";
      lastSubmittedFrom = "";
      lastSubmittedTo = "";
      if (currentController) currentController.abort();
      syncExampleChips();
      renderEmptyResult();
      setStatus("可以开始翻译", "ok");
      autoGrowTextarea();
      requestAnimationFrame(syncPanelHeights);
    }

    /* ---------------- 复制与主题 ---------------- */
    async function copyResult() {
      const text = result.innerText.trim();
      if (result.dataset.state !== "done" || !text) {
        showToast("暂无可复制的内容");
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        showToast("已复制到剪贴板");
      } catch (e) {
        try {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          showToast("已复制到剪贴板");
        } catch (e2) {
          showToast("复制失败，请手动选择复制");
        }
      }
    }
    function initTheme() {
      let t = null;
      try {
        t = localStorage.getItem(THEME_KEY);
      } catch (e) {}
      if (t !== "light" && t !== "dark") {
        t = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
      document.documentElement.setAttribute("data-theme", t);
    }
    function toggleTheme() {
      const c = document.documentElement.getAttribute("data-theme") || "light";
      const n = c === "light" ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", n);
      try {
        localStorage.setItem(THEME_KEY, n);
      } catch (e) {}
      showToast(n === "dark" ? "已切换到暗色模式" : "已切换到亮色模式");
    }
    function formatTime(iso) {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      const p = function (n) { return String(n).padStart(2, "0"); };
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    }
    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }
    window.onTurnstileSuccess = onTurnstileSuccess;
    window.onTurnstileExpired = onTurnstileExpired;
    window.onTurnstileError = onTurnstileError;
  </script>
</body>
</html>`;
}

function escapeHtmlAttr(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
