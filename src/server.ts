/**
 * UJN (济南大学) DeepSeek WebAPI —— OpenAI 兼容 API 服务端（Express + TS）。
 *
 * TypeScript 异步移植自 main.py：
 *   - GET  /v1/models        模型列表 + 能力广告（含动态窗口缓存）
 *   - POST /v1/chat/completions  直通 UJN 后端（流式/非流式 + 上下文治理 + SSE 重写）
 *
 * 启动：node src/server.ts  （首次请求前需登录 UJN 统一认证）
* 感谢 github@furtz12 github@szw0407 github@zeroHYH 这三位的数据和灵感提供 
 * 这三位的仓库在https://github.com/futz12/SDU_DeepSeek
 * 本仓库代码经由这个仓库的启发经过vibe coding而来
 */

import express, { type Request, type Response, type NextFunction } from "express";
import * as fs from "node:fs";

import { defaultWrap, AuthRequiredError, type UJNWrap } from "./wrap.ts";
import {
  anthropicToOpenAI,
  openAIToAnthropicNonstream,
  openAISseToAnthropicStream,
  anthropicError,
} from "./anthropic.ts";
import { NATIVE_ANTHROPIC, ANTHROPIC_MESSAGES_PATH } from "./config.ts";

// ---- 命令行参数（优先于环境变量）----
/**
 * 轻量解析启动参数，支持：
 *   -u / --username / --user <账号>
 *   -p / --password / --pass <密码>
 *   --host <地址>  --port <端口>
 *   [账号] [密码] 位置参数形式（例如经 npm start 透传时，-u/-p 会被 npm 吞掉）
 */
function parseArgs(argv: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  const positional: string[] = [];
  const val = (i: number): string | undefined => argv[i + 1];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-u":
      case "--username":
      case "--user":
        out.username = val(i);
        i++;
        break;
      case "-p":
      case "--password":
      case "--pass":
        out.password = val(i);
        i++;
        break;
      case "--host":
      case "-h":
        out.host = val(i);
        i++;
        break;
      case "--port":
        out.port = val(i);
        i++;
        break;
      default:
        // 非选项 token → 收集为位置参数（跳过裸短横线）
        if (!(a.startsWith("-") && a !== "-")) positional.push(a);
    }
  }
  // 位置参数依次当作 账号 / 密码（仅当对应标记形式未提供时）
  if (!out.username && positional.length > 0) {
    out.username = positional[0];
  }
  if (!out.password && positional.length > 1) {
    out.password = positional[1];
  }
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));

// ---- 环境配置 ----
const HOST = ARGS.host ?? process.env.UJN_API_HOST ?? "0.0.0.0";
const PORT = Number(ARGS.port ?? process.env.UJN_API_PORT ?? "8000");

// 登录凭据（必需，来自命令行参数，兼容环境变量）
const UJN_USERNAME = ARGS.username ?? process.env.UJN_USERNAME;
const UJN_PASSWORD = ARGS.password ?? process.env.UJN_PASSWORD;

// ---- 上下文治理配置（UJN 后端 vLLM：prompt + 输出 <= max_model_len）----
const OUTPUT_TOKEN_CAP = Number(process.env.UJN_OUTPUT_TOKEN_CAP ?? "32768");
const OUTPUT_RATIO = Number(process.env.UJN_OUTPUT_RATIO ?? "0.125");
const OUTPUT_MIN_CAP = Number(process.env.UJN_OUTPUT_MIN_CAP ?? "4096");
const CLAMP_MAX_TOKENS = (process.env.UJN_CLAMP_MAX_TOKENS ?? "1") === "1";
const AUTO_TRIM_HISTORY = (process.env.UJN_AUTO_TRIM_HISTORY ?? "1") === "1";
const SAFETY_MARGIN = Number(process.env.UJN_SAFETY_MARGIN ?? "1024");

// ---- 兜底模型表（后端 /api/models 不可用时）----
const FALLBACK_MODELS: { id: string; owned_by: string }[] = [
  { id: "deepseek-v4-flash", owned_by: "deepseek" },
  { id: "1.Qwen3.5-27B", owned_by: "Qwen" },
  { id: "Qwen3.8-27B", owned_by: "Qwen" },
  { id: "Qwen3.6-27B", owned_by: "Qwen" },
  { id: "/models/GLM-5___2-NVFP4", owned_by: "Zhipu" },
];

