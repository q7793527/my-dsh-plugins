/**
 * secret 扫描门禁「平台缺失」处置复现测试（gitleaks 预置 SHA256 不含本平台时怎么算）。
 *
 * 复现的系统性失败（Windows）：scripts/ci-tools.json 里 gitleaks 8.30.1 只钉了 CI 平台的
 * 校验值，本机 win32-x64 没有 → check-secrets 直接 fail（exit 2），本地门禁红得毫无信息量，
 * 而这条红与「代码里有没有泄漏 secret」完全无关。
 *
 * 判据（两边都不许放宽）：
 *   · 本地（非 CI）：明确打印「本地跳过：原因」+ 输出 [verify-skip] 标记 → verify-local 把它
 *     归入**未跑项清单**（不计入通过，也不计入失败）——不得静默通过；
 *   · CI：平台缺失 = 门禁配置坏了，仍然 fail-closed —— CI 上永远不许跳过。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decidePlatformSkip, toolRelease } from '../lib/gitleaks-scan.mjs'
import { parseLocalSkip, partitionResults } from '../lib/local-skip.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const tools = JSON.parse(readFileSync(join(REPO_ROOT, 'scripts', 'ci-tools.json'), 'utf8'))
const release = toolRelease(tools, 'gitleaks')

describe('decidePlatformSkip：平台缺失时的两端处置', () => {
  const unsupported = {
    ok: false,
    kind: 'platform-missing',
    reason: 'gitleaks 8.30.1 没有为平台 win32-x64 预置 SHA256（不支持的平台）',
  }

  it('本地跑：判「本地跳过」并带明确原因（不得静默、不得硬红）', () => {
    const verdict = decidePlatformSkip({ release: unsupported, isCi: false })
    expect(verdict.mode).toBe('skip')
    expect(verdict.reason).toContain('本地跳过')
    expect(verdict.reason).toContain('win32-x64')
  })

  it('CI 跑：仍然 fail-closed（平台缺失 = 配置坏了，CI 永不跳过）', () => {
    const verdict = decidePlatformSkip({ release: unsupported, isCi: true })
    expect(verdict.mode).toBe('fail')
    expect(verdict.reason).toMatch(/fail-closed|CI/)
  })

  it('平台有校验值：正常执行，不产生跳过', () => {
    const verdict = decidePlatformSkip({ release: { ok: true, version: '8.30.1', sha256: 'ab' }, isCi: false })
    expect(verdict.mode).toBe('proceed')
  })
})

describe('verify-local 的 [verify-skip] 归集（跳过必须出现在未跑清单里）', () => {
  it('从检查项输出里解析出本地跳过标记与原因', () => {
    const out =
      '[secrets] 本地跳过：gitleaks 8.30.1 没有为平台 win32-x64 预置 SHA256\n[verify-skip] gitleaks 8.30.1 没有为平台 win32-x64 预置 SHA256（不支持的平台）\n'
    expect(parseLocalSkip(out)).toContain('win32-x64')
  })

  it('没有标记 → null（普通通过的检查项不受影响）', () => {
    expect(parseLocalSkip('固定 sleep 门禁通过：133 个测试文件\n')).toBeNull()
    expect(parseLocalSkip('')).toBeNull()
  })

  it('结果分类：localSkip 项不计入通过、不计入失败，单列跳过清单', () => {
    const { passed, failed, localSkipped } = partitionResults([
      { id: 'a', ok: true },
      { id: 'b', ok: true, localSkip: '平台无 SHA256' },
      { id: 'c', ok: false, error: 'boom' },
    ])
    expect(passed.map((r) => r.id)).toEqual(['a'])
    expect(failed.map((r) => r.id)).toEqual(['c'])
    expect(localSkipped).toHaveLength(1)
    expect(localSkipped[0].id).toBe('b')
    expect(localSkipped[0].localSkip).toContain('SHA256')
  })
})

// CI 平台（linux-x64 有预置 SHA256）不适用本用例：那条路径由既有 secret-scan 测试覆盖。
describe.runIf(!release.ok)('check-secrets CLI：本平台缺失时真实退出行为（复现：exit 2 硬红）', () => {
  it('退出 0 + 打印「本地跳过」+ [verify-skip] 标记', () => {
    const r = spawnSync('node', ['scripts/check-secrets.mjs'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, NODE_OPTIONS: '' },
    })
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
    expect(`${r.stdout}${r.stderr}`).toContain('本地跳过')
    expect(r.stdout).toMatch(/\[verify-skip\] .+/)
  })

  it('跳过时绝不能输出「扫描通过」类结论（防止跳过被读成干净）', () => {
    const r = spawnSync('node', ['scripts/check-secrets.mjs'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, NODE_OPTIONS: '' },
    })
    expect(r.stdout).not.toMatch(/秘密扫描|扫描通过/)
  })
})

// ── 返工防回归：本地跳过不得吞掉两类「CI 必红」的缺陷 ────────────────────────
// 缺陷一：decidePlatformSkip 只看 release.ok === false，把「配置文件缺 gitleaks 条目」
// 与「平台无预置 SHA256」混为一谈 → 本地对配置缺陷也 exit 0 放行（文件注释却写着
// 「配置缺条目照旧走 fail()」）。
// 缺陷二：「配置版本 vs RELEASE_VERSION」漂移断言位于 skip 分支**之后**，本地跳过时
// 根本不执行（注释却写着「漂移检测与平台无关，必须照样生效」）。
describe('本地跳过不得吞掉配置缺陷（两种 false 必须区分 + 漂移检测不受跳过影响）', () => {
  const tmpDirs = []
  afterAll(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
  })

  /** 写一份测试专用 ci-tools.json 夹具，经 GITLEAKS_TOOLS_PATH 传给 CLI。 */
  function toolsFixture(obj) {
    const dir = mkdtempSync(join(tmpdir(), 'secrets-tools-'))
    tmpDirs.push(dir)
    const file = join(dir, 'ci-tools.json')
    writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`)
    return file
  }

  /** 跑 check-secrets CLI（纯配置路径用例，不触网：拿不到二进制之前就该出结论）。 */
  function runCli(extraEnv = {}) {
    const r = spawnSync('node', ['scripts/check-secrets.mjs'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, NODE_OPTIONS: '', ...extraEnv },
    })
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
  }

  it('toolRelease：配置缺条目与平台缺 SHA256 返回可区分的 kind（不靠字符串猜）', () => {
    expect(toolRelease({}, 'gitleaks').kind).toBe('config-missing')
    // win32-x64 永远不在 checksums 里（CI 只钉 linux/darwin）→ 跨平台稳定的平台缺失
    expect(toolRelease(tools, 'gitleaks', 'win32', 'x64').kind).toBe('platform-missing')
  })

  it('decidePlatformSkip：配置缺 gitleaks 条目 → 本地与 CI 都判 fail（不许 skip）', () => {
    const missing = toolRelease({}, 'gitleaks')
    expect(decidePlatformSkip({ release: missing, isCi: false }).mode).toBe('fail')
    expect(decidePlatformSkip({ release: missing, isCi: true }).mode).toBe('fail')
  })

  it('① 配置缺 gitleaks 条目 → 本地 CLI 也必须非 0（不许被当成平台缺失放行）', () => {
    const { status, out } = runCli({ GITLEAKS_TOOLS_PATH: toolsFixture({}) })
    expect(status, out).not.toBe(0)
    expect(out).toContain('ci-tools.json')
    expect(out).not.toContain('本地跳过')
  })

  it('③ 版本漂移在平台跳过路径上仍然被抓出（本地不许借跳过 exit 0）', () => {
    // version 与代码常量 RELEASE_VERSION 不同，且不含本平台条目（本机 win32）：
    // 修复前 → 先撞平台缺失 skip（exit 0），漂移断言根本不执行；修复后必须红。
    const drifted = { gitleaks: { version: '8.29.0', checksums: { 'linux-x64': 'aa' } } }
    const { status, out } = runCli({ GITLEAKS_TOOLS_PATH: toolsFixture(drifted) })
    expect(status, out).not.toBe(0)
    expect(out).toContain('版本漂移')
    expect(out).not.toContain('本地跳过')
  })
})
