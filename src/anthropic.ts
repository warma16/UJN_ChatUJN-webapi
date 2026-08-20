/**
 * Anthropic Messages API ⇄ OpenAI Chat Completions 双向转换。
 *
 * 用途：网关对外暴露 Anthropic 兼容端点（POST /v1/messages），
 * 而 UJN 后端（Open WebUI/vLLM 系）只原生说 OpenAI 格式，
 * 因此在网关层做格式转换：
 *   - 请求：Anthropic → OpenAI（anthropicToOpenAI）
 *   - 响应：OpenAI → Anthropic（openAIToAnthropicNonstream / 流式 SSE 事件）
 *
 * 范围约定（当前实现）：文本内容块 + 思考块 + 流式/非流式。
 * 图片 image、工具 tool_use/tool_result 块暂不映射（按文本拼接 / 忽略）。
 */

import { randomBytes } from "node:crypto";

/** Anthropic 请求缺字段/格式错误。 */
export class AnthropicRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnthropicRequestError";
  }
}

/** 构造 Anthropic 标准错误响应体。 */
export function anthropicError(
  type: "invalid_request_error" | "authentication_error" | "api_error" | "permission_error",
  message: string,
): Record<string, unknown> {
  return { type: "error", error: { type, message } };
}

// ---------- token 估算（与 server.ts 内 estTokens/payloadPromptTokens 算法一致） ----------

/** 粗略估算一段文本的 token 数（CJK 0.7、其他 0.28、+4）。 */
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

/** 估算 OpenAI 请求 messages 的总 prompt token 数。 */
function promptTokens(payload: Record<string, unknown>): number {
  let total = 0;
  const messages = payload.messages;
  if (!Array.isArray(messages)) return 0;
  for (const m of messages) {
    if (typeof m !== "object" || m === null) continue;
    const content = (m as Record<string, unknown>).content;
    if (typeof content === "string") total += estTokens(content);
    else if (Array.isArray(content)) {
      for (const p of content) {
        if (typeof p !== "object" || p === null) continue;
        const text = (p as Record<string, unknown>).text;
        if (typeof text === "string" && text) total += estTokens(text);
      }
    }
  }
  return total;
}

// ---------- Anthropic 请求 → OpenAI 请求 ----------

/** 提取一段 Anthropic content（字符串或内容块数组）的纯文本。 */
function anthropicTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      // image / tool_use / tool_result 不在本次范围：忽略
    }
    return parts.join("\n");
  }
  return "";
}

export interface AnthropicToOpenAIResult {
  /** 转换后的 OpenAI chat 请求体。 */
  payload: Record<string, unknown>;
  /** 估算的 prompt token 数（用于 Anthropic 响应里的 input_tokens）。 */
  inputTokens: number;
}

/**
 * 把 Anthropic Messages 请求体转换为 OpenAI Chat Completions 请求体。
 * 抛 AnthropicRequestError 当缺 model/messages 等必需字段。
 */
export function anthropicToOpenAI(body: Record<string, unknown>): AnthropicToOpenAIResult {
  if (typeof body !== "object" || body === null) throw new AnthropicRequestError("请求体必须是 JSON 对象");
  const model = body.model;
  if (typeof model !== "string" || !model) throw new AnthropicRequestError("model 必填");
  const rawMessages = body.messages;
  if (!Array.isArray(rawMessages)) throw new AnthropicRequestError("messages 必填");

  const messages: Record<string, unknown>[] = [];

  // system（字符串或文本块数组）→ 首条 system 消息
  if (body.system !== undefined && body.system !== null) {
    const sysText = anthropicTextOf(body.system);
    if (sysText) messages.push({ role: "system", content: sysText });
  }

  for (const m of rawMessages) {
    if (typeof m !== "object" || m === null) continue;
    const mm = m as Record<string, unknown>;
    const role = mm.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = anthropicTextOf(mm.content);
    if (content) messages.push({ role, content });
  }

  const payload: Record<string, unknown> = {
    model,
    messages,
    stream: Boolean(body.stream),
  };

  if (typeof body.max_tokens === "number") payload.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") payload.temperature = body.temperature;
  if (typeof body.top_p === "number") payload.top_p = body.top_p;
  if (typeof body.top_k === "number") payload.top_k = body.top_k;
  if (Array.isArray(body.stop_sequences)) {
    const stops = body.stop_sequences.filter((s): s is string => typeof s === "string" && s.length > 0);
    if (stops.length > 0) payload.stop = stops;
  }

  // Anthropic thinking → OpenAI reasoning_effort
  if (body.thinking === false) payload.reasoning_effort = "none";
  else if (body.thinking === true) payload.reasoning_effort = "high";
  else if (typeof body.thinking === "object" && body.thinking !== null) {
    const t = (body.thinking as Record<string, unknown>).type;
    if (t === "disabled") payload.reasoning_effort = "none";
    else if (t === "enabled") payload.reasoning_effort = "high";
  }

  return { payload, inputTokens: promptTokens(payload) };
}

