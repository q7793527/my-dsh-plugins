/**
 * local-skip.mjs — 门禁「本地跳过」的机器可读标记与结果归集（issue #355）。
 *
 * 语义（两端都不许放宽）：
 *   · 检查项因**本平台能力缺失**无法执行时，脚本必须打印 `[verify-skip] <原因>` 并以 0 退出
 *     ——这是「显式跳过」，不是「静默通过」：verify-local 把它单列进**本地未跑清单**，
 *     既不计入通过也不计入失败；
 *   · 没有该标记的输出就是普通检查结果，分类逻辑零改动。
 *
 * 判据由 scripts/test/secrets-platform-skip.test.mjs 钉死。
 */

/** 统一标记：检查项输出中出现该行 = 这一项在本地被显式跳过（原因在行内）。 */
export const VERIFY_SKIP_MARK = '[verify-skip]'

/** 标记含 `[ ]` 等正则元字符，先转义再成行匹配（标记行在输出里的任意位置都认）。 */
const skipMarkRe = new RegExp(`^${VERIFY_SKIP_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(.+)$`, 'm')

/** 从检查项输出里取本地跳过原因；没有标记返回 null。 */
export function parseLocalSkip(out) {
  const match = skipMarkRe.exec(String(out ?? ''))
  return match ? match[1].trim() : null
}

/**
 * 结果三分类：localSkip（本地未跑，进清单）/ passed / failed。
 * localSkip 优先于 ok：跳过项即使退出码 0 也不算通过——防止「跳过 = 白捡一个绿」。
 */
export function partitionResults(results) {
  const passed = []
  const failed = []
  const localSkipped = []
  for (const result of results) {
    if (result.localSkip) localSkipped.push(result)
    else if (result.ok) passed.push(result)
    else failed.push(result)
  }
  return { passed, failed, localSkipped }
}
