/**
 * Unit tests for the bash command file-op parser (lib/bash-parse.js).
 *
 * 覆盖：分段（&& / || / ; / | / 引号保护）、命令→动作映射（rm/touch/mv/
 * cp/install/tee/sed -i）、重定向（> / >> / 2>，排除 & 与 /dev/）、cd 基准
 * 跟踪、路径净化（$ / glob / 子命令 / ~ 展开）与去重。核心原则：宁可漏报
 * 也不误报——不确定的命令/路径一律跳过。
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { resolve, normalize } from 'node:path'
import { parseBashFileOps, splitSegments, tokenize } from '../lib/bash-parse.js'

const P = '/work'

/**
 * 期望路径与实现同源解析（issue #355）：
 *  - p：相对参数按 base 解析 → win `D:\work\…`、posix `/work/…`（实现 resolveSafe 同款）；
 *  - abs：输入本身就是绝对 posix 路径 → 实现只做 normalize（win `\usr\…`、无盘符）。
 * 两个平台下断言语义（「解析出的绝对路径」）都钉得住。
 */
const p = (...segments) => resolve(...segments)
const abs = (path) => normalize(path)

function ops(command, baseDir = P) {
  return parseBashFileOps(command, baseDir)
}

function pathsOf(command, baseDir = P) {
  return ops(command, baseDir).map((op) => `${op.op}:${op.path}`)
}

test('segment splitting respects quotes and separators', () => {
  assert.deepEqual(splitSegments('rm a && touch b'), ['rm a', 'touch b'])
  assert.deepEqual(splitSegments('echo hi; ls'), ['echo hi', 'ls'])
  assert.deepEqual(splitSegments('cat x | tee y'), ['cat x', 'tee y'])
  assert.deepEqual(splitSegments("cd 'a && b' && ls"), ["cd 'a && b'", 'ls'])
  assert.deepEqual(splitSegments('ls 2>&1'), ['ls 2>&1'], '2>&1 stays one segment')
  assert.deepEqual(splitSegments('rm a & touch b'), ['rm a', 'touch b'])
  assert.deepEqual(splitSegments(''), [])
  assert.deepEqual(splitSegments('  '), [])
})

test('tokenize strips quotes and flags unsafe words', () => {
  assert.deepEqual(tokenize("echo 'a b' c"), [
    { text: 'echo', safe: true },
    { text: 'a b', safe: true },
    { text: 'c', safe: true },
  ])
  const unsafe = tokenize('rm $FILE *.js "$HOME/x" `cmd` {a,b}.txt')
  assert.deepEqual(
    unsafe.map((t) => t.safe),
    [true, false, false, false, false, false],
  )
  assert.deepEqual(tokenize('touch a\\ b.txt'), [
    { text: 'touch', safe: true },
    { text: 'a b.txt', safe: true },
  ])
})

test('rm deletes; touch creates (write op); options are skipped', () => {
  assert.deepEqual(pathsOf('rm a.js'), [`delete:${p('/work/a.js')}`])
  assert.deepEqual(pathsOf('rm -rf src/tmp.js'), [`delete:${p('/work/src/tmp.js')}`])
  assert.deepEqual(pathsOf('rm --force -- a.js b.js'), [`delete:${p('/work/a.js')}`, `delete:${p('/work/b.js')}`])
  assert.deepEqual(pathsOf('touch dist/out.txt'), [`write:${p('/work/dist/out.txt')}`])
  assert.deepEqual(pathsOf('touch -d 2026-01-01 f.txt'), [`write:${p('/work/f.txt')}`])
  assert.deepEqual(ops('rm'), [], 'rm without paths records nothing')
})

test('mv: source delete + destination write', () => {
  assert.deepEqual(pathsOf('mv a.js b.js'), [`delete:${p('/work/a.js')}`, `write:${p('/work/b.js')}`])
  assert.deepEqual(pathsOf('mv a b c'), [`delete:${p('/work/a')}`, `delete:${p('/work/b')}`, `write:${p('/work/c')}`])
  assert.deepEqual(pathsOf('mv -t /work/dst a.js'), [], '-t target-directory variants are skipped (conservative)')
})

test('cp / install / tee write their destination', () => {
  assert.deepEqual(pathsOf('cp a.js b.js'), [`write:${p('/work/b.js')}`])
  assert.deepEqual(pathsOf('install -m 755 a.js /usr/local/bin/a'), [`write:${abs('/usr/local/bin/a')}`])
  assert.deepEqual(pathsOf('tee out.log err.log'), [`write:${p('/work/out.log')}`, `write:${p('/work/err.log')}`])
})

