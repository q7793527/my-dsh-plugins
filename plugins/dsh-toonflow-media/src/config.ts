import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

/** Config file path: $DSH_HOME/toonflow-media/config.json or ~/.dsh/toonflow-media/config.json */
export function configPath(): string {
  const dshHome = process.env.DSH_HOME || os.homedir()
  return join(dshHome, 'toonflow-media', 'config.json')
}

interface MediaConfig {
  [providerId: string]: { apiKey: string }
}

function loadConfig(): MediaConfig {
  try {
    const p = configPath()
    const raw = readFileSync(p, 'utf8')
    return JSON.parse(raw) as MediaConfig
  } catch {
    return {}
  }
}

function saveConfig(config: MediaConfig): void {
  const p = configPath()
  const dir = dirname(p)
  mkdirSync(dir, { recursive: true })
  writeFileSync(p, JSON.stringify(config, null, 2))
}

export function getApiKey(providerId: string): string | undefined {
  return loadConfig()[providerId]?.apiKey
}

export function setApiKey(providerId: string, apiKey: string): void {
  const config = loadConfig()
  config[providerId] = { apiKey }
  saveConfig(config)
}
