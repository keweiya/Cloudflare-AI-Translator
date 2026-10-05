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
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": cookie,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  } catch {
    return json({ error: "验证失败，请重试" }, 500);
  }
}

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

          const pushLive = () => {
            if (clientGone) return;
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
              const upstreamBody = await openUpstreamStream(upstreamCtx, ac.signal);
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
              pushLive();
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
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
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
      ? env.CF_MODEL || env.CUSTOM_API_MODEL || env.API_MODEL || ""
      : env.CUSTOM_API_MODEL || env.API_MODEL || ""
  ).trim();
  return { useCFAI, baseUrl, apiKey, model };
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
    const inputs = { messages: ctx.messages, stream: true };
    let result;
    try {
      result = await raceWithSignal(ctx.env.AI.run(ctx.model, inputs), signal);
    } catch (err) {
      if (signal && signal.aborted) throw abortError(signal);
      // 部分模型不支持 stream:true，回退到一次性返回
      result = await raceWithSignal(
        ctx.env.AI.run(ctx.model, { messages: ctx.messages }),
        signal
      );
    }
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
  if (/no data from upstream|timed? ?out|exceeded the total time limit/i.test(message)) {
    return "上游模型响应超时。请稍后再试，或更换响应更快的模型。";
  }
  if (/no usable text tokens|empty body|empty response/i.test(message)) {
    return "上游返回了空内容，可能是模型拒绝回答，请换个说法或更换模型后重试。";
  }
  if (!message) return "Upstream service error or empty response after retries.";
  return "上游服务错误：" + message.slice(0, 200);
}

function cleanupTail(text) {
  let t = String(text || "").trim();
  const tailPatterns = [
    /\n*[-*]?\s*if you want[^\n]*$/gi,
    /\n*[-*]?\s*if needed[^\n]*$/gi,
    /\n*[-*]?\s*i can also[^\n]*$/gi,
    /\n*[-*]?\s*let me know[^\n]*$/gi,
  ];
  for (const p of tailPatterns) t = t.replace(p, "");
  return t.trim();
}

