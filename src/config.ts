/**
 * UJN (济南大学) WebVPN 统一配置 —— TypeScript 移植自 ujn_config.py。
  * 感谢 github@furtz12 github@szw0407 github@zeroHYH 这三位的数据和灵感提供 
 * 这三位的仓库在https://github.com/futz12/SDU_DeepSeek
 * 本仓库代码经由这个仓库的启发经过vibe coding而来
 */

// ---- WebVPN 入口 ----
export const VPN_BASE: string = "https://webvpn.ujn.edu.cn";

// 模拟浏览器 UA
export const VPN_UA: string =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ---- 目标 AI 服务 host 加密串 ----
export const CHAT_HOST_WEBVPN: string =
  "77726476706e69737468656265737421f3ff40886925625e300d8db9d6562d";

// 后端 API 路径
export const CHAT_PATH: string = "/api/chat/completions";

// 组合后的 chat 端点（OpenAI 兼容）
export const CHAT_URL: string = `${VPN_BASE}/https/${CHAT_HOST_WEBVPN}${CHAT_PATH}`;

// ---- Anthropic 兼容端点 ----
// 对外暴露 Anthropic Messages 格式的路径（Claude Code 等客户端连这里）
export const ANTHROPIC_MESSAGES_PATH: string = "/v1/messages";

// 后端原生 Anthropic 路径（仅当 UJN_NATIVE_ANTHROPIC=1 时直通这里）。
// 默认 Open WebUI 后端不开放 Anthropic 格式，故默认走「Anthropic ⇄ OpenAI 转换」。
export const ANTHROPIC_BACKEND_PATH: string = process.env.UJN_ANTHROPIC_PATH ?? "/api/v1/messages";
// 是否尝试后端原生 Anthropic 直通（0/1）
export const NATIVE_ANTHROPIC: boolean = (process.env.UJN_NATIVE_ANTHROPIC ?? "0") === "1";

// ---- 统一身份认证网关 host 加密串（注释参考）----
export const TPASS_HOST_WEBVPN: string =
  "77726476706e69737468656265737421e3e44ed2323a661e7b0c9ce29b5b";

// ---- 配置/文件 ----
export const COOKIES_FILE: string = "./ujn_cookies.json";
export const CREDENTIALS_FILE: string = "./ujn_credentials.json";

// ---- 登录相关常量 ----
export const DES_KEYS: [string, string, string] = ["1", "2", "3"];

export const VPN_TICKET_COOKIE_PREFIX: string = "wengine_vpn_ticketwebvpn";
