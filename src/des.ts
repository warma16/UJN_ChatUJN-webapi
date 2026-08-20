/**
 * 深澜统一认证 DES 加密（strEnc）—— TypeScript 移植自 uniform_login_des.py。
 *
 * 算法 = 自定义 64 位密钥位重排（fixMutatedKey，UJN_PC1_MAP）+ 标准 DES
 * （ECB，无填充，每 4 字符 UTF-16-BE 一块，缺位补 \0）。用 BigInt 逐行
 * 对照移植，行为与 Python 版完全一致（登录时仅调用一次，无性能压力，
 * 故不做查找表优化，直接写标准 DES 轮函数更易读、更不易错）。
 * 感谢 github@furtz12 github@szw0407 github@zeroHYH 这三位的数据和灵感提供 
 * 这三位的仓库在https://github.com/futz12/SDU_DeepSeek
 * 本仓库代码经由这个仓库的启发经过vibe coding而来
 */

// ---- 查表（与 Python 版逐元素一致）----

const UJN_PC1_MAP: readonly number[] = [
  0, 1, 2, 6, 38, 37, 36, 7,
  8, 9, 10, 14, 46, 45, 44, 15,
  16, 17, 18, 22, 54, 53, 52, 23,
  24, 25, 26, 30, 62, 61, 60, 31,
  32, 33, 34, 35, 5, 4, 3, 39,
  40, 41, 42, 43, 13, 12, 11, 47,
  48, 49, 50, 51, 21, 20, 19, 55,
  56, 57, 58, 59, 29, 28, 27, 63,
];

const IP: readonly number[] = [
  58, 50, 42, 34, 26, 18, 10, 2,
  60, 52, 44, 36, 28, 20, 12, 4,
  62, 54, 46, 38, 30, 22, 14, 6,
  64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17, 9, 1,
  59, 51, 43, 35, 27, 19, 11, 3,
  61, 53, 45, 37, 29, 21, 13, 5,
  63, 55, 47, 39, 31, 23, 15, 7,
];

const FP: readonly number[] = [
  40, 8, 48, 16, 56, 24, 64, 32,
  39, 7, 47, 15, 55, 23, 63, 31,
  38, 6, 46, 14, 54, 22, 62, 30,
  37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28,
  35, 3, 43, 11, 51, 19, 59, 27,
  34, 2, 42, 10, 50, 18, 58, 26,
  33, 1, 41, 9, 49, 17, 57, 25,
];

const E: readonly number[] = [
  32, 1, 2, 3, 4, 5,
  4, 5, 6, 7, 8, 9,
  8, 9, 10, 11, 12, 13,
  12, 13, 14, 15, 16, 17,
  16, 17, 18, 19, 20, 21,
  20, 21, 22, 23, 24, 25,
  24, 25, 26, 27, 28, 29,
  28, 29, 30, 31, 32, 1,
];

const P: readonly number[] = [
  16, 7, 20, 21,
  29, 12, 28, 17,
  1, 15, 23, 26,
  5, 18, 31, 10,
  2, 8, 24, 14,
  32, 27, 3, 9,
  19, 13, 30, 6,
  22, 11, 4, 25,
];

const PC1: readonly number[] = [
  57, 49, 41, 33, 25, 17, 9,
  1, 58, 50, 42, 34, 26, 18,
  10, 2, 59, 51, 43, 35, 27,
  19, 11, 3, 60, 52, 44, 36,
  63, 55, 47, 39, 31, 23, 15,
  7, 62, 54, 46, 38, 30, 22,
  14, 6, 61, 53, 45, 37, 29,
  21, 13, 5, 28, 20, 12, 4,
];

const PC2: readonly number[] = [
  14, 17, 11, 24, 1, 5,
  3, 28, 15, 6, 21, 10,
  23, 19, 12, 4, 26, 8,
  16, 7, 27, 20, 13, 2,
  41, 52, 31, 37, 47, 55,
  30, 40, 51, 45, 33, 48,
  44, 49, 39, 56, 34, 53,
  46, 42, 50, 36, 29, 32,
];

const SHIFTS: readonly number[] = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];

