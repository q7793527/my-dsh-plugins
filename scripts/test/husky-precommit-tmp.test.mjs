/**
 * husky pre-commit 临时文件的可移植性回归（Windows 上 pre-commit 门禁实际失效的复现）。
 *
 * 复现的缺陷（实测报错）：
 *     mktemp: too few X's in template ‘lint-staged-status’
 *     husky - pre-commit script failed (code 1)
 * Git for Windows 自带 coreutils 的 mktemp 不接受裸 `-t NAME`（模板必须含 ≥6 个 X），
 * 而 husky 的 .husky/_/h 以 `sh -e` 执行 hook（errexit 生效）：脚本在**创建临时文件**
 * 这一步就终止，于是 lint-staged 正常路径 → index.lock 竞争重试 → 只读降级兜底
 * 三层逻辑一层都没跑，pre-commit 门禁静默失效、提交被挡。
 *
 * 钉死的判据（修完不许被削弱）：
 *   ① hook 不得再依赖裸 `mktemp -t`；临时文件必须可移植且唯一、且退出时被清理；
 *   ② 三层门禁结构必须还在（lint-staged / 备份失败指纹 / degraded_check）；
 *   ③ `npx --no-install lint-staged` 必须保持为真实命令文本——knip 会解析 hook 文本
 *      判定 devDependencies 是否被使用，简写成变量会让 CI 的 dead code 门禁变红。
 */
import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const HOOK_PATH = join(REPO_ROOT, '.husky', 'pre-commit')
const hookText = readFileSync(HOOK_PATH, 'utf8')

/** 从 hook 文本里取出「临时文件创建 + 清理」这段真实脚本（测的就是线上那份文本）。 */
function tmpSetupBlock(text) {
  const wanted = /^(git_dir|status_file=|out_file=|cleanup_tmp\(\)|trap cleanup_tmp)/
  return text
    .split(/\r?\n/)
    .filter((line) => wanted.test(line.trim()))
    .join('\n')
}

/** 找到本平台可用的 POSIX sh：非 Windows 直接用 sh，Windows 用 Git 自带的那个。 */
function runsAsSh(candidate) {
  if (!candidate) return null
  const probe = spawnSync(candidate, ['-c', 'echo ok'], { encoding: 'utf8' })
  return probe.status === 0 && probe.stdout?.trim() === 'ok' ? candidate : null
}

function findSh() {
  if (process.platform !== 'win32') return runsAsSh('sh')
  const probe = spawnSync('git', ['--exec-path'], { encoding: 'utf8' })
  const starts = [process.env.GIT_SH, 'C:\\Program Files\\Git', probe.stdout?.trim()].filter(Boolean)
  const candidates = []
  for (const start of starts) {
    let dir = start
    for (let depth = 0; depth < 6 && dir; depth++) {
      for (const rel of [join('usr', 'bin', 'sh.exe'), join('bin', 'sh.exe')]) candidates.push(join(dir, rel))
      dir = dirname(dir)
    }
  }
  return candidates.map(runsAsSh).find(Boolean) ?? null
}

const sh = findSh()

/**
 * 模拟真实 hook 运行环境：git 执行 hook 时 PATH 会注入 git 自带的 usr/bin（rm、grep 等
 * 基础工具所在），而从测试进程直接 spawn sh 时 PATH 未必包含它。把 sh 所在目录置顶即可等价。
 */
const shEnv = sh ? { ...process.env, PATH: `${dirname(sh)}${delimiter}${process.env.PATH ?? ''}` } : process.env

