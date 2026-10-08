/**
 * 跨平台「目录软链」helper。
 *
 * 为什么不能裸用 `symlinkSync(target, path)`：win32 创建符号链接需要特权
 * （开发者模式 / 管理员），无特权时 Node 抛 `EPERM` —— 本机（普通会话）实测全部失败，
 * 而 Linux/macOS CI 无此限制。于是「本地全绿」的链接逻辑在 Windows 上**直接崩**。
 *
 * 解法：win32 上改用 **junction**（目录联接）——只需目录 + 绝对路径、不需要特权，
 * 且语义与软链一致：`lstatSync().isSymbolicLink() === true`、`readlinkSync()` 返回
 * 传入的 target 原文、`realpathSync()` 解析到目标（悬空时抛 ENOENT，与软链同）。
 * POSIX 忽略 type 参数，仍走真软链（CI 判定不受影响）。
 *
 * 仅适用于**目录** target；文件软链在无特权 win32 无等价物，调用方自行处理。
 */
import { symlinkSync } from 'node:fs'

export function symlinkDir(target, linkPath) {
  if (process.platform !== 'win32') {
    symlinkSync(target, linkPath)
    return
  }
  try {
    symlinkSync(target, linkPath, 'junction')
  } catch (error) {
    // EEXIST：目标已存在——交给调用方的「已存在则先删」语义，不掩盖
    if (error.code === 'EEXIST') throw error
    // junction 不适用（相对 target / 卷挂载等极少数形态）→ 退回真软链（有特权时可用）
    symlinkSync(target, linkPath, 'dir')
  }
}