// ---- 每个模型实测支持的思考能力、推理档位与容量（兜底）----
interface ModelReasoning {
  capable: boolean;
  efforts: string[];
  default_effort: string;
  context_window?: number;
}

const MODEL_REASONING: Record<string, ModelReasoning> = {
  "deepseek-v4-flash": {
    capable: true,
    efforts: ["none", "low", "medium", "high", "xhigh"],
    default_effort: "medium",
    context_window: 1048576,
  },
  "1.Qwen3.5-27B": {
    capable: true,
    efforts: ["none", "low", "medium", "high"],
    default_effort: "medium",
    context_window: 262144,
  },
  "Qwen3.6-27B": {
    capable: true,
    efforts: ["low", "medium", "high"],
    default_effort: "medium",
    context_window: 262144,
  },
  "Qwen3.8-27B": {
    capable: true,
    efforts: ["low", "medium"],
    default_effort: "medium",
    context_window: 262144,
  },
  "/models/GLM-5___2-NVFP4": {
    capable: true,
    efforts: ["none", "low", "medium", "high", "xhigh"],
    default_effort: "medium",
    context_window: 131072,
  },
};

// ---- 动态模型能力缓存（跟随后端 /api/models，免维护本地表）----
let MODEL_CTX_CACHE: Record<string, number> = {};

function refreshModelCache(models: unknown[] | null | undefined): void {
  if (models === null || models === undefined) return;
  if (!Array.isArray(models)) return;
  const fresh: Record<string, number> = {};
  for (const m of models) {
    if (typeof m !== "object" || m === null) continue;
    const mm = m as Record<string, unknown>;
    if (!mm.id) continue;
    let mml = mm.max_model_len;
    if (mml === undefined && typeof mm.openai === "object" && mm.openai !== null) {
      mml = (mm.openai as Record<string, unknown>).max_model_len;
    }
    if (typeof mml === "number" && mml > 0) fresh[String(mm.id)] = mml;
  }
  if (Object.keys(fresh).length > 0) MODEL_CTX_CACHE = fresh; // 整体替换，防残留
}

/** 按模型上下文窗口计算单次输出上限。 */
function outputCapFor(context: number | null | undefined): number {
  if (typeof context !== "number" || context <= 0) return OUTPUT_TOKEN_CAP;
  const byRatio = Math.floor(context * OUTPUT_RATIO);
  return Math.max(OUTPUT_MIN_CAP, Math.min(byRatio, OUTPUT_TOKEN_CAP));
}

/** 粗略估算一段文本的 token 数（CJK 0.7 token/字、其他 0.28 token/字符 + 4 开销）。 */
function estTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk += 1;
    }
  }
  return Math.floor(cjk * 0.7 + (text.length - cjk) * 0.28) + 4;
}

/** 估算请求 messages 的总 token 数。 */
function payloadPromptTokens(payload: Record<string, unknown>): number {
  let total = 0;
  const messages = payload.messages;
  if (!Array.isArray(messages)) return 0;
  for (const m of messages) {
    if (typeof m !== "object" || m === null) continue;
    const mm = m as Record<string, unknown>;
    const content = mm.content;
    if (typeof content === "string") {
      total += estTokens(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part !== "object" || part === null) continue;
        const pp = part as Record<string, unknown>;
        const text = typeof pp.text === "string" ? pp.text : typeof pp.content === "string" ? pp.content : "";
        if (text) total += estTokens(text);
      }
    }
  }
  return total;
}

/** 返回该模型的上下文窗口：动态缓存优先，本地兜底表次之。 */
function contextWindowFor(modelId: string | undefined): number | null {
  if (!modelId) return null;
  const cached = MODEL_CTX_CACHE[modelId];
  if (typeof cached === "number" && cached > 0) return cached;
  const info = MODEL_REASONING[modelId];
  if (info && typeof info.context_window === "number") return info.context_window;
  return null;
}

