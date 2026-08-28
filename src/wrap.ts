/**
 * UJN (济南大学) 后端请求层 —— TypeScript 异步移植自 ujnwrap.py。
 *
 * 职责：
 *   1. 维护一个已通过双认证的请求上下文（WebVPN cookie + Bearer token）
 *   2. 把 OpenAI 请求体原样 POST 到后端，并把响应原样/流式回传
 *   3. 免登录复用：把 cookie 与 token 持久化到本地文件
 *
 * 与 Python 版的差异：全部 async（Node 原生 fetch + 手动 cookie jar），
 * 流式响应返回 Web ReadableStream，由调用方（server.ts）转发。
* 感谢 github@furtz12 github@szw0407 github@zeroHYH 这三位的数据和灵感提供 
 * 这三位的仓库在https://github.com/futz12/SDU_DeepSeek
 * 本仓库代码经由这个仓库的启发经过vibe coding而来
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as cfg from "./config.ts";
import * as loginMod from "./login.ts";

// 模块所在目录（用于解析默认 cookie 文件相对路径）
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 会话未认证或过期，需要重新登录。 */
export class AuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthRequiredError";
  }
}

/** 上游请求的统一错误（HTTP >= 400 等）。 */
export class UpstreamError extends Error {
  status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }
}

/** 后端响应（流式 body 以 ReadableStream<Uint8Array> 表示）。 */
export interface UpstreamResponse {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  /** 读取全部文本（非流式用）。 */
  text(): Promise<string>;
  /** 解析 JSON（非流式用）。 */
  json(): Promise<any>;
}

/** 把 web fetch Response 包装为 UpstreamResponse。 */
function wrapResponse(resp: Response): UpstreamResponse {
  return {
    status: resp.status,
    headers: resp.headers,
    body: resp.body,
    text: () => resp.text(),
    json: () => resp.json(),
  };
}

/**
 * 把 fetch 异常连同 cause 链展开成完整可读描述。
 * Node 的 "fetch failed" 只是笼统包装，真实原因（ECONNRESET/ETIMEDOUT/TLS 等）在 e.cause 里。
 */
function describeFetchError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const parts: string[] = [`${e.name}: ${e.message}`];
  let c = (e as any).cause;
  let i = 0;
  while (c && i < 4) {
    const cc = c as Record<string, unknown>;
    parts.push(`${String(cc.code ?? cc.name ?? "error")}: ${String(cc.message ?? c)}`);
    c = (cc as any).cause;
    i++;
  }
  return parts.join(" <- ");
}

/** 是否为连接层超时（AbortSignal.timeout 触发）。 */
function isTimeoutError(e: any): boolean {
  return e?.name === "TimeoutError" || e?.name === "AbortError";
}

export interface UJNWrapOptions {
  cookiesFile?: string;
  username?: string;
  password?: string;
}

export class UJNWrap {
  cookiesFile: string;
  /** 模型列表磁盘缓存文件（存原始 /api/models 响应，供启动即用 / 离线兜底）。 */
  modelsFile: string;
  /** 登录凭据（可选）。设置后，会话失效时可自动重登并续期登录态。 */
  username?: string;
  password?: string;
  jar: loginMod.CookieJar | null = null;
  token: string | null = null;
  tokenType = "Bearer";
  authenticated = false;
  /** 当前会话是否来自磁盘恢复（可能已过期；网络异常时优先触发重登自愈）。 */
  sessionFromDisk = false;
  /** 进行中的登录 Promise（并发去重，避免网络抖动引发登录风暴）。 */
  private loginInFlight: Promise<boolean> | null = null;

  constructor(opts: UJNWrapOptions = {}) {
    this.cookiesFile = opts.cookiesFile ?? cfg.COOKIES_FILE;
    if (!path.isAbsolute(this.cookiesFile)) {
      this.cookiesFile = path.resolve(__dirname, "..", this.cookiesFile);
    }
    this.modelsFile = path.resolve(__dirname, "..", ".ujn_models.json");
    this.username = opts.username;
    this.password = opts.password;
  }

  // ---------- 认证态持久化 ----------

  /** 从本地文件恢复 cookie 与 token。返回是否成功恢复。 */
  async loadCookies(): Promise<boolean> {
    try {
      const raw = await fs.readFile(this.cookiesFile, "utf-8");
      const data = JSON.parse(raw);
      if (data && typeof data === "object" && data.cookies) {
        this.jar = new loginMod.CookieJar(data.cookies);
        this.token = data.token ?? null;
        this.tokenType = data.token_type ?? "Bearer";
        this.authenticated = true;
        this.sessionFromDisk = true; // 磁盘恢复的会话可能已过期
        return true;
      }
    } catch (e: any) {
      if (e.code !== "ENOENT") {
        console.log(`[UJN] 读取登录态失败（${e.message}），将重新登录`);
      }
    }
    return false;
  }

  /** 持久化 cookie 与 token。 */
  async saveCookies(): Promise<void> {
    if (!this.jar) return;
    const payload = {
      cookies: this.jar.toObject(),
      token: this.token,
      token_type: this.tokenType,
    };
    await fs.writeFile(this.cookiesFile, JSON.stringify(payload, null, 2), "utf-8");
    console.log(`[UJN] 登录态已保存到 ${this.cookiesFile}`);
  }

