/**
 * .husky/pre-commit 临时文件创建的跨平台复现测试（Git for Windows mktemp 语义差异）。
 *
 * 复现的真实事故（leader 提交时实测）：
 *     mktemp: too few X's in template 'lint-staged-status'
 *     husky - pre-commit script failed (code 1)
 * Git for Windows 自带 coreutils 的 mktemp 不接受裸 `-t NAME`（模板必须含 ≥6 个 X），
 * 而 husky 的 .husky/_/h 以 `sh -e` 执行 hook —— errexit 让脚本在创建临时文件这一步就
 * 终止，三层门禁（lint-staged 正常路径 → index.lock 竞争重试 → 只读降级检查）一层都没跑。
 *
 * 判据（两层，缺一不可）：
 *   ① 静态：hook 代码行不得再调用 mktemp，全文不得出现裸 mktemp -t；三处临时文件必须
 *      落在 `git rev-parse --git-path <name>` 所在目录并以 `$$` 后缀唯一化，`trap ... EXIT`
 *      清理保留；三层逻辑与 `npx --no-install lint-staged` 字面命令保持（knip 的 husky
 *      插件解析 hook 文本判定 devDependencies，简写成变量会报 Unused → CI 红）。
 *   ② 动态（本机有 Git for Windows sh.exe 时）：把 hook 里的创建/清理行**原样提取**出来，
 *      在 `sh -e`（模拟 husky）+「mktemp 必失败」的 PATH stub 下实跑：仍能创建、路径落在
 *      git 目录、并发唯一、trap 清理生效；并顺带复现旧写法（裸 mktemp）在本机确实失败。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOOK_PATH = join(REPO_ROOT, '.husky', 'pre-commit')

// 统一 LF：Windows 上若工作树是 CRLF，行尾 \r 会污染提取出的 sh 片段与断言
const hookText = readFileSync(HOOK_PATH, 'utf8').replace(/\r\n/g, '\n')
const codeLines = hookText.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))
const code = codeLines.join('\n')

/** 提取 sh 命令行（滤掉空行与整行注释），用于「只读/字面命令」类断言。 */
const commandLines = (body) =>
  body.filter((l) => l.trim() !== '' && !l.trim().startsWith('#') && !l.trim().startsWith('echo '))

/** 提取 `name() { ... }` 函数体（按「独占一行的 }」结束）。 */
function functionLines(name) {
  const lines = hookText.split('\n')
  const start = lines.findIndex((l) => l.startsWith(`${name}() {`))
  expect(start, `hook 中找不到函数 ${name}() {`).toBeGreaterThanOrEqual(0)
  const end = lines.findIndex((l, i) => i > start && l === '}')
  expect(end, `函数 ${name} 缺少结束 }`).toBeGreaterThan(start)
  return lines.slice(start, end + 1)
}

// ── 动态实证环境：Git for Windows 的 sh.exe（本机可用时才跑动态用例）────────────
function findSh() {
  const candidates = [
    'C:\\Program Files\\Git\\usr\\bin\\sh.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\sh.exe',
    'C:\\Program Files\\Git\\bin\\sh.exe',
  ]
  for (const c of candidates) if (existsSync(c)) return c
  for (const dir of (process.env.PATH ?? '').split(';')) {
    if (!dir) continue
    const p = join(dir, 'sh.exe')
    if (existsSync(p)) return p
  }
  return null
}
const SH = findSh()
const DYNAMIC = Boolean(SH)

// 真实 husky 环境里 PATH 由 git.exe（Git for Windows）注入，含 usr/bin 的 coreutils；
// 直接 spawn sh.exe 继承的是 node 的 PATH（通常只有 Git\cmd），rm/mktemp 会 command not found。
// 这里按 sh.exe 位置显式补齐 usr/bin + mingw64/bin + cmd，复刻 hook 的真实运行环境。
const shBinDir = SH ? dirname(SH) : null
const gitRoot = SH ? dirname(dirname(shBinDir)) : null
const dynamicPath = SH
  ? [shBinDir, join(gitRoot, 'mingw64', 'bin'), join(gitRoot, 'cmd'), process.env.PATH].join(';')
  : undefined
const dynamicEnv = (extra = {}) => (SH ? { ...process.env, PATH: dynamicPath, ...extra } : undefined)