/** 裁剪最旧的历史消息直到估算 prompt <= budget_prompt（保留 system 与最近轮次）。 */
function trimHistory(payload: Record<string, unknown>, budgetPrompt: number): number {
  const messages = payload.messages;
  if (!Array.isArray(messages) || messages.length <= 1) return 0;

  const systems = messages.filter((m) => typeof m === "object" && m !== null && (m as Record<string, unknown>).role === "system");
  const rest = messages.filter((m) => typeof m === "object" && m !== null && (m as Record<string, unknown>).role !== "system");

  // 定位 rest 里最后一条 user 的索引
  let lastUserIdx = -1;
  for (let i = 0; i < rest.length; i++) {
    if ((rest[i] as Record<string, unknown>).role === "user") lastUserIdx = i;
  }
  if (lastUserIdx < 0) return 0;

  const tokensOf = (suffixRest: unknown[]): number =>
    payloadPromptTokens({ messages: [...systems, ...suffixRest] });

  // 最少保留（最后 user 及其后）都放不下 => 单条消息过大，无法裁剪
  if (tokensOf(rest.slice(lastUserIdx)) > budgetPrompt) return 0;

  let keepFrom = lastUserIdx;
  for (let i = lastUserIdx - 1; i >= 0; i--) {
    if ((rest[i] as Record<string, unknown>).role === "user") {
      if (tokensOf(rest.slice(i)) <= budgetPrompt) {
        keepFrom = i; // 还能再多保留一轮
      } else {
        break;
      }
    }
  }

  payload.messages = [...systems, ...rest.slice(keepFrom)];
  return keepFrom;
}

interface ManageRecord {
  clamped?: [number, number];
  trimmed?: number;
  prompt_before?: number;
  prompt_after?: number;
}

/** 转发前的上下文治理（就地修改 payload）。 */
function manageContext(payload: Record<string, unknown>): ManageRecord {
  const ctx = contextWindowFor(typeof payload.model === "string" ? payload.model : undefined);
  if (ctx === null) return {};

  // 预算：prompt 最多占 ctx - SAFETY_MARGIN - max_tokens
  const rawMax = payload.max_tokens;
  const hasMax = typeof rawMax === "number" && rawMax > 0;
  const modelCap = outputCapFor(ctx);
  const reqMax = hasMax ? (rawMax as number) : modelCap;
  let maxPromptBudget = ctx - SAFETY_MARGIN - Math.min(reqMax, modelCap);
  if (maxPromptBudget <= 0) maxPromptBudget = ctx - SAFETY_MARGIN - 1;

  const record: ManageRecord = {};
  const promptTokens = payloadPromptTokens(payload);

  // 1) clamp 过大 max_tokens（仅客户端显式指定时）
  if (CLAMP_MAX_TOKENS && hasMax) {
    const avail = ctx - promptTokens - SAFETY_MARGIN;
    if (avail < reqMax) {
      const newMax = Math.max(1, avail);
      if (newMax !== reqMax) {
        payload.max_tokens = newMax;
        record.clamped = [reqMax, newMax];
      }
    }
  }

  // 2) prompt 超预算 => 裁剪最旧历史
  if (AUTO_TRIM_HISTORY && promptTokens > maxPromptBudget) {
    const n = trimHistory(payload, maxPromptBudget);
    if (n > 0) {
      record.trimmed = n;
      record.prompt_before = promptTokens;
      record.prompt_after = payloadPromptTokens(payload);
    }
  }
  return record;
}

/** 返回一个模型的完整能力描述（思考、档位、容量）。 */
function modelCapability(modelId: string, upstream: Record<string, unknown> | undefined): Record<string, unknown> {
  const info = MODEL_REASONING[modelId] ?? { capable: false, efforts: [] as string[] };
  // vLLM 后端在模型对象里带 max_model_len；优先 upstream，其次动态缓存，最后本地兜底表
  let mml: unknown = undefined;
  if (upstream) {
    mml = upstream.max_model_len;
    if (mml === undefined && typeof upstream.openai === "object" && upstream.openai !== null) {
      mml = (upstream.openai as Record<string, unknown>).max_model_len;
    }
  }
  if (typeof mml !== "number" || mml <= 0) mml = MODEL_CTX_CACHE[modelId];
  const context = typeof mml === "number" && mml > 0 ? mml : info.context_window;
  const outputCap = outputCapFor(typeof context === "number" ? context : null);
  return {
    capabilities: { reasoning: info.capable },
    reasoning_efforts: [...info.efforts],
    default_reasoning_effort: info.default_effort,
    context_window: context,
    context_length: context,
    max_output_tokens: outputCap,
    max_tokens: outputCap,
  };
}

/** 思考开关归一化：thinking 布尔/对象 -> reasoning_effort（就地修改）。 */
function normalizeThinking(payload: Record<string, unknown>): void {
  if (payload.reasoning_effort !== undefined && payload.reasoning_effort !== null) return;
  const thinking = payload.thinking;
  if (typeof thinking === "object" && thinking !== null) {
    const t = thinking as Record<string, unknown>;
    const ttype = t.type;
    if (ttype === "disabled" || ttype === false) payload.reasoning_effort = "none";
    else if (ttype === "enabled" || ttype === "auto" || ttype === true) payload.reasoning_effort = "high";
    delete payload.thinking;
  } else if (thinking === false) {
    payload.reasoning_effort = "none";
    delete payload.thinking;
  } else if (thinking === true) {
    payload.reasoning_effort = "high";
    delete payload.thinking;
  }
}

