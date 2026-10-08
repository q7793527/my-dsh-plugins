/**
 * gitleaks-scan.mjs — secret 扫描门禁的**纯判据件**（issue #324 需求 A）。
 *
 * 存在的理由：GitHub 原生 secret scanning 是**事后**告警，而本仓库已经踩过
 * 「告警看着有、其实被 auto_dismissed 静默关闭」的坑（见
 * docs/踩坑/npm-audit在镜像源下静默失效.md：4 条渠道同时失效，数周无人发现）。
 * 本门禁把判定前移到合并前：CI 与本地跑**同一个二进制、同一份配置**，命中即失败。
 *
 * 本模块只做**纯计算**（不含 spawn / 网络 / 文件 IO），便于单测覆盖三类关键语义：
 *   1. 平台与校验值（platformKey / toolRelease / verifyChecksum）——下载的产物必须与
 *      scripts/ci-tools.json 里钉死的 SHA256 一致，否则拒绝执行（供应链 fail-closed）；
 *   2. 报告净化（normalizeFindings / renderFindings / renderScanSummary）——**绝不回显明文**：
 *      只输出 文件:行:规则（+ 提交短 SHA）。这一点由 scripts/test/secret-scan.test.mjs 用
 *      「往夹具里塞真形态假密钥，断言 stdout/stderr 里搜不到它」的方式钉死；
 *   3. 退出判据（decideScanExit）——fail-closed：有 finding 判失败；
 *      显式给出 --allow-missing 且 gitleaks 不可用时才允许本地跳过（CI 永远不传该开关）。
 *
 * CLI（下载 / 校验 / 调用 gitleaks / 打印）在 scripts/check-secrets.mjs。
 */