let tmpRoot = DYNAMIC ? mkdtempSync(join(tmpdir(), 'dsh-hook-tmpfiles-')) : null
// 本机 TEMP 可能是 8.3 短路径（ADMINI~1）：先归一成规范长路径，避免与 git 输出长短不一
if (tmpRoot) tmpRoot = realpathSync.native(tmpRoot)
const repoDir = tmpRoot ? join(tmpRoot, 'repo') : null
const stubBin = tmpRoot ? join(tmpRoot, 'stub-bin') : null
// sh 内 PATH 按 `:` split，盘符冒号（C:）会被切开 —— stub 路径必须转成 POSIX 盘符形式
const toPosix = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):\//, '/$1/')
const stubPosix = stubBin ? toPosix(stubBin) : null
const markerPath = repoDir ? join(repoDir, 'mktemp-called.marker') : null

/** 本机裸 mktemp 行为探测（复现证据）：Git for Windows 下应失败并报 too few X's。 */
let bareMktempProbe = null

if (DYNAMIC) {
  mkdirSync(repoDir)
  const init = spawnSync('git', ['init', '-q', repoDir], { encoding: 'utf8', timeout: 30_000 })
  if (init.status !== 0) throw new Error(`git init 失败（动态用例前置）：${init.stderr}`)

  // mktemp 必失败的 PATH stub：复刻 Git for Windows 的失败语义（exit 1 + too few X's）
  mkdirSync(stubBin)
  writeFileSync(
    join(stubBin, 'mktemp'),
    `#!/bin/sh\necho mktemp-stub-called > mktemp-called.marker\necho "mktemp: too few X's in template 'stub'" >&2\nexit 1\n`,
  )

  bareMktempProbe = spawnSync(SH, ['-c', 'mktemp -t lint-staged-status'], {
    encoding: 'utf8',
    timeout: 15_000,
    env: dynamicEnv({ TMPDIR: toPosix(tmpRoot) }),
  })
}

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
})

const runSh = (body, name = 'snippet.sh') => {
  const file = join(tmpRoot, name)
  writeFileSync(file, body)
  return spawnSync(SH, ['-e', file], {
    cwd: repoDir,
    encoding: 'utf8',
    timeout: 20_000,
    env: dynamicEnv({ STUB_BIN: stubPosix }),
  })
}
const clearMarker = () => rmSync(markerPath, { force: true })
const markerCalled = () => existsSync(markerPath)
const gitAbsoluteDir = () =>
  spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: repoDir, encoding: 'utf8' }).stdout.trim()

/** hook 中 git 目录派生行（写法 B 时需要一并提取，否则片段里 git_dir 为空）。 */
const gitDirSnippet = () => (hookText.match(/^git_dir=.*$/gm) ?? []).join('\n')

/** hook 中 status/out 的创建 + 清理行（原样提取，保证测试跑的就是 hook 里的写法）。 */
function creationSnippet() {
  const grab = (re) => {
    const ms = hookText.match(re)
    expect(ms, `hook 中提取不到 ${re}`).not.toBeNull()
    return ms
  }
  return [
    gitDirSnippet(),
    ...grab(/^status_file=.*$/gm),
    ...grab(/^out_file=.*$/gm),
    grab(/^cleanup_tmp\(\).*$/m)[0],
    grab(/^trap cleanup_tmp EXIT$/m)[0],
  ]
    .filter((l) => l !== '')
    .join('\n')
}