describe('husky pre-commit：临时文件创建必须在 Windows 的 sh 里也能跑', () => {
  it('hook 不再使用裸 `mktemp -t`（复现：Git for Windows 的 mktemp 直接报错）', () => {
    const offenders = hookText
      .split(/\r?\n/)
      .map((line, i) => ({ line, no: i + 1 }))
      .filter(({ line }) => /mktemp\s+-t\s/.test(line))
    expect(offenders.map(({ no, line }) => `${no}: ${line.trim()}`)).toEqual([])
  })

  it('临时文件写法必须自带唯一后缀与 trap 清理（否则并发提交会互相覆盖）', () => {
    const block = tmpSetupBlock(hookText)
    expect(block).toMatch(/\$\$/)
    expect(block).toMatch(/trap cleanup_tmp EXIT/)
  })

  it('用本平台 sh 实跑这段脚本：创建成功、两次运行的路径不同、退出后被清理', () => {
    const block = tmpSetupBlock(hookText)
    const script = [block, ': > "$status_file"', ': > "$out_file"', 'echo "$status_file"', 'echo "$out_file"'].join(
      '\n',
    )
    const first = spawnSync(sh, ['-e', '-c', script], { encoding: 'utf8', cwd: REPO_ROOT, env: shEnv })
    expect(first.status, `sh 报错：${first.stderr}`).toBe(0)
    const [a1, b1] = first.stdout.trim().split('\n')
    expect(a1).toBeTruthy()
    expect(b1).toBeTruthy()
    expect(a1).not.toBe(b1)

    const second = spawnSync(sh, ['-e', '-c', script], { encoding: 'utf8', cwd: REPO_ROOT, env: shEnv })
    expect(second.status, `sh 报错：${second.stderr}`).toBe(0)
    const [a2] = second.stdout.trim().split('\n')
    // 唯一性：不同进程（$$ 不同）不得撞同一个文件
    expect(a2).not.toBe(a1)

    // trap 清理：脚本退出后这两个文件都不许留下
    expect(existsSync(a1)).toBe(false)
    expect(existsSync(b1)).toBe(false)
  }, 30_000)

  it('三层门禁结构必须原样保留（修临时文件不许把门禁改没）', () => {
    expect(hookText).toMatch(/run_lint_staged\(\)/)
    expect(hookText).toMatch(/Failed to back up original state/)
    expect(hookText).toMatch(/degraded_check\(\)/)
    expect(hookText).toMatch(/if run_lint_staged; then/)
  })

  it('`npx --no-install lint-staged` 必须仍是真实命令文本（knip 靠它判定 devDependencies）', () => {
    expect(hookText).toMatch(/\(\s*npx --no-install lint-staged/)
  })
})

/**
 * 端到端复现：把 mktemp 换成「必然失败的 GNU 报错 stub」（`too few X's`，exit 1）放进 PATH
 * 最前，再用 `sh -e` 完整执行线上那份 .husky/pre-commit —— 即实测缺陷发生时的精确环境。
 * 修复前脚本会在这一步被 errexit 打断（exit 1、lint-staged 一次都没跑）；
 * 修复后必须走通完整三层逻辑。
 */
describe('端到端：mktemp 不可用（GNU 报错 stub）时完整 hook 仍能工作', () => {
  /** 构造临时 git 仓库 + lint-staged stub + 坏 mktemp stub，返回运行环境与清理函数。 */
  function makeHookEnv({ lintStaged }) {
    const root = mkdtempSync(join(tmpdir(), 'husky-pre-commit-e2e-'))
    const cleanup = () => rmSync(root, { recursive: true, force: true })
    try {
      execFileSync('git', ['init', '-q'], { cwd: root })
      const binDir = join(root, 'node_modules', '.bin')
      mkdirSync(binDir, { recursive: true })
      const stub = join(binDir, 'lint-staged')
      writeFileSync(stub, `#!/bin/sh\n${lintStaged}\n`)
      execFileSync(join(dirname(sh), 'chmod'), ['+x', stub])
      writeFileSync(join(root, 'pre-commit'), hookText)
      // 必然失败的 mktemp：复现 Git for Windows/coreutils 的 `too few X's` 拒绝
      const stubBin = join(root, 'stub-bin')
      mkdirSync(stubBin, { recursive: true })
      writeFileSync(join(stubBin, 'mktemp'), `#!/bin/sh\necho "mktemp: too few X's in template '$2'" >&2\nexit 1\n`)
      const env = {
        ...process.env,
        PATH: [stubBin, dirname(sh), process.env.PATH].filter(Boolean).join(delimiter),
      }
      return { root, env, cleanup }
    } catch (err) {
      cleanup()
      throw err
    }
  }

  function runHook({ lintStaged }) {
    const { root, env, cleanup } = makeHookEnv({ lintStaged })
    try {
      return spawnSync(sh, ['-e', join(root, 'pre-commit')], { encoding: 'utf8', cwd: root, env, timeout: 30_000 })
    } finally {
      cleanup()
    }
  }

  it('正常路径：lint-staged 真实被执行、hook 退出 0、mktemp stub 一次都没被调用', () => {
    const r = runHook({ lintStaged: 'echo "lint-staged ran" && exit 0' })
    expect(r.status, `stdout=${r.stdout}\nstderr=${r.stderr}`).toBe(0)
    expect(r.stdout).toContain('lint-staged ran')
    expect(r.stderr).not.toContain('too few X')
  }, 30_000)

  it('竞争重试 + 降级路径可达：备份失败指纹出现两次后走 degraded_check，空暂存放行退出 0', () => {
    const r = runHook({ lintStaged: 'echo "Failed to back up original state!" && exit 1' })
    expect(r.status, `stdout=${r.stdout}\nstderr=${r.stderr}`).toBe(0)
    expect(r.stdout).toContain('等待 1s 后自动重试一次')
    expect(r.stdout).toContain('降级检查通过')
    expect(r.stderr).not.toContain('too few X')
  }, 30_000)
})