/** 平台键 → scripts/ci-tools.json 的 checksums 字段名（Node 的 platform/arch 直接拼，无需映射表）。 */
export function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`
}

/**
 * 解析「某平台该下载哪个产物 + 期望的 SHA256」。
 * 返回 { ok, sha256, version, key } 或 { ok:false, reason }。
 * 平台无预置校验值 → ok:false（fail-closed：宁可报「不支持」也不做无校验下载）。
 *
 * ⚠️ **不产出任何 URL/路径**：下载地址完全由调用方（scripts/check-secrets.mjs）用代码内常量
 * 拼装。理由：`scripts/ci-tools.json` 是磁盘数据，只要文件内容能进入请求 URL，被篡改的配置
 * 就可能把「下载 gitleaks 并执行」引到别处（CodeQL js/file-access-to-http：Outbound network
 * request depends on file data，issue #108）。本函数只负责从配置里取**校验值**（只用于本地
 * 比对，不进入任何网络请求），版本号仅用于缓存路径与版本核对。
 */
export function toolRelease(tools, toolName, platform = process.platform, arch = process.arch) {
  const tool = tools?.[toolName]
  if (!tool) {
    // kind 区分两种 ok:false（返工防回归）：config-missing 是**配置缺陷**（缺条目），
    // 本地与 CI 都必须 fail；platform-missing 才允许本地显式跳过（见 decidePlatformSkip）。
    return { ok: false, kind: 'config-missing', reason: `scripts/ci-tools.json 里没有 ${toolName} 的固定版本` }
  }
  const key = platformKey(platform, arch)
  const sha256 = tool.checksums?.[key]
  if (!sha256) {
    // version 照带（issue #355）：平台缺校验值时调用方仍需要它做「配置版本 vs 代码常量」
    // 漂移断言与缓存路径拼装——否则会误报「version undefined 漂移」这种与平台无关的假红。
    return {
      ok: false,
      kind: 'platform-missing',
      reason: `${toolName} ${tool.version} 没有为平台 ${key} 预置 SHA256（不支持的平台）`,
      version: tool.version,
    }
  }
  return { ok: true, version: tool.version, key, sha256 }
}

/**
 * 平台缺失（toolRelease 给不出该平台的预置 SHA256）时的两端处置（issue #355）。
 *   · 本地：`skip` —— 必须以「本地跳过：<原因>」显式报告并让调用方输出 [verify-skip] 标记，
 *     进入 verify 的**未跑项清单**（不计入通过，也不计入失败）；
 *     之前的行为是直接硬红（exit 2），本地门禁与「代码里有没有泄漏 secret」无关地红着，
 *     这正是「本地红得没有信息量」的缺陷。
 *   · CI：仍 `fail` —— CI 平台缺校验值 = ci-tools.json 配置缺陷，fail-closed，
 *     门禁在 CI 上**永远不许跳过**（CI 永不传 --allow-missing 同一原则）。
 *
 * ⚠️ 只有 `kind === 'platform-missing'`（平台无预置 SHA256）才允许本地 skip：
 * `kind === 'config-missing'`（配置文件里缺 gitleaks 条目）是 CI 必红的配置缺陷，
 * 本地与 CI 一律 fail——不许被本地跳过吞掉（返工前只看 release.ok === false，两类混为一谈）。
 * @param {{release:{ok:boolean,kind?:string,reason?:string}, isCi?:boolean}} input
 *   isCi 缺省取 Boolean(process.env.CI)。
 */
export function decidePlatformSkip({ release, isCi = Boolean(process.env.CI) }) {
  if (release?.ok) return { mode: 'proceed' }
  const reason = release?.reason ?? 'gitleaks 平台校验值缺失（原因未知）'
  if (release?.kind !== 'platform-missing') {
    // 配置缺条目（或来源不明的 false）：本地同样 fail-closed，绝不当成本地可跳过
    return { mode: 'fail', reason: `${reason}——配置缺陷（非平台缺失），本地与 CI 一律不许跳过` }
  }
  if (isCi) {
    return { mode: 'fail', reason: `${reason}——CI 上属门禁配置缺陷，fail-closed 拒绝跳过` }
  }
  return { mode: 'skip', reason: `本地跳过：${reason}；CI 仍强制执行本门禁` }
}

/** 十六进制摘要比较（大小写无关；任一侧为空 → 不一致）。 */
export function verifyChecksum(expected, actual) {
  const a = String(expected ?? '')
    .trim()
    .toLowerCase()
  const b = String(actual ?? '')
    .trim()
    .toLowerCase()
  return a.length > 0 && a === b
}

/**
 * 版本字符串归一：`gitleaks version 8.30.1` → `8.30.1`。
 * 只取第一个形如 x.y.z 的 token；取不到返回 null（调用方按 fail-closed 处理）。
 */
export function parseVersion(output) {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(String(output ?? ''))
  return match ? match[1] : null
}

/**
 * 版本核对：报告里记版本是为了「门禁到底跑的哪个二进制」可追溯。
 * 与 scripts/ci-tools.json 钉死的版本不一致 → ok:false（本地装了别的版本时，
 * 结论不可与 CI 互相印证，必须显式报出来而不是静默使用）。
 */
export function verifyGitleaksVersion(actual, expected) {
  const got = parseVersion(actual)
  if (got === null)
    return {
      ok: false,
      reason: `无法从 "gitleaks version" 输出解析版本：${String(actual ?? '')
        .trim()
        .slice(0, 80)}`,
    }
  if (got !== expected) {
    return { ok: false, reason: `本机 gitleaks 版本 ${got} 与 scripts/ci-tools.json 钉死的 ${expected} 不一致` }
  }
  return { ok: true, version: got }
}

/** 提交短 SHA（报告里用于定位「哪次提交引入的」）。 */
const shortSha = (sha) => (typeof sha === 'string' && sha.length >= 8 ? sha.slice(0, 8) : String(sha ?? '?'))

/**
 * 行号归一：gitleaks 的 StartLine/EndLine 是同一次命中在文件里的起止行。
 * 单行 → `行`；跨行 → `行-止行`（不回显内容，只给定位）。
 */
export function lineLabel(finding) {
  const start = Number(finding?.StartLine)
  const end = Number(finding?.EndLine)
  if (!Number.isFinite(start)) return '?'
  if (!Number.isFinite(end) || end === start) return String(start)
  return `${start}-${end}`
}

/**
 * **净化**：gitleaks 的 JSON 报告里含 Match / Secret / Line 等明文（--redact 时是 REDACTED，
 * 但不依赖它——本函数无条件丢弃这些字段）。输出记录只有定位信息：
 *   { rule, file, line, commit, fingerprint }
 *
 * 为什么在这里再丢一次、而不是只靠 gitleaks --redact：
 *   · 「明文绝不进 CI 日志」是本 issue 的硬要求，必须由**我们自己的代码**保证，
 *     而不是依赖外部工具的某个开关默认值（工具升级换默认值就会静默失效）；
 *   · 报告要渲染成 human 可读输出与 PR 评论，任何一处透传字段都可能泄漏。
 */
export function normalizeFindings(report) {
  const list = Array.isArray(report) ? report : []
  return list.map((f) => ({
    rule: String(f?.RuleID ?? 'unknown'),
    file: String(f?.File ?? '?'),
    line: lineLabel(f),
    commit: shortSha(f?.Commit),
    // 指纹由 gitleaks 给出（commit:file:rule:line），不含密钥本体；用于去重与跨平台对齐
    fingerprint: typeof f?.Fingerprint === 'string' ? f.Fingerprint : null,
  }))
}

/** 去重键：同一处命中在「全历史扫描」里可能出现多次（不同提交），按 文件:行:规则 收敛。 */
const findingKey = (f) => `${f.file}:${f.line}:${f.rule}`

/** 按文件 → 行 排序（报告可读，且 diff 稳定）。 */
export function sortFindings(findings) {
  return [...findings].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      Number.parseInt(a.line, 10) - Number.parseInt(b.line, 10) ||
      a.rule.localeCompare(b.rule),
  )
}

/**
 * 渲染 finding 清单：**只给 `文件:行:规则`**（+ 引入它的提交短 SHA）。
 * maxItems 之外截断（避免 PR 评论被刷屏，规则见 docs/开发指南/工程效率规范.md 第十三节）。
 */
export function renderFindings(findings, { maxItems = 20 } = {}) {
  const shown = findings.slice(0, maxItems)
  const lines = shown.map((f) => `  ${f.file}:${f.line}:${f.rule}（引入于 ${f.commit}）`)
  if (findings.length > maxItems) lines.push(`  …另有 ${findings.length - maxItems} 处（已截断，完整清单见 CI 日志）`)
  return lines.join('\n')
}

/**
 * 组装最终结论。ok 的三种来源：
 *   · 扫了且干净 → ok
 *   · 扫了但有命中 → 失败（fail-closed）
 *   · 没扫成（二进制缺失/校验失败/执行失败）→ 失败，除非调用方显式允许跳过（本地可选路径）
 */
export function decideScanExit({ available, findings, allowMissing = false, error = null }) {
  if (!available) {
    if (allowMissing)
      return { code: 0, ok: true, skipped: true, reason: error ?? 'gitleaks 不可用，已按 --allow-missing 跳过' }
    return { code: 1, ok: false, skipped: false, reason: error ?? 'gitleaks 不可用（fail-closed：无法扫描即判失败）' }
  }
  if (findings.length > 0) {
    return {
      code: 1,
      ok: false,
      skipped: false,
      reason: `发现 ${findings.length} 处疑似凭据（明文不打印，只给文件:行:规则）`,
    }
  }
  return { code: 0, ok: true, skipped: false, reason: '未发现疑似凭据' }
}

/**
 * 渲染汇总（人类可读，CI 日志 + 本地共用）。
 * 刻意**不打** Commit/Author/Date 之外的内容——报告正文里永远不出现 Match/Secret。
 */
export function renderScanSummary({ ok, bin, version, scope, commitsScanned, findings, ms, reason }) {
  const lines = []
  const verdict = ok ? '✅ 通过' : '❌ 失败'
  lines.push(
    `${verdict} — secret 扫描（gitleaks ${version}，范围：${scope}，${commitsScanned} 个提交，耗时 ${(ms / 1000).toFixed(1)}s）`,
  )
  lines.push(`  二进制：${bin}`)
  lines.push(`  结论：${reason}`)
  if (findings.length > 0) {
    lines.push(`  命中（只给 文件:行:规则）：`)
    lines.push(renderFindings(findings))
    lines.push('  处理：确认是真凭据则轮换并清理历史（git filter-repo）；确认是样例/夹具才加 .gitleaks.toml 豁免，')
    lines.push('        且必须锚定具体字面量（禁止按目录/整条规则豁免，见 .gitleaks.toml 头注释）。')
  }
  return lines.join('\n')
}

/** 机器可读结果（供 --json / 子 agent 消费）。不含任何明文。 */
export function scanRecord({ ok, version, scope, commitsScanned, findings, ms, reason }) {
  return {
    ok,
    tool: 'gitleaks',
    version,
    scope,
    commitsScanned,
    ms,
    reason,
    findings: findings.map((f) => ({ rule: f.rule, file: f.file, line: f.line, commit: f.commit })),
  }
}

/** 去重后的 finding 列表（同一处命中在多次提交里只留一条）。 */
export function dedupeFindings(findings) {
  const seen = new Map()
  for (const f of findings) if (!seen.has(findingKey(f))) seen.set(findingKey(f), f)
  return sortFindings([...seen.values()])
}
