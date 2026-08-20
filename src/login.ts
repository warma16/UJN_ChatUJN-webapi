/**
 * UJN (济南大学) 内网 DeepSeek 服务的完整认证登录 —— TypeScript 异步移植自 ujn_login.py。
 *
 * 双层认证：
 *   第 1 层：深信服 WebVPN 统一身份认证（深澜 tpass CAS）→ 种下 ticked cookie 穿入内网
 *   第 2 层：Open WebUI (ChatUJN) LDAP 登录 → 获取 Bearer JWT
 *
 * Node 原生 fetch 不自动管理 cookie，故自行实现 CookieJar 与重定向链，
 * 行为对齐 Python requests.Session（重定向间传递并累积 cookie）。
 * 感谢 github@furtz12 github@szw0407 github@zeroHYH 这三位的数据和灵感提供 
 * 这三位的仓库在https://github.com/futz12/SDU_DeepSeek
 * 本仓库代码经由这个仓库的启发经过vibe coding而来
 */

import * as cfg from "./config.ts";
import { strEnc } from "./des.ts";

// ---------- 类型 ----------

export interface LoginResult {
  jar: CookieJar;
  cookies: Record<string, string>;
  token: string;
  tokenType: string;
  user: Record<string, unknown>;
  expires: Date;
}

// ---------- 工具 ----------

/** 简易 cookie jar：name -> value，含响应 set-cookie 采集与持久化。 */
export class CookieJar {
  cookies: Map<string, string>;

  constructor(initial: Record<string, string> = {}) {
    this.cookies = new Map(Object.entries(initial));
  }

  /** 从 Response 的 set-cookie 头采集（多个 cookie 逐个解析）。 */
  setFromResponse(resp: Response): void {
    let setCookies: string[];
    if (typeof (resp.headers as Headers).getSetCookie === "function") {
      setCookies = (resp.headers as Headers).getSetCookie();
    } else {
      const raw = resp.headers.get("set-cookie");
      setCookies = raw ? [raw] : [];
    }
    for (const sc of setCookies) {
      const first = sc.split(";")[0];
      const eq = first.indexOf("=");
      if (eq > 0) this.cookies.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
    }
  }

  /** 生成 Cookie 请求头（无 cookie 时返回空对象）。 */
  header(): Record<string, string> {
    if (this.cookies.size === 0) return {};
    const parts: string[] = [];
    for (const [k, v] of this.cookies) parts.push(`${k}=${v}`);
    return { Cookie: parts.join("; ") };
  }

  toObject(): Record<string, string> {
    return Object.fromEntries(this.cookies);
  }
}

/** fetch 选项（不含 jar 与 body 泛型部分）。 */
interface FetchJarOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  jar: CookieJar;
  maxRedirects?: number;
  timeoutMs?: number;
}

/**
 * 带 cookie jar 与手动重定向链的 fetch。
 * 行为对齐 Python requests：跟随 3xx、重定向间保留 cookie、303/302 转 GET。
 * 返回最终 Response（body 未读取）。
 */
