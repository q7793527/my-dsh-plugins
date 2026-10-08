import os from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { configPath } from '../lib/config.js'

/**
 * configPath 的兜底分支：现有 config 测试全程带着 DSH_HOME，`DSH_HOME || os.homedir()`
 * 的右态（环境变量缺失时回落到 OS 主目录）从未执行过，必须显式删掉再验证并恢复。
 */
describe('configPath fallback', () => {
  it('falls back to the OS home directory when DSH_HOME is unset', () => {
    const saved = process.env.DSH_HOME
    delete process.env.DSH_HOME
    try {
      expect(configPath()).toBe(join(os.homedir(), 'toonflow-media', 'config.json'))
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = saved
    }
  })
})