/** 非流式响应：把 message.reasoning 双写为 reasoning_content（若有）。 */
function rewriteNonstreamBody(body: Record<string, unknown>): void {
  const choices = body.choices;
  if (!Array.isArray(choices)) return;
  for (const ch of choices) {
    if (typeof ch !== "object" || ch === null) continue;
    const msg = (ch as Record<string, unknown>).message;
    if (typeof msg !== "object" || msg === null) continue;
    const reasoning = (msg as Record<string, unknown>).reasoning;
    if (typeof reasoning === "string" && reasoning && !("reasoning_content" in (msg as Record<string, unknown>))) {
      (msg as Record<string, unknown>).reasoning_content = reasoning;
    }
  }
}

/** 流式响应：把每个 SSE data 帧中 delta.reasoning 双写为 delta.reasoning_content。 */
function rewriteSseFrame(frame: string): string {
  const outLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("data: ")) {
      const data = line.slice(6).trim();
      if (data && data !== "[DONE]") {
        try {
          const obj = JSON.parse(data);
          const choices = obj.choices;
          if (Array.isArray(choices)) {
            for (const ch of choices) {
              if (typeof ch !== "object" || ch === null) continue;
              const delta = (ch as Record<string, unknown>).delta;
              if (typeof delta === "object" && delta !== null) {
                const reasoning = (delta as Record<string, unknown>).reasoning;
                if (typeof reasoning === "string" && reasoning && !("reasoning_content" in (delta as Record<string, unknown>))) {
                  (delta as Record<string, unknown>).reasoning_content = reasoning;
                }
              }
            }
          }
          outLines.push("data: " + JSON.stringify(obj));
        } catch {
          outLines.push(line); // 非 JSON 帧原样透传
        }
      } else {
        outLines.push(line);
      }
    } else {
      outLines.push(line);
    }
  }
  return outLines.join("\n") + "\n\n";
}

// ---------- Express 应用 ----------

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/** 把 UJN 认证/网络错误统一转换为 HTTP 错误。 */
async function ensureAuthed(wrap: UJNWrap): Promise<void> {
  if (wrap.jar && wrap.authenticated) return;
  const exists = await fs.promises
    .access(wrap.cookiesFile)
    .then(() => true)
    .catch(() => false);
  if (exists) {
    const ok = await wrap.loadCookies();
    if (ok) return;
  }
  throw new Error("UJN WebVPN 会话未认证，请先运行 npm run cli 登录");
}

app.get("/v1/models", async (_req: Request, res: Response) => {
  try {
    await ensureAuthed(defaultWrap);
    const data = await defaultWrap.listModels();
    const models = Array.isArray(data?.data) ? (data.data as Record<string, unknown>[]) : null;
    refreshModelCache(models);
    const upstreamById = new Map<string, Record<string, unknown>>();
    if (models) {
      for (const m of models) {
        if (m && typeof m.id === "string") upstreamById.set(m.id, m);
      }
    }
    const list = models && models.length > 0 ? models : FALLBACK_MODELS;
    const now = Math.floor(Date.now() / 1000);
    const out = list.map((m) => {
      const mid = String(m.id);
      const entry: Record<string, unknown> = {
        id: mid,
        object: "model",
        created: now,
        owned_by: m.owned_by ?? "ujn",
      };
      Object.assign(entry, modelCapability(mid, upstreamById.get(mid)));
      return entry;
    });
    res.json({ object: "list", data: out });
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: { message: e.message, type: "upstream_error" } });
  }
});

