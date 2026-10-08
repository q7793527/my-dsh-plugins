/**
 * 测试里「真实执行 bash 脚本」（抽自 workflow 的 run 段）的跨平台入口。
 *
 * win32 上存在两类 bash：
 *  - WSL（C:\Windows\System32\bash.exe）：认 `/mnt/d/...`，**不认** `D:\x\y.sh` 形式的脚本参数；
 *  - Git Bash（MSYS）：把 win 路径参数与 win PATH 自动转成 POSIX 形态，能直接跑。
 * 所以 Windows 只认 Git Bash；找不到 → BASH=null，调用方必须 `skipIf` 显式跳过
 * （vitest 报告 skipped 而非静默假绿）。
 */
import { existsSync } from 'node:fs'
import { delimiter } from 'node:path'

const GIT_BASH_CANDIDATES = [
  process.env.GIT_BASH_BIN,
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
]

function resolveBash() {
  if (process.platform !== 'win32') return 'bash'
  for (const candidate of GIT_BASH_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

/** 可执行 bash 的命令；null = 本机没有能吃 win 路径的 bash。 */
export const BASH = resolveBash()
export const HAS_BASH = BASH !== null

/** 把目录插到 PATH 最前（win 分隔符 `;`，POSIX `:`）。 */
export function pathWithPrefix(dir) {
  return `${dir}${delimiter}${process.env.PATH ?? ''}`
}
