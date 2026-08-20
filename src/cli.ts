/**
 * UJN (济南大学) DeepSeek CLI 对话工具 —— TypeScript 异步移植自 cli_chat.py。
 *
 * 启动流程：
 *   1. 确保 UJN WebVPN 会话已认证（没有则交互式登录，登录态持久化到 ujn_cookies.json）
 *   2. 拉起本地 OpenAI 兼容服务（server.ts，直通 UJN）
 *   3. 通过该服务进行流式对话
 *
 * 用法：npm run cli
 * 感谢 github@furtz12 github@szw0407 github@zeroHYH 这三位的数据和灵感提供 
 * 这三位的仓库在https://github.com/futz12/SDU_DeepSeek
 * 本仓库代码经由这个仓库的启发经过vibe coding而来
 */

import * as readline from "node:readline/promises";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultWrap } from "./wrap.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MODEL_FILE = path.join(__dirname, "..", ".ujn_model");
const SERVER_LOG = path.join(__dirname, "..", "server.log");

const API_BASE = process.env.UJN_API_BASE ?? "http://127.0.0.1:8000";
const HOST = process.env.UJN_API_HOST ?? "127.0.0.1";
const PORT = Number(process.env.UJN_API_PORT ?? "8000");

/** 确保 UJN 会话已认证；未认证则交互式登录并持久化 cookie。 */
async function ensureLogin(): Promise<void> {
  try {
    await defaultWrap.ensureSession();
    console.log("[UJN] WebVPN 会话已就绪");
  } catch {
    console.log("[UJN] 需要登录济南大学统一身份认证 ...");
    const ok = await defaultWrap.login();
    if (!ok) {
      console.error("登录失败，程序退出");
      process.exit(1);
    }
    console.log("[UJN] 登录成功");
  }
  // 兜底：即使 cookie 可能过期也尝试保留已保存的会话
  await defaultWrap.saveCookies();
}

/** 启动本地 API 服务（子进程）并等待就绪。 */
async function startServer(): Promise<any> {
  console.log("[Server] 正在启动本地 API 服务 ...");
  // 兼容源码运行（src/server.ts）与编译发布（dist/server.js）
  const jsEntry = path.join(__dirname, "server.js");
  const tsEntry = path.join(__dirname, "server.ts");
  const serverEntry = fs.existsSync(jsEntry) ? jsEntry : tsEntry;
  const logStream = fs.openSync(SERVER_LOG, "w");
  const proc = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, UJN_API_HOST: HOST, UJN_API_PORT: String(PORT) },
    stdio: ["ignore", "ignore", logStream],
    detached: true,
  });
  proc.unref();
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${API_BASE}/v1/models`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        console.log(`[Server] 服务已就绪 (日志: server.log) @ ${API_BASE}`);
        return proc;
      }
    } catch {
      /* 未就绪，重试 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log("[Server] 启动超时，请检查 server.log");
  proc.kill();
  process.exit(1);
}

// readline 历史：用自带文件加载（简单实现）
function loadHistory(): void {
  // Node readline 不内建 history 文件；仅提示
}

function selectModel(modelIds: string[]): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("可用模型：");
  modelIds.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
  return (async () => {
    for (;;) {
      const choice = (await rl.question("请选择模型编号（回车使用上次选择）: ")).trim();
      if (!choice) {
        try {
          const prev = fs.readFileSync(MODEL_FILE, "utf-8").trim();
          if (modelIds.includes(prev)) {
            rl.close();
            return prev;
          }
        } catch {
          /* 无上次选择 */
        }
        rl.close();
        return modelIds[0];
      }
      const idx = Number(choice) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < modelIds.length) {
        rl.close();
        return modelIds[idx];
      }
      console.log("无效选择，请重新输入");
    }
  })();
}

/** 打印流式响应，返回完整内容。 */
async function printStream(resp: Response): Promise<string> {
  let fullContent = "";
  let gotData = false;
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const reader = resp.body?.getReader();
  if (!reader) return fullContent;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx + 2);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data);
          gotData = true;
          if (chunk.error) {
            process.stdout.write(`\n[API错误]: ${JSON.stringify(chunk.error)}`);
            continue;
          }
          const delta = chunk.choices?.[0]?.delta ?? {};
          if (delta.reasoning_content) {
            process.stdout.write(`[思考]: ${delta.reasoning_content}`);
          }
          if (delta.content) {
            process.stdout.write(delta.content);
            fullContent += delta.content;
          }
        } catch {
          /* 非 JSON 帧忽略 */
        }
      }
    }
  }
  buffer += decoder.decode();
  if (buffer) {
    for (const line of buffer.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;
      try {
        const chunk = JSON.parse(data);
        gotData = true;
        const delta = chunk.choices?.[0]?.delta ?? {};
        if (delta.content) {
          process.stdout.write(delta.content);
          fullContent += delta.content;
        }
      } catch {
        /* ignore */
      }
    }
  }
  if (!gotData) process.stdout.write("\n[警告] 服务端未返回任何数据");
  process.stdout.write("\n");
  return fullContent;
}

async function main(): Promise<void> {
  await ensureLogin();
  const serverProc = await startServer();

  const cleanup = (): void => {
    console.log("\n[Server] 正在关闭 ...");
    try {
      serverProc.kill();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  loadHistory();

  const modelsResp = (await fetch(`${API_BASE}/v1/models`).then((r) => r.json())) as {
    data?: { id: string }[];
  };
  const modelIds: string[] = (modelsResp?.data ?? []).map((m) => m.id);
  if (modelIds.length === 0) {
    console.log("[Error] 无法获取模型列表");
    cleanup();
  }
  let modelName = await selectModel(modelIds);
  fs.writeFileSync(MODEL_FILE, modelName);

  const history: { role: string; content: string }[] = [];
  console.log("\n=== 济南大学AI助手CLI对话工具 (UJN WebVPN) ===");
  console.log("输入 'quit' 或 'exit' 退出");
  console.log("输入 'clear' 清空对话历史");
  console.log("输入 'model' 切换模型\n");
  console.log(`当前模型: ${modelName}`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    const userInput = (await rl.question("\n你: ")).trim();
    const cmd = userInput.toLowerCase();
    if (cmd === "quit" || cmd === "exit") {
      rl.close();
      cleanup();
    }
    if (cmd === "clear") {
      history.length = 0;
      console.log("对话历史已清空");
      continue;
    }
    if (cmd === "model") {
      modelName = await selectModel(modelIds);
      fs.writeFileSync(MODEL_FILE, modelName);
      console.log(`已切换模型: ${modelName}`);
      continue;
    }
    if (!userInput) continue;

    history.push({ role: "user", content: userInput });
    const payload = { model: modelName, messages: history, stream: true };
    try {
      process.stdout.write(`${modelName}: `);
      const resp = await fetch(`${API_BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(600_000),
      });
      if (!resp.ok) {
        const text = await resp.text();
        process.stdout.write(`\n[HTTP ${resp.status}] ${text.slice(0, 300)}\n`);
        history.pop();
        continue;
      }
      const full = await printStream(resp);
      if (full) history.push({ role: "assistant", content: full });
      else history.pop();
    } catch (e: any) {
      console.log(`\n错误: ${e.message}`);
      history.pop();
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