const UBOX: readonly (readonly (readonly number[])[])[] = [
  [
    [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7],
    [0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8],
    [4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0],
    [15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  ],
  [
    [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10],
    [3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5],
    [0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15],
    [13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  ],
  [
    [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8],
    [13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1],
    [13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7],
    [1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  ],
  [
    [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15],
    [13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9],
    [10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4],
    [3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  ],
  [
    [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9],
    [14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6],
    [4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14],
    [11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  ],
  [
    [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11],
    [10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8],
    [9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6],
    [4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  ],
  [
    [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1],
    [13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6],
    [1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2],
    [6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  ],
  [
    [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7],
    [1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2],
    [7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8],
    [2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
  ],
];

// ---- 基础位运算 ----

/** 按 table 置换：x 左起 inBits 位，第 table[i] 位搬到输出第 i 位（1-based 表）。 */
function permute(x: bigint, inBits: number, table: readonly number[]): bigint {
  let y = 0n;
  const n = table.length;
  for (let i = 0; i < n; i++) {
    const bit = (x >> BigInt(inBits - table[i])) & 1n;
    y |= bit << BigInt(n - 1 - i);
  }
  return y;
}

/** 28 位循环左移 n 位。 */
function rol28(v: bigint, n: number): bigint {
  v &= 0x0fffffffn;
  const bn = BigInt(n);
  return ((v << bn) & 0x0fffffffn) | (v >> BigInt(28 - n));
}

/** 由 64 位密钥生成 16 轮 48 位子密钥（标准 DES 密钥调度）。 */
function subkeysFromKey64(key64: bigint): bigint[] {
  const k56 = permute(key64, 64, PC1);
  let c = (k56 >> 28n) & 0x0fffffffn;
  let d = k56 & 0x0fffffffn;
  const out: bigint[] = [];
  for (const s of SHIFTS) {
    c = rol28(c, s);
    d = rol28(d, s);
    out.push(permute((c << 28n) | d, 56, PC2));
  }
  return out;
}

/** DES 轮函数 f(R, K)：E 扩展 → 异或 → 8 个 S 盒 → P 置换。 */
function feistel(r: bigint, k48: bigint): bigint {
  const x = permute(r, 32, E) ^ k48;
  let sOut = 0n;
  for (let i = 0; i < 8; i++) {
    const chunk = Number((x >> BigInt(42 - 6 * i)) & 0x3fn);
    const row = ((chunk & 0x20) >> 4) | (chunk & 0x01);
    const col = (chunk >> 1) & 0x0f;
    sOut |= BigInt(UBOX[i][row][col]) << BigInt(28 - 4 * i);
  }
  return permute(sOut, 32, P);
}

/** 单块 DES 加密（64 位 BigInt 进，64 位 BigInt 出）。 */
function desEncryptBlock(block64: bigint, subkeys: readonly bigint[]): bigint {
  let x = permute(block64, 64, IP);
  let l = (x >> 32n) & 0xffffffffn;
  let r = x & 0xffffffffn;
  for (const k48 of subkeys) {
    const f = feistel(r, k48);
    [l, r] = [r, l ^ f];
  }
  const pre = (r << 32n) | l; // 交换后装配，再 FP
  return permute(pre, 64, FP);
}

/** 深澜 CAS 专用的密钥位重排（UJN_PC1_MAP），重排后即标准 64 位 DES 密钥。 */
export function fixMutatedKey(kBytes: Uint8Array): bigint {
  let x = 0n;
  for (const b of kBytes) x = (x << 8n) | BigInt(b);
  let y = 0n;
  for (let dst = 0; dst < UJN_PC1_MAP.length; dst++) {
    const src = UJN_PC1_MAP[dst];
    y |= ((x >> BigInt(63 - src)) & 1n) << BigInt(63 - dst);
  }
  return y;
}

/** 取一个 4 字符 key 片段（不足补 \0），返回其 16 轮子密钥。 */
function keyPartSubkeys(k4: string): bigint[] {
  // Python: k4.encode("utf-16-be")；JS: utf16le + swap16 得到 BE。
  const buf = Buffer.from(k4, "utf16le").swap16();
  return subkeysFromKey64(fixMutatedKey(buf));
}

/**
 * 深澜统一认证加密：strEnc(data, key1, key2, key3)。
 *
 * 与 Python 行为完全一致：
 *   - 数据按 4 字符一块（UTF-16-BE + \0 填充为 8 字节）；
 *   - 依次用每个 key 的每个 4 字符片段（同样填充 + 密钥位重排）连续加密；
 *   - 输出每块 16 位大写十六进制拼接。
 */
export function strEnc(data: string, ...keys: string[]): string {
  if (!data) return "";
  // 收集所有 key 片段对应的子密钥集（顺序：key1 的每个片段，key2 的每个片段，...）
  const allSubkeySets: bigint[][] = [];
  for (const key of keys) {
    for (let i = 0; i < key.length; i += 4) {
      const k4 = (key.slice(i, i + 4) + "\0\0\0\0").slice(0, 4);
      allSubkeySets.push(keyPartSubkeys(k4));
    }
  }
  let out = "";
  for (let i = 0; i < data.length; i += 4) {
    const d4 = (data.slice(i, i + 4) + "\0\0\0\0").slice(0, 4);
    const buf = Buffer.from(d4, "utf16le").swap16();
    let block = 0n;
    for (const b of buf) block = (block << 8n) | BigInt(b);
    for (const sk of allSubkeySets) block = desEncryptBlock(block, sk);
    out += block.toString(16).toUpperCase().padStart(16, "0");
  }
  return out;
}

// ---- 测试辅助：导出单块/key 处理（仅供 test 对照）----
export const _internal = {
  permute,
  subkeysFromKey64,
  desEncryptBlock,
  fixMutatedKey,
};