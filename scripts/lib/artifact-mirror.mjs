/**
 * artifact-mirror.mjs — `git archive HEAD` 快照的 Node 原生解包与镜像建立（issue #355）。
 *
 * 存在的理由：check-client-artifacts 的只读重建（issue #336）原先用
 * `bash -c 'git archive HEAD | tar -x -C "$TMP"'`——本机 bash 是 WSL bash，不认
 * `D:\...` 形式的 Windows 路径，整项失败；而 `tar` 也不是任何平台都有的前置。
 * 这里改成：git.exe（Git for Windows 自带，PATH 上直接可执行）产出 tar 字节流 →
 * **Node 自己解析 tar 落盘**，零 shell、零外部解压工具，任何平台行为一致。
 *
 * 安全判据（tar 是不可信输入形态，尽管来源是本地 git）：
 *   · 绝对路径 / `..` 段 → 直接拒绝（越界写盘）；
 *   · 所有写入 resolve 后必须仍在目标目录内。
 *
 * 判据由 scripts/test/artifacts-mirror.test.mjs 钉死（含 pax 长路径、ustar 段名、越界拒绝）。
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

const BLOCK = 512
/** git archive 的 tar 上限缓冲（仓库快照远小于此；超了直接失败，不静默截断）。 */
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024

const readStr = (block, offset, length) => {
  const slice = block.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8')
}
const readOctal = (block, offset, length) => {
  const text = readStr(block, offset, length).replace(/[\s\0]+/g, '')
  if (!text) return 0
  const value = Number.parseInt(text, 8)
  return Number.isFinite(value) ? value : 0
}
const isZeroBlock = (block) => {
  for (const byte of block) if (byte !== 0) return false
  return true
}

/** pax 记录：`<总字节数> 关键字=值\n`（总长含自身）。取关心的 path / linkpath。 */
function parsePaxRecords(data) {
  const out = {}
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number.parseInt(data.subarray(offset, space).toString('utf8'), 10)
    if (!Number.isFinite(length) || length <= 0 || offset + length > data.length) break
    const record = data.subarray(space + 1, offset + length).toString('utf8')
    const eq = record.indexOf('=')
    if (eq > 0) out[record.slice(0, eq).trim()] = record.slice(eq + 1).replace(/\n$/, '')
    offset += length
  }
  return out
}

/** 越界判定：绝对路径（POSIX/盘符）或 `..` 段一律拒绝；通过后再 resolve 复核。 */
function safeTarget(destDir, relPath) {
  const norm = String(relPath).replace(/\\/g, '/')
  if (/^([a-zA-Z]:)?[/]/.test(norm) || norm.split('/').includes('..')) {
    throw new Error(`归档内发现越界路径，已拒绝：${relPath}`)
  }
  const base = resolve(destDir)
  const target = resolve(base, norm)
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`归档内发现越界路径，已拒绝：${relPath}`)
  }
  return target
}

/**
 * 解析 tar 字节流并落盘到 destDir（必须已存在/由调用方创建）。
 * 支持：常规文件、目录、pax（`x`）扩展头的 path/linkpath、GNU（`L`）长文件名、ustar prefix 段。
 * @returns {string[]} 落盘的文件相对路径（目录不计入）。
 */
