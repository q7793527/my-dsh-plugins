/**
 * 本地工具链跨平台调用复现测试（npm / npx / tsc 怎么被启动）。
 *
 * 复现的系统性失败（Windows + Node 24，`npm run verify` 24 项里 11 项因此红）：
 *   ① `spawn('npm', ...)` / `spawn('npx', ...)` → ENOENT：npm 在 Windows 上只有
 *      npm.cmd/npm.ps1，不是可直接 exec 的文件；Node 24 对无 shell 的 .cmd/.bat
 *      派生还会直接 EINVAL（见 check-pack-hygiene 的 spawn EINVAL）。
 *   ② `node_modules/.bin/tsc` 是 POSIX shell 脚本，Windows 上不存在同名可执行文件
 *      （真实入口是 .bin/tsc.cmd → ../typescript/bin/tsc）→ 18 个 typecheck 任务全部 ENOENT。
 *
 * 修法判据：统一走「Node 自己启动 JS cli 入口」——`process.execPath + npm 的 bin/npm-cli.js`，
 * 不依赖 .cmd 包装、不依赖 shell。本文件钉死的就是这条调用链在**本平台真的能跑起来**。
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPlugin } from '../check-pack-hygiene.mjs'
import { resolveToolInvocation } from '../lib/local-toolchain.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const env = { ...process.env, npm_config_update_notifier: 'false', NODE_OPTIONS: '' }

/** 按 resolveToolInvocation 的解析结果真实 spawn 一次（这就是门禁脚本内部做的事）。 */
function spawnTool(name, args, options = {}) {
  const inv = resolveToolInvocation(name, options)
  return spawnSync(inv.file, [...inv.prefixArgs, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    shell: inv.shell === true,
    env,
    cwd: options.cwd ?? REPO_ROOT,
  })
}

describe('resolveToolInvocation：npm / npx / tsc 的启动方式必须在本平台可执行', () => {
  it('npm --version 能跑起来（复现：spawn "npm" 在 Windows 直接 ENOENT）', () => {
    const r = spawnTool('npm', ['--version'])
    expect(r.error, String(r.error)).toBeUndefined()
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('npx --version 能跑起来（复现：verify 里 8 个 npx 检查项全部 spawn npx ENOENT）', () => {
    const r = spawnTool('npx', ['--version'])
    expect(r.error, String(r.error)).toBeUndefined()
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('本地 typescript 的 tsc --version 能跑起来（复现：.bin/tsc 在 Windows ENOENT）', () => {
    const r = spawnTool('tsc', ['--version'], { projectRoot: REPO_ROOT })
    expect(r.error, String(r.error)).toBeUndefined()
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Version')
  })

  it('npm 走「node 直跑 JS 入口」，不依赖 shell / .cmd 包装（判据：kind 钉死）', () => {
    const inv = resolveToolInvocation('npm')
    expect(inv.kind).toBe('node-cli')
    expect(inv.shell).not.toBe(true)
    expect(inv.prefixArgs.length).toBeGreaterThan(0)
    expect(existsSync(inv.prefixArgs[0])).toBe(true)
  })
})

describe('check-pack-hygiene：npm pack 在本平台真的执行（复现：spawn EINVAL 整项失败）', () => {
  it('单插件判定不再以「无法执行 npm」中止', async () => {
    const result = await checkPlugin({ root: REPO_ROOT, plugin: 'dsh-ts-example' })
    expect(result.aborted, `aborted: ${result.aborted}`).toBeUndefined()
    expect(result.packedPaths.length).toBeGreaterThan(0)
  })
})

describe('typecheck-all：18 个 TS 任务不再全部 ENOENT', () => {
  it('--json 模式下每个任务都真实执行且通过', () => {
    const r = spawnSync('node', ['scripts/typecheck-all.mjs', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      env,
    })
    expect(r.status, r.stderr.slice(-2000)).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.ok).toBe(true)
    expect(parsed.checks.length).toBeGreaterThan(0)
    expect(parsed.checks.every((c) => c.ok)).toBe(true)
  })
})

describe('verify-local：插件测试项通过 npm 真实启动（复现：20 个插件全 ENOENT）', () => {
  it('--only test --plugin dsh-ts-example 退出 0', () => {
    const r = spawnSync('node', ['scripts/verify-local.mjs', '--only', 'test', '--plugin', 'dsh-ts-example'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 180_000,
      env,
    })
    expect(r.status, `${r.stdout.slice(-3000)}\n${r.stderr.slice(-3000)}`).toBe(0)
  }, 200_000)
})