app.post("/v1/chat/completions", async (req: Request, res: Response) => {
  let payload: Record<string, unknown>;
  try {
    payload = req.body as Record<string, unknown>;
    if (typeof payload !== "object" || payload === null) throw new Error("body must be JSON object");
  } catch {
    res.status(400).json({ error: { message: "请求体必须是 JSON", type: "invalid_request" } });
    return;
  }

  const stream = Boolean(payload.stream);

  // 思考开关归一化
  normalizeThinking(payload);

  // 上下文治理
  const ctx = manageContext(payload);
  if (ctx.clamped) {
    console.log(`[ctx] max_tokens ${ctx.clamped[0]} -> ${ctx.clamped[1]}（超出上下文预算）`);
  }
  if (ctx.trimmed) {
    console.log(`[ctx] 裁剪 ${ctx.trimmed} 条旧消息：prompt ${ctx.prompt_before} -> ${ctx.prompt_after} tokens`);
  }

  try {
    await ensureAuthed(defaultWrap);
    const upstream = await defaultWrap.chatCompletion(payload);

    if (stream) {
      res.status(upstream.status);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      const reader = upstream.body?.getReader();
      if (!reader) {
        res.end();
        return;
      }
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, idx + 2);
            buffer = buffer.slice(idx + 2);
            res.write(rewriteSseFrame(frame));
          }
        }
        buffer += decoder.decode();
        if (buffer) res.write(rewriteSseFrame(buffer));
      } finally {
        reader.releaseLock();
      }
      res.end();
      return;
    }

    // 非流式
    const text = await upstream.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: { message: text.slice(0, 300), type: "upstream_error" } };
    }
    if (typeof body === "object" && body !== null) {
      rewriteNonstreamBody(body as Record<string, unknown>);
    }
    res.status(upstream.status).json(body);
  } catch (e: any) {
    const status = e.status ?? (e instanceof AuthRequiredError ? 401 : 502);
    res.status(status).json({ error: { message: e.message, type: status === 401 ? "auth_error" : "upstream_error" } });
  }
});

/** 把上游 ReadableStream 原样泵给响应（原生 Anthropic 直通用）。 */
async function pumpStream(stream: ReadableStream<Uint8Array>, res: Response): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Anthropic Messages API 兼容端点（POST /v1/messages）。
 *
 * 暴露 Anthropic 格式给外层（Claude Code 等只认 Anthropic 的客户端）。
 *   - 默认（UJN_NATIVE_ANTHROPIC 未开）：Anthropic ⇄ OpenAI 双向转换后走既有链路；
 *   - 若设 UJN_NATIVE_ANTHROPIC=1：把 Anthropic 请求体原样直通后端（原生直通）。
 */
app.post(ANTHROPIC_MESSAGES_PATH, async (req: Request, res: Response) => {
  let body: Record<string, unknown>;
  try {
    body = req.body as Record<string, unknown>;
    if (typeof body !== "object" || body === null) throw new Error("body must be JSON object");
  } catch {
    res.status(400).json(anthropicError("invalid_request_error", "请求体必须是 JSON"));
    return;
  }

  const model = typeof body.model === "string" ? body.model : undefined;
  if (!model) {
    res.status(400).json(anthropicError("invalid_request_error", "model 必填"));
    return;
  }

  try {
    await ensureAuthed(defaultWrap);

    // ---- 原生 Anthropic 直通模式（后端本身开放 /messages 时）----
    if (NATIVE_ANTHROPIC) {
      const upstream = await defaultWrap.anthropicCompletion(body);
      if (upstream.status >= 400) {
        res.status(upstream.status).send(await upstream.text().catch(() => ""));
        return;
      }
      const streaming =
        upstream.headers.get("content-type")?.includes("text/event-stream") || Boolean(body.stream);
      if (streaming && upstream.body) {
        res.status(upstream.status);
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();
        await pumpStream(upstream.body, res);
        res.end();
      } else {
        res.status(upstream.status).send(await upstream.text());
      }
      return;
    }

    // ---- 转换模式：Anthropic → OpenAI ----
    let converted: ReturnType<typeof anthropicToOpenAI>;
    try {
      converted = anthropicToOpenAI(body);
    } catch (e) {
      res.status(400).json(anthropicError("invalid_request_error", (e as Error).message));
      return;
    }
    const payload = converted.payload;
    const { inputTokens } = converted;
    payload.stream = Boolean(body.stream);

    // 复用 OpenAI 链路的上下文治理（clamp / 裁剪）
    const ctx = manageContext(payload);
    if (ctx.clamped) {
      console.log(`[ctx][anthropic] max_tokens ${ctx.clamped[0]} -> ${ctx.clamped[1]}（超出上下文预算）`);
    }
    if (ctx.trimmed) {
      console.log(`[ctx][anthropic] 裁剪 ${ctx.trimmed} 条旧消息：prompt ${ctx.prompt_before} -> ${ctx.prompt_after} tokens`);
    }

    const upstream = await defaultWrap.chatCompletion(payload);

    if (upstream.status >= 400) {
      const errText = await upstream.text().catch(() => "");
      res.status(upstream.status).json(anthropicError("api_error", errText.slice(0, 300)));
      return;
    }

    if (payload.stream) {
      res.status(upstream.status);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      if (upstream.body) {
        const gen = openAISseToAnthropicStream(upstream.body, { model, inputTokens });
        for await (const frame of gen) res.write(frame);
      }
      res.end();
      return;
    }

    // 非流式：OpenAI → Anthropic
    const text = await upstream.text();
    let oaiBody: Record<string, unknown> | null = null;
    try {
      oaiBody = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* 非 JSON */
    }
    if (!oaiBody || typeof oaiBody !== "object") {
      res.status(upstream.status).json(anthropicError("api_error", text.slice(0, 300)));
      return;
    }
    if (oaiBody.error) {
      const msg = (oaiBody.error as Record<string, unknown>).message ?? text.slice(0, 300);
      res.status(upstream.status).json(anthropicError("api_error", String(msg)));
      return;
    }
    res.status(upstream.status).json(openAIToAnthropicNonstream(oaiBody, model));
  } catch (e: any) {
    const status = e instanceof AuthRequiredError ? 401 : e.status ?? 502;
    const etype = status === 401 ? "authentication_error" : "api_error";
    res.status(status).json(anthropicError(etype, e.message));
  }
});