function cleanupModelOutput(text, options = {}) {
  let t = String(text || "").replace(/\r\n?/g, "\n").trim();
  // ★ 如果原始内容就很短，不要过度清洗
  if (t.length < 50) {
    t = unwrapMarkdownFence(t, !!options.allowPartialFence);
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

function stripTranslationMetaLines(text) {
  return String(text || "")
    .replace(/\n?[-*]?\s*\*?\(?(?:\u8BED\u5883\u8BC6\u522B|context\s*recognition|context|note)[:?][^\n]*\)?\*?\s*$/i, "")
    .trim();
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
      ctx.env.AI.run(ctx.model, { messages, stream: false }),
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
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

function htmlResponse(html) {
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function getHtml(siteKey, turnstileEnabled) {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AI 智能翻译</title>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
  <style>
    :root{
      --bg:#f6f8fc; --card:#fff; --text:#111827; --muted:#6b7280; --line:#e5e7eb;
      --primary:#4f46e5; --primary2:#7c3aed; --shadow:0 10px 30px rgba(0,0,0,.08);
    }
    html[data-theme="dark"]{
      --bg:#0b1220; --card:#111827; --text:#e5e7eb; --muted:#9ca3af; --line:#374151;
      --shadow:0 10px 30px rgba(0,0,0,.35);
    }
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Inter,"PingFang SC","Microsoft YaHei",Arial;background:var(--bg);color:var(--text)}
    .hidden{display:none !important}
    .gate{
      min-height:100vh;
      display:flex;
      align-items:center;
      justify-content:center;
      padding:16px;
    }
    .gate-card{
      max-width:520px;
      width:100%;
      background:var(--card);
      border:1px solid var(--line);
      border-radius:24px;
      box-shadow:var(--shadow);
      padding:24px;
      text-align:center;
      margin:0 auto;
    }
    .ts-wrap{
      width:100%;
      display:flex;
      justify-content:center;
      align-items:center;
      overflow-x:auto;
      -webkit-overflow-scrolling:touch;
    }
    .ts-wrap .cf-turnstile{
      margin:0 auto !important;
    }
    @media (max-width:480px){
      .gate-card{
        padding:18px 14px;
        border-radius:16px;
      }
    }
    .app{min-height:100vh}
    .top{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);z-index:10}
    .top-in{max-width:1200px;margin:0 auto;padding:14px 16px;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}
    .btn,.sel{border:none;border-radius:12px;padding:10px 14px}
    .btn{background:#fff;cursor:pointer}
    .pri{background:linear-gradient(90deg,var(--primary),var(--primary2));color:#fff}
    .main{max-width:1200px;margin:0 auto;padding:16px}
    .toolbar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
    .panel{display:grid;grid-template-columns:1fr 1fr;gap:16px}
    .card{
      background:var(--card);
      border:1px solid var(--line);
      border-radius:20px;
      box-shadow:var(--shadow);
      padding:16px;
      min-height:360px;
      display:flex;
      flex-direction:column;
      align-items:stretch;
    }
    .head{display:flex;justify-content:space-between;color:var(--muted);font-size:12px;margin-bottom:10px}
    .content-area{
      width:100%;
      min-height:140px;
      border:none;
      outline:none;
      background:transparent;
      color:var(--text);
      font-size:16px;
      line-height:1.9;
      padding:0;
      margin:0;
      white-space:pre-wrap;
      word-break:break-word;
      flex:1;
    }
    textarea.content-area{
      resize:none;
      overflow:hidden;
      font-family:inherit;
      display:block;
    }
    .result-box{
      background:transparent;
      border:none;
      border-radius:0;
      padding:0;
      min-height:140px;
    }
    .result-typing{transition:opacity .18s ease;opacity:.98}
    .empty{
      min-height:140px;display:flex;align-items:center;justify-content:center;flex-direction:column;
      color:var(--muted);text-align:center;padding:18px
    }
    .empty i{font-style:normal;font-size:24px;margin-bottom:8px}
    .md h1,.md h2,.md h3{line-height:1.4;margin:12px 0 8px}
    .md h1{font-size:22px}
    .md h2{font-size:19px}
    .md h3{font-size:17px}
    .md hr{border:none;border-top:1px solid var(--line);margin:10px 0}
    .md p{margin:0 0 10px;line-height:1.9}
    .md ol,.md ul{margin:0 0 10px 22px}
    .md li{margin:4px 0;line-height:1.8}
    .md strong{font-weight:700}
    .md em{font-style:italic}
    .md code{padding:1px 4px;border-radius:6px;background:rgba(0,0,0,.06)}
    html[data-theme="dark"] .md code{background:rgba(255,255,255,.12)}
    .foot{margin-top:10px;color:var(--muted);font-size:12px;display:flex;justify-content:space-between}
    .drawer-mask{position:fixed;inset:0;background:rgba(0,0,0,.35);opacity:0;pointer-events:none;transition:.2s}
    .drawer-mask.show{opacity:1;pointer-events:auto}
    .drawer{
      position:fixed;right:0;top:0;height:100vh;width:400px;max-width:92vw;background:var(--card);
      border-left:1px solid var(--line);transform:translateX(100%);transition:.2s;z-index:30;display:flex;flex-direction:column
    }
    .drawer.show{transform:translateX(0)}
    .drawer-h{padding:14px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between}
    .history{padding:12px;overflow:auto;display:flex;flex-direction:column;gap:10px}
    .item{border:1px solid var(--line);border-radius:12px;padding:10px;background:var(--card);cursor:pointer}
    .item p{font-size:13px;line-height:1.6;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .meta{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-top:6px}
    @media (max-width:960px){.panel{grid-template-columns:1fr}.card{min-height:320px}}
  </style>
</head>
<body>
  <div id="gate" class="gate hidden">
    <div class="gate-card">
      <h2 style="margin-bottom:8px">AI 智能翻译</h2>
      <p style="color:#6b7280;margin-bottom:16px">请先完成安全验证</p>
      <div class="ts-wrap">
        <div class="cf-turnstile"
            data-sitekey="${escapeHtmlAttr(siteKey)}"
            data-callback="onTurnstileSuccess"
            data-expired-callback="onTurnstileExpired"
            data-error-callback="onTurnstileError"></div>
      </div>
      <p id="gateTip" style="margin-top:12px;color:#6b7280;font-size:13px">等待验证...</p>
    </div>
  </div>
  <div id="app" class="app hidden">
    <div class="top">
      <div class="top-in">
        <div style="font-weight:700">AI 智能翻译</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button id="themeBtn" class="btn">🌓 主题</button>
          <button id="historyBtn" class="btn">历史记录</button>
          <button id="clearBtn" class="btn">清空</button>
          <button id="goBtn" class="btn pri">立即翻译</button>
        </div>
      </div>
    </div>
    <div class="main">
      <div class="toolbar">
        <select id="fromLang" class="sel">
          <option value="auto">自动检测</option>
          <option value="zh">中文</option>
          <option value="en">英文</option>
          <option value="ja">日文</option>
          <option value="ko">韩文</option>
        </select>
        <button id="swapBtn" class="btn">⇄ 切换语言</button>
        <select id="toLang" class="sel">
          <option value="zh" selected>中文</option>
          <option value="en">英文</option>
          <option value="ja">日文</option>
          <option value="ko">韩文</option>
        </select>
        <button id="copyBtn" class="btn">复制结果</button>
      </div>
      <div class="panel">
        <div class="card">
          <div class="head"><span>原文输入</span><span>Ctrl/Cmd + Enter</span></div>
          <textarea id="sourceText" class="content-area" placeholder="请输入要翻译的内容或单词..."></textarea>
          <div class="foot"><span>自动翻译已开启</span><span id="sourceCount">0 字</span></div>
        </div>
        <div class="card" id="resultCard">
          <div class="head"><span>翻译结果</span><span id="statusInfo">会话检查中...</span></div>
          <div id="result" class="result-wrap content-area"></div>
          <div class="foot"><span>整页滚动查看长文</span><span id="resultCount">0 字</span></div>
        </div>
      </div>
    </div>
  </div>
  <div id="mask" class="drawer-mask"></div>
  <div id="drawer" class="drawer">
    <div class="drawer-h">
      <b>历史记录</b>
      <div style="display:flex;gap:8px">
        <button id="clearHistoryBtn" class="btn">清空</button>
        <button id="closeHistoryBtn" class="btn">关闭</button>
      </div>
    </div>
    <div id="historyList" class="history"></div>
  </div>
  <script>
    const HISTORY_KEY = "translator_history_v10";
    const THEME_KEY = "translator_theme_v1";
    const MAX_RETRY = 3;
    const TURNSTILE_ENABLED = ${JSON.stringify(!!turnstileEnabled)};
    let verified = false;
    let debounceTimer = null;
    let currentController = null;
    let lastSubmittedText = "";
    let lastSubmittedFrom = "";
    let lastSubmittedTo = "";
    let currentMode = "translate";
    const gate = document.getElementById("gate");
    const app = document.getElementById("app");
    const gateTip = document.getElementById("gateTip");
    const sourceText = document.getElementById("sourceText");
    const result = document.getElementById("result");
    const sourceCount = document.getElementById("sourceCount");
    const resultCount = document.getElementById("resultCount");
    const statusInfo = document.getElementById("statusInfo");
    const fromLang = document.getElementById("fromLang");
    const toLang = document.getElementById("toLang");
    const historyList = document.getElementById("historyList");
    const drawer = document.getElementById("drawer");
    const mask = document.getElementById("mask");
    initTheme();
    bindEvents();
    renderHistory();
    renderEmptyResult();
    checkSession();
    requestAnimationFrame(() => {
      autoGrowTextarea();
      syncPanelHeights();
    });
    function bindEvents() {
      document.getElementById("themeBtn").addEventListener("click", toggleTheme);
      document.getElementById("historyBtn").addEventListener("click", openHistory);
      document.getElementById("clearBtn").addEventListener("click", clearAll);
      document.getElementById("goBtn").addEventListener("click", () => translateText(true));
      document.getElementById("swapBtn").addEventListener("click", swapLanguage);
      document.getElementById("copyBtn").addEventListener("click", copyResult);
      document.getElementById("clearHistoryBtn").addEventListener("click", clearHistory);
      document.getElementById("closeHistoryBtn").addEventListener("click", closeHistory);
      mask.addEventListener("click", closeHistory);
      sourceText.addEventListener("input", onInput);
      sourceText.addEventListener("blur", () => autoTranslate());
      sourceText.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          translateText(true);
        }
      });
      fromLang.addEventListener("change", () => {
        if (!sourceText.value.trim()) return;
        immediateRetranslate();
      });
      toLang.addEventListener("change", () => {
        if (!sourceText.value.trim()) return;
        immediateRetranslate();
      });
      historyList.addEventListener("click", (e) => {
        const del = e.target.closest("[data-action='delete']");
        if (del) {
          e.stopPropagation();
          deleteHistoryItem(del.getAttribute("data-id"));
          return;
        }
        const item = e.target.closest(".item");
        if (item) loadHistory(item.getAttribute("data-id"));
      });
      window.addEventListener("resize", () => {
        autoGrowTextarea();
        syncPanelHeights();
      });
    }
    function sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
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
      sourceText.style.height = sourceText.scrollHeight + "px";
    }
    function syncPanelHeights() {
      sourceText.style.minHeight = "140px";
      result.style.minHeight = "140px";
      const leftH = Math.max(sourceText.scrollHeight, 140);
      const rightH = Math.max(result.scrollHeight, 140);
      const target = Math.max(leftH, rightH);
      sourceText.style.height = target + "px";
      result.style.minHeight = target + "px";
    }
    async function checkSession() {
      if (!TURNSTILE_ENABLED) {
        verified = true;
        gate.classList.add("hidden");
        app.classList.remove("hidden");
        statusInfo.innerText = "认证已关闭，可以开始翻译";
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
          statusInfo.innerText = "会话有效，可以开始翻译";
          requestAnimationFrame(syncPanelHeights);
        } else {
          gate.classList.remove("hidden");
          app.classList.add("hidden");
        }
      } catch {
        gate.classList.remove("hidden");
        app.classList.add("hidden");
      }
    }
    async function onTurnstileSuccess(token) {
      gateTip.innerText = "验证成功，正在进入...";
      try {
        const r = await fetch("/api/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ turnstileToken: token }),
        });
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.error || "验证失败");
        verified = true;
        gate.classList.add("hidden");
        app.classList.remove("hidden");
        statusInfo.innerText = "会话有效，可以开始翻译";
        requestAnimationFrame(syncPanelHeights);
      } catch {
        gateTip.innerText = "验证失败，请重试";
      }
    }
    function onTurnstileExpired() {
      verified = false;
      gateTip.innerText = "验证过期，请重新验证";
    }
    function onTurnstileError() {
      verified = false;
      gateTip.innerText = "验证异常，请刷新重试";
    }
    function onInput() {
      const text = sourceText.value;
      sourceCount.innerText = text.length + " 字";
      autoGrowTextarea();
      if (!text.trim()) {
        clearTimeout(debounceTimer);
        lastSubmittedText = "";
        lastSubmittedFrom = "";
        lastSubmittedTo = "";
        if (currentController) currentController.abort();
        renderEmptyResult();
        resultCount.innerText = "0 字";
        statusInfo.innerText = "会话有效，可以开始翻译";
        syncPanelHeights();
        return;
      }
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => autoTranslate(), 900);
      syncPanelHeights();
    }
    function autoTranslate() {
      const text = sourceText.value.trim();
      if (!verified || !text) return;
      if (
        text === lastSubmittedText &&
        fromLang.value === lastSubmittedFrom &&
        toLang.value === lastSubmittedTo
      ) {
        return;
      }
      translateText(false);
    }
    function swapLanguage() {
      if (fromLang.value === "auto") {
        statusInfo.innerText = "自动检测模式下不能直接切换源语言";
        return;
      }
      const tmp = fromLang.value;
      fromLang.value = toLang.value;
      toLang.value = tmp;
      if (sourceText.value.trim()) {
        immediateRetranslate();
      }
    }
    async function doTranslateRequest(text, signal) {
      const WATCHDOG_MS = 60000;
      let timedOut = false;
      const localAbort = new AbortController();
      const relayAbort = () => { try { localAbort.abort(); } catch {} };
      if (signal) {
        if (signal.aborted) relayAbort();
        else signal.addEventListener("abort", relayAbort, { once: true });
      }
      let watchdog = null;
      const armWatchdog = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => { timedOut = true; relayAbort(); }, WATCHDOG_MS);
      };
      armWatchdog();
      try {
        const res = await fetch("/api/translate/stream", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            text,
            from: fromLang.value,
            to: toLang.value,
          }),
          signal: localAbort.signal,
        });
        if (!res.ok || !res.body) {
          let msg = "服务暂时不可用，请再次尝试";
          try {
            const ct = (res.headers.get("content-type") || "").toLowerCase();
            if (ct.includes("application/json")) {
              const data = await res.json();
              if (data?.error) msg = String(data.error);
            } else {
              const txt = (await res.text()).trim();
              if (txt) msg = txt.slice(0, 300);
            }
          } catch {}
          const fatal = res.status === 400 || res.status === 401 || res.status === 403;
          const err = new Error(msg);
          if (fatal) err.retryable = false;
          throw err;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let finalText = "";
        let receivedAnyData = false;
        let chunkCount = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          armWatchdog();
          const decoded = decoder.decode(value, { stream: true });
          buffer += decoded;
          chunkCount++;
          const blocks = buffer.split("\\n\\n");
          buffer = blocks.pop() || "";
          for (const block of blocks) {
            const evt = parseSSE(block);
            if (!evt) continue;
            receivedAnyData = true;
            armWatchdog();
            if (evt.event === "ping") continue;
            if (evt.event === "start") currentMode = evt.data?.mode || "translate";
            if (evt.event === "reset") {
              finalText = "";
              result.innerHTML = '<div class="result-box result-typing md"></div>';
              resultCount.innerText = "0 字";
              continue;
            }
            if (evt.event === "delta") {
              if (evt.data?.replace) {
                finalText = evt.data.content || finalText;
              } else {
                finalText += evt.data.content || "";
              }
              renderResult(finalText, true);
              resultCount.innerText = finalText.length + " 字";
            }
            if (evt.event === "final") {
              finalText = evt.data.content || finalText;
              renderResult(finalText, false);
              resultCount.innerText = finalText.length + " 字";
            }
            if (evt.event === "done") {
              return finalText;
            }
            if (evt.event === "error") {
              const err = new Error(evt.data?.error || "处理失败，请再次尝试");
              if (evt.data?.retryable === false) err.retryable = false;
              throw err;
            }
          }
        }
        if (buffer.trim()) {
          const evt = parseSSE(buffer);
          if (evt) {
            if (evt.event === "final") finalText = evt.data.content || finalText;
            if (evt.event === "delta") finalText += evt.data.content || "";
          }
        }
        if (!finalText.trim()) {
          if (!receivedAnyData) {
            throw new Error("上游未返回任何数据，请检查 API_MODEL 配置或稍后重试");
          }
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
        statusInfo.innerText = "请先完成验证";
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
      result.innerHTML = '<div class="result-box result-typing md"></div>';
      resultCount.innerText = "0 字";
      requestAnimationFrame(syncPanelHeights);
      let attempt = 0;
      while (attempt < MAX_RETRY) {
        attempt++;
        try {
          statusInfo.innerText =
            attempt === 1
              ? (manual ? "正在处理中..." : "正在自动处理...")
              : ("请求失败，正在重试（" + attempt + "/" + MAX_RETRY + "）...");
          const finalText = await doTranslateRequest(text, currentController.signal);
          statusInfo.innerText = currentMode === "word" ? "词汇解析完成" : "翻译完成";
          saveHistory({
            id: Date.now() + "_" + Math.random().toString(36).slice(2, 8),
            source: text,
            from: fromLang.value,
            to: toLang.value,
            result: finalText,
            mode: currentMode,
            time: new Date().toISOString(),
          });
          return;
        } catch (err) {
          if (err.name === "AbortError") return;
          if (err.retryable === false || attempt >= MAX_RETRY) {
            statusInfo.innerText = err?.message || "处理失败，请再次尝试";
            renderFriendlyError(err?.message);
            return;
          }
          await sleep(700 * attempt);
        }
      }
    }
    function renderResult(text, typing) {
      const html = renderMarkdown(text);
      result.innerHTML =
        '<div class="result-box ' + (typing ? "result-typing " : "") + 'md">' + html + "</div>";
      requestAnimationFrame(syncPanelHeights);
    }
    function renderEmptyResult() {
      result.innerHTML =
        '<div class="empty">' +
        "<i>✦</i>" +
        '<div style="font-weight:700;color:var(--text);margin-bottom:6px">等待翻译内容</div>' +
        "<div>输入句子将翻译；输入单词将给出衍生解释</div>" +
        "</div>";
      requestAnimationFrame(syncPanelHeights);
    }
    function renderFriendlyError(message) {
      result.innerHTML =
        '<div class="empty">' +
        "<i>⚠</i>" +
        '<div style="font-weight:700;color:var(--text);margin-bottom:6px">处理失败</div>' +
        "<div>" + escapeHtml(message || "服务暂时繁忙，请稍后再次尝试") + "</div>" +
        "</div>";
      resultCount.innerText = "0 字";
      requestAnimationFrame(syncPanelHeights);
    }
    function parseSSE(block) {
      const lines = block.split("\\n");
      let event = "message";
      let data = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (!data) return null;
      try {
        return { event, data: JSON.parse(data) };
      } catch {
        return null;
      }
    }
    function renderMarkdown(md) {
      const lines = String(md || "").replace(/\\r\\n?/g, "\\n").split("\\n");
      let out = "";
      let inP = false;
      let inOl = false;
      let inUl = false;
      const closeP = () => { if (inP) { out += "</p>"; inP = false; } };
      const closeOl = () => { if (inOl) { out += "</ol>"; inOl = false; } };
      const closeUl = () => { if (inUl) { out += "</ul>"; inUl = false; } };
      const closeAll = () => { closeP(); closeOl(); closeUl(); };
      const inline = (text) => {
        let s = escapeHtml(text);
        s = s.replace(/\\\`([^\\\`]+)\\\`/g, "<code>$1</code>");
        s = s.replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>");
        s = s.replace(/(^|[\\s(])\\*(?!\\*)([^*]+)\\*(?!\\*)/g, "$1<em>$2</em>");
        return s;
      };
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const line = raw.trim();
        if (!line) {
          closeAll();
          continue;
        }
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
        const ol = line.match(/^\\d+\\.\\s*(.+)$/);
        if (ol) {
          closeP();
          closeUl();
          if (!inOl) { out += "<ol>"; inOl = true; }
          out += "<li>" + inline(ol[1]) + "</li>";
          continue;
        }
        const ul = line.match(/^[-*]\\s*(.+)$/);
        if (ul) {
          closeP();
          closeOl();
          if (!inUl) { out += "<ul>"; inUl = true; }
          out += "<li>" + inline(ul[1]) + "</li>";
          continue;
        }
        closeOl();
        closeUl();
        if (!inP) {
          out += "<p>";
          inP = true;
          out += inline(line);
        } else {
          out += "<br>" + inline(line);
        }
      }
      closeAll();
      return out || "<p></p>";
    }
    function getHistory() {
      try {
        return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      } catch {
        return [];
      }
    }
    function saveHistory(item) {
      const list = getHistory();
      list.unshift(item);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 30)));
      renderHistory();
    }
    function renderHistory() {
      const list = getHistory();
      if (!list.length) {
        historyList.innerHTML = '<div style="color:var(--muted)">暂无历史记录</div>';
        return;
      }
      historyList.innerHTML = list.map(it => (
        '<div class="item" data-id="' + escapeHtml(it.id) + '">' +
          '<p>' + escapeHtml(it.source || "") + '</p>' +
          '<div class="meta"><span>' +
          escapeHtml(it.mode === "word" ? "词汇解析" : (it.from + " → " + it.to)) +
          '</span><span>' + formatTime(it.time) + '</span></div>' +
          '<div style="display:flex;justify-content:flex-end;margin-top:6px">' +
            '<button class="btn" data-action="delete" data-id="' + escapeHtml(it.id) + '">删除</button>' +
          '</div>' +
        '</div>'
      )).join("");
    }
    function loadHistory(id) {
      const item = getHistory().find(x => x.id === id);
      if (!item) return;
      fromLang.value = item.from || "auto";
      toLang.value = item.to || "zh";
      sourceText.value = item.source || "";
      sourceCount.innerText = sourceText.value.length + " 字";
      result.innerHTML = '<div class="result-box md">' + renderMarkdown(item.result || "") + "</div>";
      resultCount.innerText = (item.result || "").length + " 字";
      lastSubmittedText = item.source || "";
      lastSubmittedFrom = item.from || "auto";
      lastSubmittedTo = item.to || "zh";
      closeHistory();
      autoGrowTextarea();
      requestAnimationFrame(syncPanelHeights);
    }
    function deleteHistoryItem(id) {
      const list = getHistory().filter(x => x.id !== id);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
      renderHistory();
    }
    function clearHistory() {
      localStorage.removeItem(HISTORY_KEY);
      renderHistory();
    }
    function openHistory() {
      drawer.classList.add("show");
      mask.classList.add("show");
    }
    function closeHistory() {
      drawer.classList.remove("show");
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
      renderEmptyResult();
      statusInfo.innerText = "会话有效，可以开始翻译";
      autoGrowTextarea();
      requestAnimationFrame(syncPanelHeights);
    }
    async function copyResult() {
      const text = result.innerText.trim();
      if (!text || text.includes("等待翻译内容") || text.includes("处理失败")) return;
      try {
        await navigator.clipboard.writeText(text);
        statusInfo.innerText = "结果已复制";
      } catch {
        statusInfo.innerText = "复制失败，请手动复制";
      }
    }
    function initTheme() {
      const t = localStorage.getItem(THEME_KEY) || "light";
      document.documentElement.setAttribute("data-theme", t);
    }
    function toggleTheme() {
      const c = document.documentElement.getAttribute("data-theme") || "light";
      const n = c === "light" ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", n);
      localStorage.setItem(THEME_KEY, n);
    }
    function formatTime(iso) {
      const d = new Date(iso);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      const h = String(d.getHours()).padStart(2, "0");
      const min = String(d.getMinutes()).padStart(2, "0");
      return y + "-" + m + "-" + day + " " + h + ":" + min;
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