  /** 执行双层登录（WebVPN + LDAP），成功后保存认证态。并发调用自动去重。 */
  async login(username?: string, password?: string): Promise<boolean> {
    if (this.loginInFlight) return this.loginInFlight;
    this.loginInFlight = this.doLogin(username, password).finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  private async doLogin(username?: string, password?: string): Promise<boolean> {
    try {
      const result = username && password
        ? await loginMod.login(username, password)
        : await loginMod.loginInteractive();
      this.jar = result.jar;
      this.token = result.token;
      this.tokenType = result.tokenType;
      this.authenticated = true;
      this.sessionFromDisk = false; // 全新登录的会话
      await this.saveCookies();
      return true;
    } catch (e: any) {
      console.log(`[UJN] 登录失败：${e.message}`);
      return false;
    }
  }

  /** 确保存在已认证会话；未认证且无参数时抛 AuthRequiredError。 */
  async ensureSession(username?: string, password?: string): Promise<loginMod.CookieJar> {
    if (!this.jar) {
      const ok = await this.loadCookies();
      if (!ok) this.jar = new loginMod.CookieJar();
    }
    if (!this.authenticated) {
      if (username && password) {
        if (!(await this.login(username, password))) {
          throw new AuthRequiredError("登录失败");
        }
      } else {
        throw new AuthRequiredError("UJN 会话未认证");
      }
    }
    return this.jar as loginMod.CookieJar; // 走到这里 jar 必已就绪
  }

  // ---------- 请求 ----------

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = { "User-Agent": cfg.VPN_UA };
    if (this.token) h["Authorization"] = `${this.tokenType} ${this.token}`;
    return h;
  }

  private backendUrl(path: string): string {
    return `${cfg.VPN_BASE}/https/${cfg.CHAT_HOST_WEBVPN}${path}`;
  }