// ---------- OpenAI 响应 → Anthropic 响应 ----------

/** 把 OpenAI finish_reason 映射为 Anthropic stop_reason。 */
function anthropicStopReason(finish: unknown): string | null {
  if (finish === "length") return "max_tokens";
  if (finish === "tool_calls" || finish === "function_call") return "tool_use";
  if (finish === "stop_sequence") return "stop_sequence";
  return "end_turn"; // stop / null / 其它一律视为自然结束
}

function asNonNeg(v: unknown): number {
  return typeof v === "number" && v > 0 ? v : 0;
}

/**
 * 把 OpenAI 非流式响应体转换为 Anthropic Messages 响应体。
 * @param openaiBody OpenAI /v1/chat/completions 响应解析结果
 * @param model 请求中的模型名（回填到 Anthropic 响应的 model 字段）
 */
export function openAIToAnthropicNonstream(openaiBody: Record<string, unknown>, model: string): Record<string, unknown> {
  const choices = Array.isArray(openaiBody.choices) ? openaiBody.choices : [];
  const first = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (first.message ?? {}) as Record<string, unknown>;
  const content = typeof message.content === "string" ? message.content : "";
  const reasoning =
    typeof message.reasoning_content === "string" && message.reasoning_content
      ? (message.reasoning_content as string)
      : typeof message.reasoning === "string" && message.reasoning
        ? (message.reasoning as string)
        : undefined;
  const usage = (openaiBody.usage && typeof openaiBody.usage === "object" ? openaiBody.usage : {}) as Record<string, unknown>;

  const blocks: Record<string, unknown>[] = [];
  if (reasoning) blocks.push({ type: "thinking", thinking: reasoning });
  blocks.push({ type: "text", text: content });

  return {
    id: typeof openaiBody.id === "string" ? openaiBody.id : "msg_" + randomBytes(12).toString("hex"),
    type: "message",
    role: "assistant",
    model,
    content: blocks,
    stop_reason: anthropicStopReason(first.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: asNonNeg(usage.prompt_tokens),
      output_tokens: asNonNeg(usage.completion_tokens),
    },
  };
}

// ---------- OpenAI 流式 SSE → Anthropic SSE 事件 ----------

export interface AnthropicStreamOpts {
  model: string;
  /** 估算的 prompt token 数（会话开头占位）。 */
  inputTokens?: number;
}

/**
 * 读取 OpenAI 流式 SSE（data: 帧），yield 输出 Anthropic SSE 事件块。
 *
 * 每次 yield 是一个完整的 Anthropic SSE 块（\`event: <type>\ndata: <json>\n\n\`），
 * 事件序列对齐 Anthropic Messages 流式协议：
 *   message_start → content_block_start → content_block_delta... → content_block_stop
 *   → ... → message_delta → message_stop
 */
