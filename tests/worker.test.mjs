// ============================================================================
// Cloudflare-AI-Translator 回归测试
//
//   运行： node tests/worker.test.mjs
//
// 纯 Node 实现，无需安装任何依赖，也不会联网。
// worker.js 是单文件 Worker，这里把它复制成 .mjs 后 import，
// 并临时追加 export 语句以测试内部函数（不改动仓库里的源文件）。
// ============================================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_PATH = path.join(ROOT, "worker.js");
const SOURCE = fs.readFileSync(WORKER_PATH, "utf8");

const EXPORTS = [
  "normalizeWordMarkdownOutput",
  "cleanupModelOutput",
  "getWordExplainTemplate",
  "finalizeOutput",
  "emphasisMarkerCount",
  "markdownStructureIntact",
  "repairWordExamplesIfNeeded",
  "buildTranslationPlan",
  "resolveUpstreamConfig",
  "handleTranslateStream",
  "handleApiTranslate",
  "getHtml",
];

const tmpModule = path.join(os.tmpdir(), "cf-translator-test-" + process.pid + ".mjs");
fs.writeFileSync(tmpModule, SOURCE + "\nexport { " + EXPORTS.join(", ") + " };\n");
const worker = (await import(pathToFileURL(tmpModule).href)).default;
const mod = await import(pathToFileURL(tmpModule).href);

let passed = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log("  \u2713 " + name);
  } else {
    failures.push(name + (detail ? "  :: " + detail : ""));
    console.log("  \u2717 " + name + (detail ? "  :: " + detail : ""));
  }
}
function section(title) {
  console.log("\n" + title);
}
function eq(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

const enc = new TextEncoder();

function parseSSEBlock(block) {
  const lines = String(block).split("\n");
  let event = "message";
  let data = "";
  for (const line of lines) {
    if (line.startsWith("event: ")) event = line.slice(7).trim();
    else if (line.startsWith("data: ")) data += line.slice(6);
  }
  if (!data) return null;
  try {
    return { event: event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}

async function collectEvents(res) {
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const evt = parseSSEBlock(buffer.slice(0, idx));
      if (evt) events.push(evt);
      buffer = buffer.slice(idx + 2);
    }
  }
  return events;
}

function cfStreamResponse(payload) {
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(enc.encode("data: " + JSON.stringify(payload) + "\n\ndata: [DONE]\n\n"));
      controller.close();
    },
  });
}

const CF_ENV = (extra) =>
  Object.assign(
    {
      ENABLE_TURNSTILE: "false",
      CF_AI: "true",
      CF_MODEL: "test-model",
      AI: { run: async () => ({ response: "\u4f60\u597d\u4e16\u754c" }) },
    },
    extra || {}
  );

