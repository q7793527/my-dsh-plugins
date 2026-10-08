/**
 * 构建产物镜像复现测试（check-client-artifacts 的只读重建路径）。
 *
 * 复现的系统性失败（Windows）：镜像建立依赖 `bash -c 'git archive HEAD | tar -x ...'`，
 * 本机 bash 是 WSL bash，不认 `D:\...` 形式的 Windows 路径 → 整个 artifacts 检查项失败。
 * 修法：`git archive --format=tar` 输出直接用 **Node 原生 tar 解析**落盘，彻底去掉 bash 管道
 * （Git for Windows 自带的 git.exe 在 PATH 上，与 shell 无关）。
 *
 * 钉死三件事：
 *   ① extractTar 的格式正确性（含 ustar 段名、pax 长路径、目录、越界路径拒绝）——
 *      解析错了会把「产物漂移」判错方向，比没有门禁更危险；
 *   ② createGitArchiveMirror 端到端：镜像 = HEAD 快照 + 可用的 node_modules 链接；
 *   ③ 只读契约的方向性：镜像落在指定目录，不往源仓库写。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGitArchiveMirror, extractTar } from '../lib/artifact-mirror.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const tempDirs = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-mirror-'))
  tempDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

// ── 最小 tar 构造器（测试夹具，独立于被测实现）────────────────────────────────
function header({ name, size, type = '0', mode = 0o644 }) {
  const buf = Buffer.alloc(512)
  buf.write(name, 0, 100, 'utf8')
  buf.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'utf8')
  buf.write('0000000\0', 107, 8, 'utf8')
  buf.write('0000000\0', 116, 8, 'utf8')
  buf.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8')
  buf.write('00000000000\0', 136, 12, 'utf8')
  buf.write('        ', 148, 8, 'utf8') // 校验和占位（空格）
  buf.write(type, 156, 1, 'utf8')
  buf.write('ustar\0', 257, 6, 'utf8')
  buf.write('00', 263, 2, 'utf8')
  let sum = 0
  for (const b of buf) sum += b
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8')
  return buf
}
function entry({ name, data = '', type = '0', mode = 0o644 }) {
  const payload = Buffer.from(data, 'utf8')
  const padding = Buffer.alloc((512 - (payload.length % 512)) % 512)
  return Buffer.concat([header({ name, size: payload.length, type, mode }), payload, padding])
}
/** pax 扩展头：`<总长> path=<值>\n`，总长含自身前缀（长度按字节数）。 */
function paxPathRecord(target) {
  const body = ` path=${target}\n`
  const head = String(body.length + 3).padStart(3, '0')
  const record = `${head}${body}`
  return Buffer.byteLength(record) === Number(head) ? record : record
}
const endOfArchive = () => Buffer.alloc(1024)

