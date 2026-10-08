/**
 * 路径分隔符归一化回归（门禁跨平台正确性，Windows 误报复现）。
 *
 * 复现的两类系统性误报（不是代码缺陷，是门禁脚本自己在 Windows 上判错）：
 *   ① check-links 的 fsExistsCaseSensitive 用 `absPath.split('/')` 切 Windows 反斜杠
 *      绝对路径 → 一整条路径被当成一个目录名 → 「路径不存在」误报（实测 930 条，
 *      连 `scripts/release.mjs`、`skills/development-lifecycle` 这种真实存在的路径都被报缺失）；
 *   ② check-test-sleeps 的基线指纹 key：基线存正斜杠、扫描输出是 `relative()` 给的
 *      反斜杠 → 完全失配 → 存量全部被判成「新增固定等待」（实测 68 处误报）。
 *
 * 判据必须保持不变的部分也一并钉死：归一化**只**消除分隔符差异，
 * 大小写敏感判定（DOCS/索引.md 不得命中 docs/索引.md）与基线「只允许变少」语义不许被削弱。
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { fsExistsCaseSensitive, runCheck, REPO_ROOT } from '../check-links.mjs'
import { auditWaits, fingerprint } from '../lib/test-sleeps.mjs'

/** runCheck/findings 只用到 dirCache（大小写敏感判定的目录项缓存）。 */
const ctx = () => ({ dirCache: new Map() })

describe('check-links：绝对路径存在性判定必须认得本平台的路径分隔符', () => {
  it('真实存在文件的本机绝对路径 → 命中（复现：Windows 下整条路径被当成一个目录名）', () => {
    // join 按本平台拼装：Windows 是 D:\...\release.mjs，POSIX 是 /.../release.mjs
    const abs = join(REPO_ROOT, 'scripts', 'release.mjs')
    expect(fsExistsCaseSensitive(ctx(), abs)).toBe(true)
    const dir = join(REPO_ROOT, 'skills', 'development-lifecycle')
    expect(fsExistsCaseSensitive(ctx(), dir)).toBe(true)
  })

  it('大小写写错仍判不存在（归一化不许削弱大小写敏感判据）', () => {
    const wrongCase = join(REPO_ROOT, 'Scripts', 'release.mjs')
    expect(fsExistsCaseSensitive(ctx(), wrongCase)).toBe(false)
  })

  it('`..` 与重复分隔符不破坏判定（归一化实现要处理段语义，不是简单 replace）', () => {
    const viaDotdot = join(REPO_ROOT, 'scripts', '..', 'scripts', 'release.mjs')
    expect(fsExistsCaseSensitive(ctx(), viaDotdot)).toBe(true)
    const missing = join(REPO_ROOT, 'scripts', 'no-such-file.mjs')
    expect(fsExistsCaseSensitive(ctx(), missing)).toBe(false)
  })

  it('端到端：对本仓库跑 runCheck，不再把真实存在的路径报成「不存在」', () => {
    const result = runCheck({ root: REPO_ROOT })
    const realTargets = /scripts[\\/]release\.mjs|skills[\\/]development-lifecycle/
    const falseMisses = result.findings.filter((f) => realTargets.test(`${f.target ?? ''} ${f.detail ?? ''}`))
    expect(falseMisses.map((f) => `${f.file}:${f.line} ${f.target}`)).toEqual([])
  })
})

describe('check-test-sleeps：基线指纹 key 与路径分隔符无关', () => {
  it('fingerprint 对 `plugins/x/...` 与 `plugins\\x\\...` 生成同一 key', () => {
    expect(fingerprint('plugins\\dsh-shared\\test\\a.mjs', 'await settle(80)')).toBe(
      fingerprint('plugins/dsh-shared/test/a.mjs', 'await settle(80)'),
    )
  })

  const fixedWait = () => ({
    line: 3,
    text: 'await settle(80)',
    callee: 'settle',
    category: 'fixed',
    delay: 80,
    exempt: false,
    reason: undefined,
  })
  const baselineKey = fingerprint('plugins/dsh-shared/test/resource-guard.mjs', 'await settle(80)')

  it('扫描输出为反斜杠（Windows relative()）时仍能命中正斜杠基线（复现：68 处误报）', () => {
    const entries = [{ file: 'plugins\\dsh-shared\\test\\resource-guard.mjs', waits: [fixedWait()] }]
    const result = auditWaits(entries, [baselineKey])
    expect(result.violations).toEqual([])
    expect(result.staleBaseline).toEqual([])
  })

  it('反向：基线条目本身带反斜杠时同样命中（两端都归一化）', () => {
    const entries = [{ file: 'plugins/dsh-shared/test/resource-guard.mjs', waits: [fixedWait()] }]
    const windowsKey = baselineKey.replace(/\//g, '\\')
    const result = auditWaits(entries, [windowsKey])
    expect(result.violations).toEqual([])
    expect(result.staleBaseline).toEqual([])
  })

  it('基线外的新增固定等待仍必须报违规（防止归一化把「新增即拦」改没）', () => {
    const entries = [{ file: 'plugins\\x\\test\\new.mjs', waits: [fixedWait()] }]
    const result = auditWaits(entries, [])
    expect(result.violations).toHaveLength(1)
  })

  it('基线里已删除的条目仍报 stale（防止归一化把「只允许变少」改没）', () => {
    const entries = [{ file: 'plugins\\x\\test\\a.mjs', waits: [] }]
    const result = auditWaits(entries, ['plugins/x/test/gone.mjs::deadbeef'])
    expect(result.staleBaseline).toEqual(['plugins/x/test/gone.mjs::deadbeef'])
  })
})