const streamRequest = (body) =>
  new Request("https://translator.test/api/translate/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const apiRequest = (body, headers) =>
  new Request("https://translator.test/api/translate", {
    method: "POST",
    headers: Object.assign({ "content-type": "application/json" }, headers || {}),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/* ========================================================================== */
/* 1. Markdown 完整性 —— 防止后处理再次破坏模型输出的语法                        */
/* ========================================================================== */
section("1. Markdown \u5b8c\u6574\u6027");
{
  const template = mod.getWordExplainTemplate("zh");
  const normalize = (text) => mod.normalizeWordMarkdownOutput(text, template);

  const collocations = [
    "- **be in** (\u5904\u4e8e...\u72b6\u6001; \u5728\u91cc\u9762)",
    "- **be in love** (\u5904\u4e8e\u604b\u7231\u72b6\u6001)",
    "- **in the end** (\u6700\u7ec8)",
  ];
  const draft = [
    "# \u5728 (Z\u00e0i)",
    "",
    "## \u6838\u5fc3\u542b\u4e49",
    "- \u8868\u793a\u52a8\u4f5c\u53d1\u751f\u5728\u5177\u4f53\u65f6\u95f4\u3001\u7a7a\u95f4\u6216\u9886\u57df\u5185\u90e8\u3002",
    "",
    "## \u5e38\u89c1\u642d\u914d",
    collocations[0],
    collocations[1],
    collocations[2],
    "",
    "## \u4f8b\u53e5",
    "- He lives in London. (\u4ed6\u4f4f\u5728\u4f26\u6566\u3002)",
  ].join("\n");

  const normalized = normalize(draft);
  for (const line of collocations) {
    check("\u642d\u914d\u6761\u76ee\u4fdd\u6301\u5b8c\u6574: " + line.slice(2, 16), normalized.includes(line), JSON.stringify(normalized.slice(0, 80)));
  }
  check("\u65e0\u5b64\u7acb\u661f\u53f7\u884c", !/^\* \(/m.test(normalized));
  check("\u884c\u9996\u52a0\u7c97\u4e0d\u4f1a\u53d8\u6210\u5217\u8868\u9879", normalize("**\u91cd\u8981** \u8bf4\u660e") === "**\u91cd\u8981** \u8bf4\u660e");
  check("\u884c\u9996\u659c\u4f53\u4e0d\u4f1a\u88ab\u62c6\u884c\u6216\u52a0\u7a7a\u683c", normalize("*\u659c\u4f53* \u8bf4\u660e") === "*\u659c\u4f53* \u8bf4\u660e");
  check("\u7c98\u8fde\u7684\u5217\u8868\u9879\u4ecd\u80fd\u4fee\u590d", normalize("\u5185\u5bb9- \u9879\u76ee\u4e00\n-\u9879\u76ee\u4e8c") === "\u5185\u5bb9\n- \u9879\u76ee\u4e00\n- \u9879\u76ee\u4e8c");
  check("\u53e0\u4ee3\u5e42\u7b49\uff08\u5df2\u89c4\u8303\u7684\u6587\u672c\u518d\u5904\u7406\u4e0d\u53d8\uff09", normalize(normalize(draft)) === normalized);

  check("\u52a0\u7c97\u8ba1\u6570\u51fd\u6570\u6b63\u786e", mod.emphasisMarkerCount("**a** \u4e0e **b**") === 4 && mod.emphasisMarkerCount("a") === 0);
  check("\u81ea\u68c0\u80fd\u8bc6\u522b\u8bed\u6cd5\u88ab\u7834\u574f", mod.markdownStructureIntact("**a** b", "**a* \n* b") === false);
  check("\u81ea\u68c0\u653e\u884c\u6b63\u5e38\u7684\u7ed3\u6784\u6574\u7406", mod.markdownStructureIntact("**a** b", "- **a** b") === true);

  const finalized = mod.finalizeOutput(draft, { isSingleWord: true, wordTemplate: template, text: "in" });
  check("finalizeOutput \u4e0d\u4e22\u5931\u4efb\u4f55\u52a0\u7c97\u6807\u8bb0", mod.emphasisMarkerCount(finalized) === mod.emphasisMarkerCount(draft));

  const repairCtx = (reply) => ({
    from: "en",
    to: "zh",
    wordTemplate: template,
    useCFAI: true,
    model: "test-model",
    maxTokens: 1024,
    timeoutMs: 3000,
    env: { AI: { run: async () => ({ response: reply }) } },
  });
  const repairDraft = "# \u4f60\u597d\n\n## \u6838\u5fc3\u542b\u4e49\n- \u95ee\u5019\u3002\n## \u4f8b\u53e5\n- Hello, how are you?";
  const broken = await mod.repairWordExamplesIfNeeded(repairDraft, repairCtx("\u5b8c\u5168\u4e0d\u540c\u7684\u5185\u5bb9"));
  check("\u4f8b\u53e5\u4fee\u590d\u6539\u574f\u7ed3\u6784\u65f6\u56de\u9000\u8349\u7a3f", broken === repairDraft.trim());
  const good = await mod.repairWordExamplesIfNeeded(repairDraft, repairCtx("# \u4f60\u597d\n\n## \u6838\u5fc3\u542b\u4e49\n- \u95ee\u5019\u3002\n## \u4f8b\u53e5\n- Hello, how are you? \uff08\u4f60\u597d\uff0c\u4f60\u597d\u5417\uff1f\uff09"));
  check("\u4f8b\u53e5\u4fee\u590d\u6b63\u5e38\u65f6\u4ecd\u7136\u751f\u6548", good.includes("\uff08\u4f60\u597d\uff0c\u4f60\u597d\u5417\uff1f\uff09"));
}

/* ========================================================================== */
/* 2. 高度同步（模拟元素 + 模拟浏览器夹回滚动位置）                              */
/* ========================================================================== */
section("2. \u5de6\u53f3\u680f\u9ad8\u5ea6\u540c\u6b65");
{
  const parsePx = (v) => {
    const m = /^(\d+(?:\.\d+)?)px$/.exec(String(v || ""));
    return m ? parseFloat(m[1]) : 0;
  };
  const clampState = { y: 700, docHeight: 3100, clamps: 0 };
  const settle = () => {
    const maxY = Math.max(0, clampState.docHeight - 800);
    if (clampState.y > maxY) {
      clampState.y = maxY;
      clampState.clamps++;
    }
  };
  const fakeWindow = {
    innerWidth: 1400,
    matchMedia: () => ({ matches: stackedMode }),
    get pageYOffset() {
      return clampState.y;
    },
    scrollTo: (x, y) => {
      clampState.y = y;
    },
  };
  const fakeDocument = { documentElement: { get scrollTop() { return clampState.y; } } };
  let stackedMode = false;
  const makeEl = (contentH) => {
    const el = { contentH: contentH, style: {} };
    Object.defineProperty(el, "scrollHeight", {
      get() {
        const lh = parsePx(left.style.height) || 0;
        const rh = parsePx(right.style.minHeight) || 0;
        clampState.docHeight = 100 + Math.max(lh, rh, 220);
        settle();
        return Math.max(el.contentH, parsePx(el.style.height), parsePx(el.style.minHeight));
      },
    });
    return el;
  };
  const left = makeEl(0);
  const right = makeEl(0);

  const code =
    "const STACKED_QUERY = '(max-width: 960px)';" +
    "const MIN_PANE_BODY = 220;" +
    "const MIN_PANE_BODY_STACKED = 170;" +
    "let isStreaming = false;" +
    "let lastPaneHeight = 0;" +
    extractFn(extractClientScript(await mod.getHtml("", false)), "isStackedLayout") +
    extractFn(extractClientScript(await mod.getHtml("", false)), "paneBodyFloor") +
    extractFn(extractClientScript(await mod.getHtml("", false)), "autoGrowTextarea") +
    extractFn(extractClientScript(await mod.getHtml("", false)), "syncPanelHeights");
  const api = new Function(
    "sourceText",
    "result",
    "window",
    "document",
    code + "\nreturn { sync: syncPanelHeights, streaming: function (v) { isStreaming = v; } };"
  )(left, right, fakeWindow, fakeDocument);

  api.sync();
  check("\u7a7a\u767d\u65f6\u4e24\u4fa7\u9ed8\u8ba4\u9ad8\u5ea6\u4e00\u81f4\uff08220px\uff09", parsePx(left.style.height) === 220 && parsePx(right.style.minHeight) === 220);

  left.contentH = 3000;
  api.sync();
  check("\u5de6\u4fa7\u957f\u6587\u65f6\u4e24\u4fa7\u540c\u6b65\u53d8\u9ad8", parsePx(left.style.height) === 3000 && parsePx(right.style.minHeight) === 3000);

  left.contentH = 100;
  right.contentH = 900;
  api.sync();
  check("\u53f3\u4fa7\u8f83\u957f\u65f6\u5411\u53f3\u4fa7\u5bf9\u9f50", parsePx(left.style.height) === 900 && parsePx(right.style.minHeight) === 900);

  left.contentH = 10;
  right.contentH = 10;
  api.sync();
  check("\u5185\u5bb9\u53d8\u77ed\u540e\u80fd\u56de\u843d\u5230\u9ed8\u8ba4\u9ad8\u5ea6", parsePx(left.style.height) === 220 && parsePx(right.style.minHeight) === 220);

  left.contentH = 2500;
  right.contentH = 2500;
  api.streaming(true);
  api.sync();
  clampState.y = 700;
  const clampsBefore = clampState.clamps;
  for (let i = 0; i < 5; i++) {
    right.contentH = 2500 + i * 120;
    api.sync();
  }
  check("\u6d41\u5f0f\u8f93\u51fa\u671f\u95f4\u6eda\u52a8\u4f4d\u7f6e\u4e0d\u88ab\u62c9\u56de", clampState.y === 700, "y=" + clampState.y);
  check("\uff08\u6d4b\u8bd5\u6709\u6548\u6027\uff09\u5185\u90e8\u786e\u5b9e\u53d1\u751f\u8fc7\u5939\u56de", clampState.clamps > clampsBefore);

  right.contentH = 800;
  api.sync();
  check("\u6d41\u5f0f\u4e2d\u9014\u4e0d\u4f1a\u7f29\u77ed\uff08\u907f\u514d\u53cd\u590d\u6296\u52a8\uff09", parsePx(left.style.height) === 2500 + 4 * 120);
  api.streaming(false);
  right.contentH = 800;
  api.sync();
  check("\u6d41\u5f0f\u7ed3\u675f\u540e\u53ef\u6b63\u5e38\u6536\u7f29", parsePx(left.style.height) === 2500);

  stackedMode = true;
  left.contentH = 2600;
  right.contentH = 200;
  api.sync();
  check("\u624b\u673a\u5806\u53e0\u65f6\u5404\u81ea\u72ec\u7acb\u9ad8\u5ea6", parsePx(left.style.height) === 2600 && right.style.minHeight === "");
}

/* ========================================================================== */
/* 3. 开放 API                                                                */
/* ========================================================================== */
section("3. \u5f00\u653e API");
{
  const disabled = await worker.fetch(apiRequest({ text: "hello", to: "zh" }), CF_ENV());
  check("\u672a\u914d\u7f6e API_KEYS \u65f6\u63a5\u53e3\u5173\u95ed\uff08403\uff09", disabled.status === 403);

  const env = CF_ENV({ API_KEYS: "sk-one, sk-two" });
  const noKey = await worker.fetch(apiRequest({ text: "hello", to: "zh" }), env);
  const badKey = await worker.fetch(apiRequest({ text: "hello", to: "zh" }, { Authorization: "Bearer nope" }), env);
  check("\u7f3a\u5c11\u5bc6\u94a5\u8fd4\u56de 401", noKey.status === 401);
  check("\u9519\u8bef\u5bc6\u94a5\u8fd4\u56de 401", badKey.status === 401);

  const okBearer = await worker.fetch(apiRequest({ text: "Hello world, this is a test.", to: "zh" }, { Authorization: "Bearer sk-one" }), env);
  const okHeader = await worker.fetch(apiRequest({ text: "Hello world, this is a test.", to: "zh" }, { "X-API-Key": "sk-two" }), env);
  const bearerBody = await okBearer.json();
  check("Authorization Bearer \u53ef\u7528", okBearer.status === 200 && bearerBody.result === "\u4f60\u597d\u4e16\u754c");
  check("X-API-Key \u53ef\u7528\uff08\u591a\u5bc6\u94a5\uff09", okHeader.status === 200);

  const sameLang = await worker.fetch(apiRequest({ text: "\u4f60\u597d\u4e16\u754c", from: "zh", to: "zh" }, { Authorization: "Bearer sk-one" }), env);
  const sameBody = await sameLang.json();
  check("\u540c\u8bed\u8a00\u76f4\u63a5\u8fd4\u56de\u539f\u6587", sameBody.result === "\u4f60\u597d\u4e16\u754c" && sameBody.unchanged === true);

  const empty = await worker.fetch(apiRequest({ text: "  " }, { Authorization: "Bearer sk-one" }), env);
  const badJson = await worker.fetch(apiRequest("not json", { Authorization: "Bearer sk-one" }), env);
  check("\u7a7a\u6587\u672c\u8fd4\u56de 400", empty.status === 400);
  check("\u975e\u6cd5 JSON \u8fd4\u56de 400", badJson.status === 400);
}

/* ========================================================================== */
/* 4. 流式请求健壮性                                                          */
/* ========================================================================== */
section("4. \u6d41\u5f0f\u8bf7\u6c42");
{
  const seen = [];
  const env = CF_ENV({
    AI: {
      run: async (model, inputs) => {
        seen.push(inputs);
        return cfStreamResponse({ response: "\u4f60\u597d\u4e16\u754c" });
      },
    },
  });
  const res = await worker.fetch(streamRequest({ text: "Hello world, this is a test.", to: "zh" }), env);
  const events = await collectEvents(res);
  const final = events.find((e) => e.event === "final");
  check("\u6b63\u5e38\u6d41\u5f0f\uff1a\u8fd4\u56de final", final && final.data.content === "\u4f60\u597d\u4e16\u754c");
  check("\u6b63\u5e38\u6d41\u5f0f\uff1astart \u2192 final \u2192 done", events[0].event === "start" && events[events.length - 1].event === "done");
  check("Workers AI \u5165\u53c2\u5e26 max_tokens", seen[0] && seen[0].max_tokens === 8192);

  // 上游卡死：必须有界报错，不能挂住
  let calls = 0;
  const stallEnv = CF_ENV({
    UPSTREAM_IDLE_TIMEOUT_MS: "300",
    UPSTREAM_MAX_ATTEMPTS: "2",
    SSE_HEARTBEAT_MS: "1000",
    AI: {
      run: async () => {
        calls++;
        return new ReadableStream({ start() {} });
      },
    },
  });
  const started = Date.now();
  const stallRes = await worker.fetch(streamRequest({ text: "Hello world, this is a test.", to: "zh" }), stallEnv);
  const stallEvents = await collectEvents(stallRes);
  const elapsed = Date.now() - started;
  check("\u4e0a\u6e38\u5361\u6b7b\u65f6\u6709\u754c\u62a5\u9519", !!stallEvents.find((e) => e.event === "error") && elapsed < 4000, "elapsed=" + elapsed);
  check("\u4e0a\u6e38\u5361\u6b7b\u65f6\u6309\u914d\u7f6e\u91cd\u8bd5", calls === 2, "calls=" + calls);
  check("\u9519\u8bef\u6807\u8bb0\u4e3a\u4e0d\u53ef\u91cd\u8bd5", stallEvents.find((e) => e.event === "error").data.retryable === false);

  // 上游返回空内容 -> 触发重试并带 reset
  let emptyCalls = 0;
  const retryEnv = CF_ENV({
    UPSTREAM_MAX_ATTEMPTS: "2",
    UPSTREAM_IDLE_TIMEOUT_MS: "400",
    AI: {
      run: async () => {
        emptyCalls++;
        if (emptyCalls === 1) return new ReadableStream({ start() {} });
        return cfStreamResponse({ response: "\u5b8c\u6574\u7ed3\u679c" });
      },
    },
  });
  const retryRes = await worker.fetch(streamRequest({ text: "Hello world, this is a test.", to: "zh" }), retryEnv);
  const retryEvents = await collectEvents(retryRes);
  check("\u91cd\u8bd5\u65f6\u53d1\u9001 reset \u4e8b\u4ef6", !!retryEvents.find((e) => e.event === "reset"));
  check("\u91cd\u8bd5\u540e\u8fd4\u56de\u6b63\u786e\u7ed3\u679c", (retryEvents.find((e) => e.event === "final") || {}).data.content === "\u5b8c\u6574\u7ed3\u679c");
}

/* ========================================================================== */
/* 5. 前端页面结构                                                            */
/* ========================================================================== */
section("5. \u524d\u7aef\u9875\u9762");
{
  const html = await mod.getHtml("0xSITEKEY", true);
  const htmlNoTurnstile = await mod.getHtml("", false);
  const clientJs = extractClientScript(htmlNoTurnstile);

  fs.writeFileSync(path.join(os.tmpdir(), "cf-translator-client.js"), clientJs);
  let syntaxOk = true;
  let syntaxErr = "";
  try {
    execFileSync(process.execPath, ["--check", path.join(os.tmpdir(), "cf-translator-client.js")], { stdio: "pipe" });
  } catch (e) {
    syntaxOk = false;
    syntaxErr = String(e.stderr || e.message).slice(0, 200);
  }
  check("\u5185\u8054\u811a\u672c\u8bed\u6cd5\u6b63\u786e", syntaxOk, syntaxErr);
  check("\u6a21\u677f\u5b57\u7b26\u4e32\u65e0\u6b8b\u7559\u63d2\u503c", !htmlNoTurnstile.includes("${"));

  const ids = Array.from(new Set((clientJs.match(/byId\("([^"]+)"\)/g) || []).map((m) => m.replace(/byId\("|"\)/g, ""))));
  const missing = ids.filter((id) => !htmlNoTurnstile.includes('id="' + id + '"'));
  check("\u6240\u6709 byId \u5f15\u7528\u7684\u5143\u7d20\u90fd\u5b58\u5728", missing.length === 0, "missing=" + missing.join(","));

  check("Turnstile sitekey \u6b63\u786e\u6ce8\u5165", html.includes('data-sitekey="0xSITEKEY"'));
  check("\u672a\u542f\u7528 Turnstile \u65f6\u4e0d\u52a0\u8f7d\u7b2c\u4e09\u65b9\u811a\u672c", !htmlNoTurnstile.includes("challenges.cloudflare.com"));

  check("\u4e0d\u5b58\u5728\u76f4\u89d2\u7126\u70b9\u6846\uff08\u65e0 outline \u975e none\uff09", !/outline:\s*[^n]/.test(htmlNoTurnstile.replace(/outline:none/g, "")));
  check("\u7126\u70b9\u73af\u4f7f\u7528 box-shadow", /\.btn:focus-visible\{[^}]*box-shadow/.test(htmlNoTurnstile));
  check("\u79fb\u52a8\u7aef\u70b9\u51fb\u9ad8\u4eae\u5df2\u5173\u95ed", htmlNoTurnstile.includes("-webkit-tap-highlight-color:transparent"));
  check("\u8f93\u5165\u6846\u9ed8\u8ba4\u9ad8\u5ea6 220px", /\.editor\{[^}]*min-height:220px/.test(htmlNoTurnstile) && /\.result\{[^}]*min-height:220px/.test(htmlNoTurnstile));
  check("\u8f93\u5165\u6846\u4e0d\u518d\u4f7f\u7528 flex:1", /\.editor\{[^}]*flex:none/.test(htmlNoTurnstile));
  check("\u81ea\u7ed8\u4e0b\u62c9\u6846\u5df2\u5c31\u4f4d", /class="dd" data-dd=/.test(htmlNoTurnstile) && /id="fromLang" class="native-select"/.test(htmlNoTurnstile));
  check("\u624b\u673a\u7aef\u5e03\u5c40\u5b58\u5728", htmlNoTurnstile.includes("max-width:620px") && htmlNoTurnstile.includes('id="goBtnMobile"'));
}

/* ========================================================================== */
/* 工具                                                                        */
/* ========================================================================== */
function extractClientScript(html) {
  const m = String(html).match(/<script>([\s\S]*?)<\/script>/);
  return m ? m[1] : "";
}
function extractFn(source, name) {
  const start = source.indexOf("function " + name + "(");
  if (start === -1) return "";
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return "";
}

/* ========================================================================== */
console.log("\n" + "-".repeat(60));
if (failures.length) {
  console.log("\u5931\u8d25 " + failures.length + " \u9879\uff1a");
  for (const f of failures) console.log("  - " + f);
  console.log(passed + " \u9879\u901a\u8fc7\uff0c" + failures.length + " \u9879\u5931\u8d25");
  fs.unlinkSync(tmpModule);
  process.exit(1);
}
console.log("\u5168\u90e8 " + passed + " \u9879\u68c0\u67e5\u901a\u8fc7");
fs.unlinkSync(tmpModule);