describe('extractTar：Node 原生解析（替代 bash 管道的格式正确性）', () => {
  it('普通文件与目录落盘，内容逐字节一致', () => {
    const dest = tempDir()
    const tar = Buffer.concat([
      entry({ name: 'dir/', type: '5', mode: 0o755 }),
      entry({ name: 'dir/hello.txt', data: '你好, world\n' }),
      entry({ name: 'dir/run.sh', data: '#!/bin/sh\ntrue\n', mode: 0o755 }),
      endOfArchive(),
    ])
    const files = extractTar(tar, dest)
    expect(readFileSync(join(dest, 'dir', 'hello.txt'), 'utf8')).toBe('你好, world\n')
    expect(readFileSync(join(dest, 'dir', 'run.sh'), 'utf8')).toBe('#!/bin/sh\ntrue\n')
    expect(files.sort()).toEqual(['dir/hello.txt', 'dir/run.sh'])
  })

  it('pax 长路径（path= 记录）正确落到完整路径', () => {
    const dest = tempDir()
    const longPath = `deep/${'nested/'.repeat(20)}leaf.mjs`
    const paxData = paxPathRecord(longPath)
    const tar = Buffer.concat([
      entry({ name: './PaxHeaders/leaf', data: paxData, type: 'x' }),
      entry({ name: 'truncated.mjs', data: 'export const x = 1\n' }),
      endOfArchive(),
    ])
    extractTar(tar, dest)
    expect(readFileSync(join(dest, longPath), 'utf8')).toBe('export const x = 1\n')
  })

  it('ustar prefix 段（155 字节前缀）拼接出完整路径', () => {
    const dest = tempDir()
    const buf = Buffer.concat([header({ name: 'leaf.js', size: 0 }), Buffer.alloc(512)])
    buf.write('a-really-long-directory-name', 345, 155, 'utf8')
    extractTar(Buffer.concat([buf, endOfArchive()]), dest)
    expect(existsSync(join(dest, 'a-really-long-directory-name', 'leaf.js'))).toBe(true)
  })

  it('越界路径（../ 逃逸 / 绝对路径）直接拒绝，绝不写到目标目录之外', () => {
    const dest = tempDir()
    const escape = Buffer.concat([entry({ name: '../evil.txt', data: 'x' }), endOfArchive()])
    expect(() => extractTar(escape, dest)).toThrow(/越界|拒绝/)
    const absolute = Buffer.concat([entry({ name: '/etc/evil.txt', data: 'x' }), endOfArchive()])
    expect(() => extractTar(absolute, dest)).toThrow(/越界|拒绝/)
    expect(existsSync(join(dest, '..', 'evil.txt'))).toBe(false)
  })
})

describe('createGitArchiveMirror：端到端（本仓库 HEAD 快照）', () => {
  it('镜像含 HEAD 的已提交文件，且 node_modules 链接可用', () => {
    const dest = tempDir()
    createGitArchiveMirror(REPO_ROOT, dest)
    // HEAD 快照里的真实文件（复现：旧实现经 WSL bash 解包在此平台失败）。
    // 行尾归一后比较：core.autocrlf=true 的机器上 git archive 给 CRLF（checkout 形态），
    // `git show` 给 blob 原始 LF——比的是代码内容一致，不是行尾字节（Linux CI 同判据通过）。
    const sameText = (buf) => buf.toString('utf8').replace(/\r\n/g, '\n')
    expect(existsSync(join(dest, 'scripts', 'release.mjs'))).toBe(true)
    expect(sameText(readFileSync(join(dest, 'scripts', 'release.mjs')))).toBe(
      sameText(execFileSync('git', ['show', 'HEAD:scripts/release.mjs'])),
    )
    // node_modules 必须可用（build.mjs 的 tsc/prettier 依赖它）
    expect(existsSync(join(dest, 'node_modules', 'typescript', 'package.json'))).toBe(true)
    // 工作区未提交的改动不得进入镜像（镜像 = HEAD，不是工作区）
    const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' })
    if (dirty.stdout.trim().length > 0) {
      expect(existsSync(join(dest, 'scripts', 'test', 'paths-normalization.test.mjs'))).toBe(false)
    }
  })

  it('目标目录必须先清空重建（残留会让陈旧产物假通过）', () => {
    const dest = tempDir()
    mkdirSync(join(dest, 'stale-dir'), { recursive: true })
    writeFileSync(join(dest, 'stale-dir', 'stale.txt'), 'old')
    createGitArchiveMirror(REPO_ROOT, dest)
    expect(existsSync(join(dest, 'stale-dir'))).toBe(false)
    expect(existsSync(join(dest, 'scripts', 'release.mjs'))).toBe(true)
  })

  it('分隔符无关：镜像内路径统一按本平台 sep 组装可读', () => {
    const dest = tempDir()
    createGitArchiveMirror(REPO_ROOT, dest)
    expect(existsSync([dest, 'plugins'].join(sep))).toBe(true)
  })
})