export async function* openAISseToAnthropicStream(
  stream: ReadableStream<Uint8Array>,
  opts: AnthropicStreamOpts,
): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8");
  const reader = stream.getReader();

  let pending: string[] = [];
  let started = false;
  let finished = false;
  let openKind: "thinking" | "text" | null = null;
  let openIndex = -1;
  let blocksOpened = 0;
  let outputTokens = 0;
  const msgId = "msg_" + randomBytes(12).toString("hex");

  const block = (type: string, data: unknown): string => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

  const messageStart = (): void => {
    pending.push(
      block("message_start", {
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          model: opts.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: opts.inputTokens ?? 0, output_tokens: 0 },
        },
        usage: { input_tokens: opts.inputTokens ?? 0, output_tokens: 0 },
      }),
    );
  };

  const openContent = (kind: "thinking" | "text"): void => {
    openKind = kind;
    openIndex++;
    blocksOpened++;
    pending.push(
      block("content_block_start", {
        type: "content_block_start",
        index: openIndex,
        content_block: kind === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" },
      }),
    );
  };

  const closeContent = (): void => {
    if (openKind) {
      pending.push(block("content_block_stop", { type: "content_block_stop", index: openIndex }));
      openKind = null;
    }
  };

  const finalize = (reason: string | null, finalUsage?: number): void => {
    if (finished) return;
    finished = true;
    if (!started) {
      messageStart();
      started = true;
    }
    if (openKind) closeContent();
    if (blocksOpened === 0) {
      openContent("text");
      closeContent();
    }
    if (typeof finalUsage === "number" && finalUsage > 0) outputTokens = finalUsage;
    pending.push(
      block("message_delta", {
        type: "message_delta",
        delta: { stop_reason: reason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      }),
    );
    pending.push(block("message_stop", { type: "message_stop" }));
  };

  const processDelta = (delta: Record<string, unknown>, finish: unknown, usage: unknown): void => {
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    const content = delta.content;

    if (typeof reasoning === "string" && reasoning) {
      if (!started) {
        messageStart();
        started = true;
      }
      if (openKind !== "thinking") {
        if (openKind) closeContent();
        openContent("thinking");
      }
      pending.push(
        block("content_block_delta", {
          type: "content_block_delta",
          index: openIndex,
          delta: { type: "thinking_delta", thinking: reasoning },
        }),
      );
    }

    if (typeof content === "string" && content) {
      if (!started) {
        messageStart();
        started = true;
      }
      if (openKind !== "text") {
        if (openKind) closeContent();
        openContent("text");
      }
      pending.push(
        block("content_block_delta", {
          type: "content_block_delta",
          index: openIndex,
          delta: { type: "text_delta", text: content },
        }),
      );
    }

    if (finish !== undefined && finish !== null) {
      const usageObj = (usage ?? {}) as Record<string, unknown>;
      const outTokens = typeof usageObj.completion_tokens === "number" ? usageObj.completion_tokens : undefined;
      finalize(anthropicStopReason(finish), outTokens);
    }
  };

  const processData = (obj: Record<string, unknown>): void => {
    const choices = obj.choices;
    if (!Array.isArray(choices) || choices.length === 0) return;
    const choice = (choices[0] ?? {}) as Record<string, unknown>;
    const delta = (choice.delta ?? {}) as Record<string, unknown>;
    // usage 通常在 chunk 顶层，个别实现放在 choice 里；两者都兼容
    const usage = obj.usage ?? choice.usage;
    processDelta(delta, choice.finish_reason ?? null, usage);
  };

  const processFrame = (frame: string): void => {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const obj = JSON.parse(data);
        if (obj && typeof obj === "object") processData(obj);
      } catch {
        /* 非 JSON 数据帧忽略 */
      }
    }
  };

  const flush = async function* (): AsyncGenerator<string> {
    for (const s of pending) yield s;
    pending = [];
  };

  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, idx + 2);
        buffer = buffer.slice(idx + 2);
        processFrame(frame);
        yield* flush();
      }
    }
    buffer += decoder.decode();
    if (buffer) {
      processFrame(buffer);
      yield* flush();
    }
    if (!finished) finalize("end_turn");
    yield* flush();
  } finally {
    reader.releaseLock();
  }
}