function listSnippet() {
  const create = hookText.match(/^\s+list=.*$/gm)
  const createFile = hookText.match(/^\s+git -c core\.quotepath=false diff --cached.*$/gm)
  const cleanup = hookText.match(/^\s+rm -f "\$list".*$/gm)
  expect(create, 'hook 中提取不到 degraded_check 的 list 创建行').not.toBeNull()
  expect(createFile, 'hook 中提取不到 degraded_check 的 list 创建（重定向）行').not.toBeNull()
  expect(cleanup, 'hook 中提取不到 degraded_check 的 list 清理行').not.toBeNull()
  return {
    gitDir: gitDirSnippet(),
    create: create.join('\n'),
    createFile: createFile.join('\n'),
    cleanup: cleanup.join('\n'),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 静态判据：hook 文本（修复前必红 —— 三处 mktemp 写法当场命中）
// ─────────────────────────────────────────────────────────────────────────────

describe('.husky/pre-commit 临时文件写法（静态判据）', () => {
  it("代码行不再调用 mktemp，全文不出现裸 'mktemp -t'", () => {
    expect(
      codeLines.filter((l) => l.includes('mktemp')),
      'hook 代码行里仍有 mktemp 调用',
    ).toEqual([])
    expect(hookText).not.toContain('mktemp -t')
  })

  const spots = [
    { name: 'status_file', gitName: 'lint-staged-status' },
    { name: 'out_file', gitName: 'lint-staged-out' },
    { name: 'list', gitName: 'lint-staged-files' },
  ]
  for (const s of spots) {
    it(`${s.name} 落在 git rev-parse --git-path 派生的目录下并以 $$ 唯一化`, () => {
      // 两种等价写法均认可：
      //   A: name=$(git rev-parse --git-path <name> ...) → name="$name.$$"
      //   B: git_dir=$(git rev-parse --git-path . ...)   → name="$git_dir/<name>.$$"
      const direct = new RegExp(`\\b${s.name}=\\$\\(git rev-parse --git-path ${s.gitName}\\b`)
      const viaDir = new RegExp(`${s.name}="\\$git_dir/${s.gitName}\\.\\$\\$"`)
      if (direct.test(code)) {
        expect(code).toMatch(new RegExp(`${s.name}="\\$${s.name}\\.\\$\\$"`))
      } else {
        expect(
          viaDir.test(code),
          `${s.name} 既不经 git rev-parse --git-path ${s.gitName} 派生，也不在 git 目录下带 $$ 后缀`,
        ).toBe(true)
        // 走目录派生就必须真调 git rev-parse --git-path（禁止硬编码 .git 相对路径）
        expect(code).toMatch(/git_dir=\$\(git rev-parse --git-path \./)
      }
    })
  }

  it('trap ... EXIT 清理保留，且覆盖 status/out 两个临时文件', () => {
    expect(code).toMatch(/^trap cleanup_tmp EXIT$/m)
    const def = code.match(/^cleanup_tmp\(\) \{.*\}$/m)
    expect(def, 'cleanup_tmp() 定义缺失').not.toBeNull()
    expect(def[0]).toContain('$status_file')
    expect(def[0]).toContain('$out_file')
  })
})

describe('三层门禁语义保持（本次修复不许削弱 hook 行为）', () => {
  it('正常路径 → 等 1s 重试 → 只读降级：调用顺序与备份失败指纹原样', () => {
    const first = code.indexOf('if run_lint_staged; then')
    const retry = code.indexOf('sleep 1')
    const second = code.indexOf('if run_lint_staged; then', first + 1)
    expect(first, '缺少第一次 run_lint_staged 调用').toBeGreaterThanOrEqual(0)
    expect(second, '缺少重试的第二次 run_lint_staged 调用').toBeGreaterThan(first)
    expect(retry, '缺少重试等待').toBeGreaterThan(first)
    expect(retry, 'sleep 1 必须在两次 run_lint_staged 之间').toBeLessThan(second)
    expect(code).toMatch(/if ! stash_backup_failed; then/)
    expect(code).toContain("grep -q 'Failed to back up original state'")
    expect(code).toMatch(/^degraded_check\(\) \{$/m)
    expect(code).toMatch(/if degraded_check; then/)
  })

  it('降级检查保持只读：eslint 走 --fix-dry-run、prettier 走 --check，不许出现 --write 或裸 --fix', () => {
    const cmds = commandLines(functionLines('degraded_check'))
    expect(cmds.join('\n')).toContain('--fix-dry-run')
    expect(cmds.join('\n')).toMatch(/--check/)
    expect(cmds.join('\n'), '降级路径出现写操作参数').not.toMatch(/(?<!-)--fix(?!-)/)
    expect(cmds.join('\n'), '降级路径出现写操作参数').not.toContain(' --write')
  })

  it('`npx --no-install lint-staged` 仍是字面命令（knip 由它判定 devDependencies）', () => {
    expect(code).toContain('npx --no-install lint-staged')
  })

  it('暂存清单来源保持 git diff --cached --diff-filter=ACMR', () => {
    expect(code).toContain('diff --cached --name-only --diff-filter=ACMR')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ② 动态实证：Git for Windows sh.exe 实跑（husky sh -e + mktemp 必失败）
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DYNAMIC)('动态实证：sh -e 实跑 hook 的创建/清理片段', () => {
  it.runIf(bareMktempProbe?.status !== 0 && bareMktempProbe !== null)(
    "复现：本机裸 mktemp -t NAME 确实失败（too few X's）—— 旧 hook 就死在这一步",
    () => {
      expect(bareMktempProbe.status).not.toBe(0)
      expect(bareMktempProbe.stderr).toContain("too few X's")
    },
  )

  it('控制用例：PATH stub 里的 mktemp 本身可被 sh 调用，且其失败经 errexit 传播（否则「未调 mktemp」是假绿）', () => {
    clearMarker()
    const r = runSh(`PATH="$STUB_BIN:$PATH"\nmktemp -t anything\nexit 7\n`, 'stub-control.sh')
    // stub exit 1 + sh -e → 脚本在 mktemp 处就终止（正是旧 hook 事故的失败传播路径）
    expect(r.status).toBe(1)
    expect(markerCalled(), 'stub mktemp 未被调用，stub 环境无效').toBe(true)
    expect(r.stderr).toContain("too few X's")
  })

  it('修复证明：mktemp 必失败时，hook 片段仍创建成功、路径在 git 目录、trap 清理生效', () => {
    clearMarker()
    const script = `PATH="$STUB_BIN:$PATH"
${creationSnippet()}
: > "$status_file"
: > "$out_file"
test -f "$status_file" || exit 9
test -f "$out_file" || exit 9
printf '%s\\n%s\\n' "$status_file" "$out_file"
`
    const r = runSh(script, 'create-cleanup.sh')
    expect(r.status, `片段失败：\n${r.stderr}\n${r.stdout}`).toBe(0)
    expect(markerCalled(), '创建过程仍调用了 mktemp').toBe(false)

    const [f1, f2] = r.stdout.trim().split(/\r?\n/)
    expect(f1, `片段未输出 status_file：${r.stdout}`).toBeTruthy()
    expect(f2, `片段未输出 out_file：${r.stdout}`).toBeTruthy()
    expect(f1).not.toBe(f2)

    // native realpath 归一：msys git / 8.3 短路径（ADMINI~1）与 node 长路径不直接可比
    const gitDir = realpathSync.native(gitAbsoluteDir())
    expect(realpathSync.native(dirname(resolve(repoDir, f1))), 'status_file 不在 git 目录下').toBe(gitDir)
    expect(realpathSync.native(dirname(resolve(repoDir, f2))), 'out_file 不在 git 目录下').toBe(gitDir)

    // trap EXIT：sh 正常退出时已清理
    expect(existsSync(resolve(repoDir, f1)), 'status_file 未被 trap 清理').toBe(false)
    expect(existsSync(resolve(repoDir, f2)), 'out_file 未被 trap 清理').toBe(false)
  })

  it('修复证明：degraded_check 的临时清单同样不依赖 mktemp，创建后可清理', () => {
    clearMarker()
    const { gitDir, create, createFile, cleanup } = listSnippet()
    const script = `PATH="$STUB_BIN:$PATH"
${gitDir}
${create}
${createFile}
test -f "$list" || exit 9
printf '%s\\n' "$list"
${cleanup}
`
    const r = runSh(script, 'list-create.sh')
    expect(r.status, `片段失败：\n${r.stderr}\n${r.stdout}`).toBe(0)
    expect(markerCalled(), '清单创建过程仍调用了 mktemp').toBe(false)

    const listPath = r.stdout.trim()
    expect(listPath, `片段未输出 list：${r.stdout}`).toBeTruthy()
    expect(realpathSync.native(dirname(resolve(repoDir, listPath))), 'list 不在 git 目录下').toBe(
      realpathSync.native(gitAbsoluteDir()),
    )
    expect(existsSync(resolve(repoDir, listPath)), 'list 未被 rm -f 清理').toBe(false)
  })

  it('唯一性：两个独立 hook 进程创建的路径互不相同（$$ 后缀）', () => {
    const script = `PATH="$STUB_BIN:$PATH"
${creationSnippet()}
printf '%s\\n' "$status_file"
`
    const r1 = runSh(script, 'unique-1.sh')
    const r2 = runSh(script, 'unique-2.sh')
    expect(r1.status, r1.stderr).toBe(0)
    expect(r2.status, r2.stderr).toBe(0)
    expect(r1.stdout.trim()).not.toBe(r2.stdout.trim())
  })
})