// ---------- 启动 ----------

/**
 * 预热模型列表缓存：
 *  1. 启动即用——先从磁盘缓存（.ujn_models.json）加载，立即可用、无需联网/登录；
 *  2. 变化自愈——再后台向上游拉一次最新列表，若上游有变会自动更新内存缓存并写回磁盘。
 */
async function warmModelCache(): Promise<void> {
  const disk = await defaultWrap.loadModelsFromDisk().catch(() => null);
  if (disk && Array.isArray(disk.data) && disk.data.length > 0) {
    refreshModelCache(disk.data);
    console.log(`[UJN] 已从磁盘缓存加载模型列表（${disk.data.length} 个），后台刷新上游...`);
  }
  // 后台刷新（不阻塞启动）：成功会自动更新内存缓存 + 写回磁盘
  defaultWrap
    .listModels()
    .then((latest) => {
      if (Array.isArray(latest?.data) && latest.data.length > 0) {
        refreshModelCache(latest.data);
      }
    })
    .catch(() => {
      /* 刷新失败不影响启动，回落磁盘/兜底表 */
    });
}

export async function main(): Promise<void> {
  console.log("\n" + "=".repeat(50));
  console.log("UJN AI Assist API Server (OpenAI-compatible, Node/TS)");
  console.log("=".repeat(50) + "\n");

  // 账号与密码为必需启动参数
  if (!UJN_USERNAME || !UJN_PASSWORD) {
    console.error("错误：缺少必需的登录凭据参数（账号 + 密码）。");
    console.error("用法: node src/server.ts -u <UJN账号> -p <密码> [--host <地址>] [--port <端口>]");
    console.error("示例: node src/server.ts -u 2021001234 -p ******** --port 8000");
    process.exit(1);
  }
  // 把启动凭据交给请求层：会话失效（Cookie 过期）时自动用它们重登并续期登录态
  defaultWrap.username = UJN_USERNAME;
  defaultWrap.password = UJN_PASSWORD;

  // 启动前确保 UJN 会话已认证
  if (!defaultWrap.jar || !defaultWrap.authenticated) {
    try {
      await defaultWrap.ensureSession(UJN_USERNAME, UJN_PASSWORD);
      console.log("[UJN] WebVPN 会话已就绪");
    } catch {
      console.log("[UJN] 需要登录济南大学统一身份认证 ...");
      const ok = await defaultWrap.login(UJN_USERNAME, UJN_PASSWORD);
      if (!ok) {
        console.error("登录失败，程序退出");
        process.exit(1);
      }
      console.log("[UJN] 登录成功");
    }
  } else {
    console.log("[UJN] WebVPN 会话已就绪");
  }

  await warmModelCache(); // 读盘预热 + 后台向上游刷新（发现模型变化自动更新）

  app.listen(PORT, HOST, () => {
    console.log(`[Server] UJN API 服务已启动: http://${HOST}:${PORT} (OpenAI 兼容)`);
  });
}

// 直接运行时启动（被 import 时不自动启动）
const isMain = process.argv[1] && new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).pathname.includes("server.ts");
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { app };