export function extractTar(buffer, destDir) {
  const files = []
  let offset = 0
  let pendingPax = null
  let pendingLongName = null
  while (offset + BLOCK <= buffer.length) {
    const block = buffer.subarray(offset, offset + BLOCK)
    offset += BLOCK
    if (isZeroBlock(block)) break // 首个全零块 = 归档结束
    const size = readOctal(block, 124, 12)
    const type = String.fromCharCode(block[156] || 0x30)
    const mode = readOctal(block, 100, 8) || 0o644
    const rawName = readStr(block, 0, 100)
    const prefix = readStr(block, 345, 155)
    const rawLink = readStr(block, 157, 100)
    const dataLength = Math.ceil(size / BLOCK) * BLOCK
    const data = buffer.subarray(offset, offset + size)
    offset += dataLength

    if (type === 'x' || type === 'X') {
      pendingPax = parsePaxRecords(data)
      continue
    }
    if (type === 'g') continue // 全局 pax 头：只含元数据，不参与路径
    if (type === 'L') {
      pendingLongName = data.toString('utf8').replace(/[\0\n]+$/, '')
      continue
    }

    const relName =
      pendingPax?.path ??
      pendingLongName ??
      (prefix && String(readStr(block, 257, 6)).startsWith('ustar') ? `${prefix}/${rawName}` : rawName)
    const linkTarget = pendingPax?.linkpath ?? rawLink
    pendingPax = null
    pendingLongName = null
    if (!relName) continue

    const target = safeTarget(destDir, relName)
    if (type === '5') {
      mkdirSync(target, { recursive: true })
      continue
    }
    if (type === '0' || type === '7') {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, data)
      try {
        chmodSync(target, mode & 0o777)
      } catch {
        /* Windows 上执行位无意义，失败不影响内容判定 */
      }
      files.push(relName.replace(/\\/g, '/'))
      continue
    }
    if (type === '2') {
      mkdirSync(dirname(target), { recursive: true })
      symlinkSync(linkTarget, target) // 无特权环境会抛错 → fail-closed（不静默降级）
      continue
    }
    throw new Error(`归档内出现不支持的条目类型 ${type}（${relName}）——按 fail-closed 处理`)
  }
  return files
}

/**
 * 在 destDir 建立「HEAD 快照 + 源仓库 node_modules 软链」镜像（只读契约 issue #336：
 * 一切重建都在镜像里做，源仓库零写入）。
 * 幂等：先清空 destDir 再重建（残留的陈旧产物会让漂移检查假通过）。
 */
export function createGitArchiveMirror(sourceRoot, destDir) {
  if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true })
  mkdirSync(destDir, { recursive: true })
  // `-c core.autocrlf=false`：镜像必须是 **CI 形态**（blob 原样 LF）。win32 checkout 常见
  // `core.autocrlf=true`，git archive 会按工作树语义输出 CRLF——镜像里 HEAD 自带的校验
  // （如 mermaid 引擎 SHA256 冻结值按 LF 计算）必然 mismatch，tsc/build 产物与 blob 的
  // 逐字节比对也随之失真：同一次提交 CI（LF）绿、本地镜像红，正是「本地绿 ⇒ CI 绿」要防的。
  const archive = spawnSync('git', ['-c', 'core.autocrlf=false', 'archive', '--format=tar', 'HEAD'], {
    cwd: sourceRoot,
    encoding: 'buffer',
    maxBuffer: MAX_ARCHIVE_BYTES,
    windowsHide: true,
  })
  if (archive.error) throw new Error(`git archive 无法执行：${archive.error.message}`)
  if (archive.status !== 0) {
    throw new Error(`git archive HEAD 失败（exit ${archive.status}）：${String(archive.stderr ?? '').slice(0, 300)}`)
  }
  extractTar(archive.stdout, destDir)

  const modules = join(sourceRoot, 'node_modules')
  if (existsSync(modules)) {
    const link = join(destDir, 'node_modules')
    try {
      symlinkSync(modules, link, 'dir')
    } catch {
      // Windows 无开发者模式时普通符号链接需特权 → junction（只需目录 + 绝对路径，两个平台都可用）
      symlinkSync(modules, link, 'junction')
    }
  }
  return destDir
}

/** 镜像内容清单（相对路径，正斜杠归一）——供漂移比对与测试断言复用。 */
export function listMirrorFiles(destDir, base = destDir) {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, name.name)
      if (name.isDirectory()) walk(abs)
      else out.push(abs.slice(base.length + 1).replace(/\\/g, '/'))
    }
  }
  walk(destDir)
  return out.sort()
}