test('sed only with -i (also -i.bak) writes the file', () => {
  assert.deepEqual(pathsOf("sed -i 's/x/y/' f.txt"), [`write:${p('/work/f.txt')}`])
  assert.deepEqual(pathsOf("sed -i.bak 's/x/y/' f.txt"), [`write:${p('/work/f.txt')}`])
  assert.deepEqual(ops("sed 's/x/y/' f.txt"), [], 'sed without -i does not modify the file')
})

test('redirections: > / >> / 2> write the target; fd & /dev/null skipped', () => {
  assert.deepEqual(pathsOf('echo hello > out.txt'), [`write:${p('/work/out.txt')}`])
  assert.deepEqual(pathsOf('echo x >> log.txt'), [`write:${p('/work/log.txt')}`])
  assert.deepEqual(pathsOf('node s.js > app.log 2>&1'), [`write:${p('/work/app.log')}`])
  assert.deepEqual(pathsOf('cmd 2> err.log'), [`write:${p('/work/err.log')}`])
  assert.deepEqual(ops('ls > /dev/null'), [], '/dev/null is not a tracked file')
  assert.deepEqual(ops('echo x >&1'), [], 'fd redirection is not a file write')
  assert.deepEqual(pathsOf('echo "a > b" > f.txt'), [`write:${p('/work/f.txt')}`], 'quoted > is not a redirect')
})

test('unknown / read-only commands record nothing without redirects', () => {
  assert.deepEqual(ops('cat a.txt'), [])
  assert.deepEqual(ops('npm install'), [])
  assert.deepEqual(ops('git rm x'), [])
  assert.deepEqual(ops('mkdir -p dist'), [], 'mkdir creates directories, not tracked files')
  assert.deepEqual(ops('node script.js'), [])
  assert.deepEqual(ops('ls -la'), [])
})

test('unsafe paths (variables / globs / substitution) are never recorded', () => {
  assert.deepEqual(ops('rm $FILE'), [])
  assert.deepEqual(ops('rm *.js'), [])
  assert.deepEqual(ops('touch "$HOME/x"'), [])
  assert.deepEqual(ops('rm $(pwd)/f'), [])
  assert.deepEqual(ops('rm `echo f`'), [])
  assert.deepEqual(ops('touch {a,b}.js'), [])
})

test('cd segments update the base for the following segments', () => {
  assert.deepEqual(pathsOf('cd sub && rm old.js'), [`delete:${p('/work/sub/old.js')}`])
  assert.deepEqual(pathsOf('cd /tmp/x; touch f'), [`write:${p('/tmp/x/f')}`])
  assert.deepEqual(pathsOf('cd ../up; rm a'), [`delete:${p('/up/a')}`])
})

test('~ expands to the home directory', () => {
  assert.deepEqual(pathsOf('touch ~/x.txt'), [`write:${p(homedir(), 'x.txt')}`])
  assert.deepEqual(pathsOf('rm ~/.dsh/f.json'), [`delete:${p(homedir(), '.dsh', 'f.json')}`])
})

test('absolute and relative paths resolve against the base dir', () => {
  assert.deepEqual(pathsOf('touch /tmp/x.bin'), [`write:${abs('/tmp/x.bin')}`])
  assert.deepEqual(pathsOf('touch sub/f.txt', '/home/u/proj'), [`write:${p('/home/u/proj/sub/f.txt')}`])
})

test('duplicate ops are deduped', () => {
  assert.deepEqual(pathsOf('rm a && rm a'), [`delete:${p('/work/a')}`])
  assert.deepEqual(pathsOf('touch a && echo x > a'), [`write:${p('/work/a')}`])
})

test('prefix wrappers (sudo/env) and VAR= assignments are skipped', () => {
  assert.deepEqual(pathsOf('sudo rm a'), [`delete:${p('/work/a')}`])
  assert.deepEqual(pathsOf('env FOO=1 rm a'), [`delete:${p('/work/a')}`])
  assert.deepEqual(pathsOf('FOO=bar touch a'), [`write:${p('/work/a')}`])
  assert.deepEqual(pathsOf('nohup cp a b &'), [`write:${p('/work/b')}`])
})

console.log('ALL BASH-PARSE TESTS PASSED')
