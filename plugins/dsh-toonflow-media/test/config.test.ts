import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as config from '../src/config.js'

// Regression guard for key persistence: saveConfig must create the directory it
// actually writes into, so a DSH_HOME that differs from the OS home still works.
const fakeHome = mkdtempSync(join(os.tmpdir(), 'toonflow-home-'))
const fakeDshHome = mkdtempSync(join(os.tmpdir(), 'toonflow-dshhome-'))
const savedEnv = { DSH_HOME: process.env.DSH_HOME, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME }

beforeAll(() => {
  process.env.USERPROFILE = fakeHome
  process.env.HOME = fakeHome
  process.env.DSH_HOME = fakeDshHome
})

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const dir of [fakeHome, fakeDshHome]) rmSync(dir, { recursive: true, force: true })
})

describe('media key persistence', () => {
  it('configPath follows DSH_HOME', () => {
    expect(config.configPath()).toBe(join(fakeDshHome, 'toonflow-media', 'config.json'))
  })

  it('setApiKey creates the target directory and round-trips the key', () => {
    config.setApiKey('adobe-firefly', 'sk-regression-dummy')
    expect(existsSync(join(fakeDshHome, 'toonflow-media'))).toBe(true)
    const written = JSON.parse(readFileSync(config.configPath(), 'utf8'))
    expect(written['adobe-firefly'].apiKey).toBe('sk-regression-dummy')
    expect(config.getApiKey('adobe-firefly')).toBe('sk-regression-dummy')
  })

  it('does not create a stray directory under the OS home', () => {
    // os.homedir() reads USERPROFILE on Windows / HOME elsewhere; skip if a platform ignores both.
    if (os.homedir() !== fakeHome) return
    expect(existsSync(join(os.homedir(), 'toonflow-media'))).toBe(false)
  })
})