  /**
   * 发起后端请求，处理认证失效（403/HTML 引导）与错误。
   * 返回包装后的 UpstreamResponse。
   *
   * 若会话失效（Cookie 过期 / WebVPN 引导页），且已配置 username/password，
   * 会自动用凭据重登一次并重试原请求（登录态随之续期并写回磁盘）。
   */
  async request(
    method: string,
    path: string,
    opts: { jsonBody?: unknown; stream?: boolean; timeoutMs?: number } = {},
  ): Promise<UpstreamResponse> {
    const { jsonBody, stream = false, timeoutMs = 60000 } = opts;
    const errMsg = "[UJN] 会话未认证/已失效，请重新登录";
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // 已认证则直接返回；未认证且配置了凭据则自动重登
      const jar = await this.ensureSession(this.username, this.password);
      const headers = this.authHeaders();
      let body: string | undefined;
      if (jsonBody !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(jsonBody);
      }

      let resp: Response;
      try {
        resp = await fetch(this.backendUrl(path), {
          method,
          headers: { ...jar.header(), ...headers },
          body,
          redirect: "follow",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e: any) {
        const detail = describeFetchError(e);
        console.log(`[UJN] 网络异常（第 ${attempt + 1}/${maxAttempts} 次）：${detail}`);
        const timeout = isTimeoutError(e);
        // 磁盘恢复的旧会话 + 连接层异常：很可能是会话过期被 WebVPN 断连/踢回登录页 → 先重登自愈
        if (attempt === 0 && !timeout && this.username && this.password && this.sessionFromDisk) {
          console.log("[UJN] 疑似登录态过期，尝试重新登录后重试 ...");
          this.authenticated = false;
          if (await this.login(this.username, this.password)) continue;
        }
        // 超时不重试（重试大概率仍超时且成倍拖长请求）；连接层错误退避后重试
        if (!timeout && attempt < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, attempt === 0 ? 300 : 1000));
          continue;
        }
        throw new UpstreamError(`[UJN] 请求失败：${detail}`, timeout ? 504 : 502);
      }

      const ct = resp.headers.get("Content-Type") ?? "";
      let authFailed = false;
      if (resp.status === 403 || ((resp.status === 200 || resp.status === 404) && ct.includes("text/html"))) {
        const head = (await resp.text()).slice(0, 2000);
        if (resp.status === 403 && head.includes("Not authenticated")) authFailed = true;
        if (ct.includes("text/html") && (head.includes("wengine") || head.includes("loginForm"))) authFailed = true;
      }
      if (authFailed) {
        this.authenticated = false;
        // 第一次且配置了凭据 → 自动重登后重试一次（Cookie 过期自愈）
        if (attempt === 0 && this.username && this.password) {
          console.log("[UJN] 会话已失效，正在用保存的凭据自动重新登录...");
          const ok = await this.login(this.username, this.password);
          if (ok) continue; // 重试原请求
        }
        throw new AuthRequiredError(errMsg);
      }
      if (resp.status >= 400 && !stream) {
        const text = (await resp.text()).slice(0, 300);
        throw new UpstreamError(`[UJN] HTTP ${resp.status}: ${text}`, resp.status);
      }
      return wrapResponse(resp);
    }
    throw new AuthRequiredError(errMsg);
  }

  /** 直通 /api/chat/completions，返回（可能为流式的）响应。 */
  async chatCompletion(payload: Record<string, unknown>): Promise<UpstreamResponse> {
    const stream = Boolean(payload.stream);
    // 超时：连接 10s / 整体 600s（Node fetch 单一超时，取较大者）
    return this.request("POST", cfg.CHAT_PATH, {
      jsonBody: payload,
      stream,
      timeoutMs: stream ? 600_000 : 600_000,
    });
  }

  /**
   * 原生 Anthropic 直通：当后端本身开放 Anthropic Messages 路径时，
   * 把 Anthropic 请求体原样 POST 到后端（UJN_NATIVE_ANTHROPIC=1 时启用）。
   */
  async anthropicCompletion(payload: Record<string, unknown>): Promise<UpstreamResponse> {
    const stream = Boolean(payload.stream);
    return this.request("POST", cfg.ANTHROPIC_BACKEND_PATH, {
      jsonBody: payload,
      stream,
      timeoutMs: stream ? 600_000 : 600_000,
    });
  }

  /**
   * 拉取 /api/models。
   *
   * 借鉴 koishibot/ernie-vilg 的「request coalescing」思路做并发去重：
   *   - 相同键的并发调用只打一次上游，其余复用同一个进行中的 Promise（in-flight 去重）；
   *   - 成功结果再缓存一个短 TTL（默认 60s），TTL 内直接返回缓存，不重复请求上游；
   *   - 成功结果同时异步落盘（.ujn_models.json），供下次启动即用 / 离线兜底；
   *   - 拉取失败且内存为空时回退读盘，保证不返回空列表。
   */
  async listModels(): Promise<{ data?: unknown[] }> {
    // TTL 内已有成功结果 → 直接返回缓存
    if (listModelsCache && Date.now() - listModelsCacheAt < MODELS_LIST_TTL_MS) {
      return listModelsCache;
    }
    // in-flight 去重：并发调用复用同一个 Promise
    if (!listModelsInFlight) {
      listModelsInFlight = this.request("GET", "/api/models", { timeoutMs: 60_000 })
        .then(async (resp) => {
          try {
            const data = await resp.json();
            const value = data ?? {};
            listModelsCache = value; // 记录最后成功结果（失败可回退，不返回空）
            listModelsCacheAt = Date.now();
            void this.writeModelsToDisk(value); // 异步落盘，不阻塞返回
            return value;
          } catch {
            console.log("[UJN] 刷新模型列表：上游响应解析失败，回退缓存");
            return this.fallbackModels(); // 解析失败回退（内存 → 磁盘）
          }
        })
        .catch((e: any) => {
          console.log(`[UJN] 刷新模型列表失败：${e?.message ?? e}，回退缓存`);
          return this.fallbackModels(); // 网络失败同样回退
        })
        .finally(() => {
          listModelsInFlight = null; // 释放，下次调用可重新触发刷新
        });
    }
    return listModelsInFlight;
  }

  /** 从磁盘缓存加载模型列表（启动预热 / 离线兜底）。无缓存返回 null。 */
  async loadModelsFromDisk(): Promise<{ data?: unknown[] } | null> {
    try {
      const raw = await fs.readFile(this.modelsFile, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).data)) {
        return parsed as { data?: unknown[] };
      }
    } catch (e: any) {
      if (e.code !== "ENOENT") {
        console.log(`[UJN] 读取模型缓存失败：${e.message}`);
      }
    }
    return null;
  }

  /** 把模型列表异步写入磁盘缓存（fire-and-forget）。 */
  private async writeModelsToDisk(value: { data?: unknown[] }): Promise<void> {
    try {
      await fs.writeFile(this.modelsFile, JSON.stringify(value), "utf-8");
    } catch (e: any) {
      console.log(`[UJN] 写模型缓存失败：${e.message}`);
    }
  }

  /** 回退链：内存 → 磁盘。两者都没有才返回空对象。 */
  private async fallbackModels(): Promise<{ data?: unknown[] }> {
    if (listModelsCache) return listModelsCache;
    const disk = await this.loadModelsFromDisk();
    if (disk) {
      listModelsCache = disk; // 把磁盘结果提升为内存缓存，避免反复读盘
      listModelsCacheAt = Date.now();
      return disk;
    }
    return {};
  }
}

/** /api/models 结果短 TTL（毫秒），TTL 内不重复请求上游。 */
const MODELS_LIST_TTL_MS = 60_000;
/** 最后一次成功的 /api/models 结果。 */
let listModelsCache: { data?: unknown[] } | null = null;
/** 上一次成功刷新的时间戳。 */
let listModelsCacheAt = 0;
/** 进行中的 /api/models 请求（in-flight 去重用）。 */
let listModelsInFlight: Promise<{ data?: unknown[] }> | null = null;

// 模块级单例
export const defaultWrap: UJNWrap = new UJNWrap();
