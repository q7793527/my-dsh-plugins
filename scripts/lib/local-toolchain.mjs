/**
 * local-toolchain.mjs — 门禁脚本统一的「本地工具启动解析」（跨平台正确性，issue #355）。
 *
 * 存在的理由：Windows 上 npm/npx 只有 `npm.cmd`/`npm.ps1`，没有同名可直接 exec 的文件；
 * Node 24 出于 CVE-2024-27980 的缓解，**无 shell 派生 `.cmd`/`.bat` 直接 EINVAL**——
 * 于是 `spawn('npm')` → ENOENT、`spawn('npm.cmd')` → EINVAL，`node_modules/.bin/tsc`
 * 这类 POSIX shell 脚本同样不可执行（existsSync 命中但跑不起来）。
 *
 * 修法不是加 `shell: true`（会引入 cmd 二次解析/注入面，还会破坏带空格路径的参数边界），
 * 而是**用当前 node 直接跑 npm 自带的 JS 入口**：`process.execPath + npm/bin/npm-cli.js`。
 * 这条路径在任何平台语义一致，且与 `npm run` 注入的 `npm_execpath` 指向同一份代码。
 *
 * 判据由 scripts/test/local-toolchain.test.mjs 钉死（先红后绿的复现测试）。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 有「npm 包自带 JS cli」这层结构的工具名。 */
const NODE_CLI_TOOLS = new Set(['npm', 'npx'])

/**
 * 定位 npm 包内 `<name>-cli.js`。
 * 候选（逐个 existsSync 实测，不猜布局）：
 *   1. `npm_execpath`（`npm run` 注入，指向本次调用的 npm cli.js）同目录的 `<name>-cli.js`；
 *   2. `<dirname(process.execPath)>/node_modules/npm/bin/<name>-cli.js`
 *      （Windows 官方布局：node.exe 与 npm.cmd 同目录部署；便携 tarball 同样成立）。
 * 找不到返回 null（调用方回退；标准环境由测试断言走不到回退）。
 */
export function resolveNpmCli(name, { execPath = process.execPath, npmExecpath = process.env.npm_execpath } = {}) {
  const candidates = []
  if (typeof npmExecpath === 'string' && npmExecpath.length > 0) {
    candidates.push(join(dirname(npmExecpath), `${name}-cli.js`))
  }
  candidates.push(join(dirname(execPath), 'node_modules', 'npm', 'bin', `${name}-cli.js`))
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

/**
 * 解析工具的启动方式。
 * @returns {{kind:'node-cli'|'shell'|'path', file:string, prefixArgs:string[], args:string[], shell:boolean}}
 *   调用方统一按 `spawn(file, [...prefixArgs, ...args, ...调用参数], { shell })` 使用。
 */
export function resolveToolInvocation(name, options = {}) {
  const platform = options.platform ?? process.platform
  const execPath = options.execPath ?? process.execPath

  if (NODE_CLI_TOOLS.has(name)) {
    const cli = resolveNpmCli(name, { execPath, npmExecpath: options.npmExecpath })
    if (cli) return { kind: 'node-cli', file: execPath, prefixArgs: [cli], args: [], shell: false }
    // 回退（罕见）：显式交给 cmd 解析 .cmd 包装。参数固定、无用户输入面。
    if (platform === 'win32') return { kind: 'shell', file: `${name}.cmd`, prefixArgs: [], args: [], shell: true }
    return { kind: 'path', file: name, prefixArgs: [], args: [], shell: false }
  }

  if (name === 'tsc') {
    const root = options.projectRoot ?? process.cwd()
    const local = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
    // typescript/bin/tsc 是 JS 文件（`#!/usr/bin/env node` 入口），node 直接可跑；
    // `node_modules/.bin/tsc` 在 Windows 上是 shell 脚本、不可 exec，故完全不看 .bin。
    if (existsSync(local)) return { kind: 'node-cli', file: execPath, prefixArgs: [local], args: [], shell: false }
    const npx = resolveToolInvocation('npx', options)
    return { ...npx, prefixArgs: [...npx.prefixArgs, '--no-install', 'tsc'] }
  }

  return { kind: 'path', file: name, prefixArgs: [], args: [], shell: false }
}