export async function fetchWithJar(
  url: string,
  { method = "GET", headers = {}, body, jar, maxRedirects = 8, timeoutMs = 30000 }: FetchJarOptions,
): Promise<Response> {
  let current = url;
  let m = method;
  let b = body;
  for (let i = 0; i < maxRedirects; i++) {
    const h = { ...jar.header(), ...headers };
    const resp = await fetch(current, {
      method: m,
      headers: h,
      body: b,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    jar.setFromResponse(resp);
    const status = resp.status;
    if (status >= 300 && status < 400) {
      const loc = resp.headers.get("location");
      if (!loc) return resp; // 无 Location 的 3xx：原样返回
      current = new URL(loc, current).toString();
      // requests 语义：303 一律转 GET；302 在非 GET/HEAD 时也转 GET
      if (status === 303 || (status === 302 && m !== "GET" && m !== "HEAD")) {
        m = "GET";
        b = undefined;
        delete headers["Content-Type"];
      }
      continue;
    }
    return resp;
  }
  throw new Error("[UJN] 重定向次数过多");
}

/** 从 HTML 提取隐藏字段值（兼容 name= 或 id= 在前/在后两种顺序）。 */
function extractField(html: string, name: string): string {
  const pats = [
    new RegExp(`(?:name|id)="${name}"[^>]*value="([^"]*)"`),
    new RegExp(`value="([^"]*)"[^>]*(?:name|id)="${name}"`),
  ];
  for (const p of pats) {
    const m = html.match(p);
    if (m) return m[1];
  }
  return "";
}

/** 判断响应是否为统一身份认证（CAS）登录页：深澜票据字段 lt + loginForm。 */
export function isLoginPage(html: string): boolean {
  return html.includes('name="lt"') && html.includes("loginForm");
}

/** 拼接后端完整 URL（经由 WebVPN 的 host 编码）。 */
function backendUrl(path: string): string {
  return `${cfg.VPN_BASE}/https/${cfg.CHAT_HOST_WEBVPN}${path}`;
}

// ---------- 第 1 层：WebVPN 深澜 CAS 登录 ----------

/** 触发 WebVPN 握手并取得 CAS 登录页，同时种下握手 cookie。 */
async function fetchLoginPage(jar: CookieJar): Promise<string> {
  let resp = await fetchWithJar(cfg.CHAT_URL, { jar, timeoutMs: 30000 });
  let html = await resp.text();
  if (isLoginPage(html)) return html;
  // 部分部署首次访问会 302 到 /login，再跟随一次
  if (resp.headers.get("location") || html.includes("统一身份认证")) {
    resp = await fetchWithJar(cfg.VPN_BASE + "/login", { jar, timeoutMs: 30000 });
    html = await resp.text();
  }
  return html;
}

/** 解析 CAS 登录页字段并提交，返回 [ok, html]。 */
async function submitWebvpnLogin(
  jar: CookieJar,
  username: string,
  password: string,
  loginPage: string,
): Promise<[boolean, string]> {
  const lt = extractField(loginPage, "lt");
  const execution = extractField(loginPage, "execution");
  const eventId = extractField(loginPage, "_eventId") || "submit";

  const actionMatch = loginPage.match(/<form[^>]*action="([^"]*)"/);
  if (!actionMatch) throw new Error("无法在登录页中找到 form action");
  const action = actionMatch[1];
  let submitUrl: string;
  if (action.startsWith("/")) submitUrl = cfg.VPN_BASE + action;
  else if (action.startsWith("http")) submitUrl = action;
  else submitUrl = cfg.VPN_BASE + "/" + action;

  // 深澜 CAS 加密：rsa = strEnc(用户名 + 密码 + lt, '1','2','3')
  const rsa = strEnc(username + password + lt, ...cfg.DES_KEYS);

  const form = new URLSearchParams({
    rsa,
    ul: String(username.length),
    pl: String(password.length),
    lt,
    execution,
    _eventId: eventId,
  });

  const resp = await fetchWithJar(submitUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    jar,
    timeoutMs: 30000,
  });
  const html = await resp.text();
  return [isLoginPage(html) ? false : true, html];
}

// ---------- 第 2 层：Open WebUI LDAP 登录 ----------

/** 通过 Open WebUI 的 LDAP 接口登录，返回 Bearer token 凭证。 */
async function ldapSignin(jar: CookieJar, username: string, password: string): Promise<any> {
  const resp = await fetchWithJar(backendUrl("/api/v1/auths/ldap"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: username, password }),
    jar,
    timeoutMs: 30000,
  });
  if (resp.status !== 200) {
    const text = (await resp.text()).slice(0, 300);
    throw new Error(`Open WebUI LDAP 登录失败（HTTP ${resp.status}）: ${text}`);
  }
  const data = (await resp.json()) as Record<string, any>;
  if (!data.token) throw new Error("Open WebUI LDAP 登录响应缺少 token");
  return data;
}

// ---------- 统一入口 ----------

/**
 * 完整双层登录：WebVPN CAS → Open WebUI LDAP。
 */
export async function login(username: string, password: string): Promise<LoginResult> {
  const jar = new CookieJar();

  // 第 1 层：WebVPN
  const loginPage = await fetchLoginPage(jar);
  if (!isLoginPage(loginPage)) throw new Error("未能取得统一认证登录页，WebVPN 响应异常");
  const [ok] = await submitWebvpnLogin(jar, username, password, loginPage);
  if (!ok) throw new Error("WebVPN 登录失败：账号密码错误或需要二次认证");

  // 第 2 层：Open WebUI LDAP
  const userData = await ldapSignin(jar, username, password);

  return {
    jar,
    cookies: jar.toObject(),
    token: userData.token || "",
    tokenType: userData.token_type || "Bearer",
    user: userData,
    expires: new Date(),
  };
}

/** 交互式登录：提示输入 UJN 校园账号与密码（隐藏输入）。 */
export async function loginInteractive(): Promise<LoginResult> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const username = (await rl.question("请输入 UJN 账号（学号/工号）: ")).trim();
  // 隐藏密码输入：关闭 echo 后逐字符读取
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write("请输入密码: ");
  const password = await new Promise<string>((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString()) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.removeListener("data", onData);
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          process.stdout.write("\n");
          resolve(buf);
          return;
        }
        if (ch === "\u0003") {
          process.stdin.removeListener("data", onData);
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          process.exit(130);
        }
        if (ch === "\u007f") {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
        process.stdout.write("*");
      }
    };
    process.stdin.on("data", onData);
    process.stdin.resume();
  });
  rl.close();
  return login(username, password);
}

/** 把持久化的 cookie 写回一个 jar（用于免登录重启）。 */
export function loadCookiesIntoJar(jar: CookieJar, cookies: Record<string, string>): CookieJar {
  for (const [name, value] of Object.entries(cookies || {})) {
    jar.cookies.set(name, value);
  }
  return jar;
}
