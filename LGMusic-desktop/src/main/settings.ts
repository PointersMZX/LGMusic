/**
 * 应用设置存储：userData/config.json（JSON 直存，键缺省走默认值）。
 */
import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'

export interface AppConfig {
  defaultQuality: string
  downloadDir: string
  desktopLyric: {
    fontSize: number
    color: string
    shadow: boolean
    twoLine: boolean
  }
}

const DEFAULTS: AppConfig = {
  defaultQuality: 'standard',
  downloadDir: '',
  desktopLyric: {
    fontSize: 26,
    color: '#29c586',
    shadow: true,
    twoLine: false
  }
}

const configPath = (): string => join(app.getPath('userData'), 'config.json')

let cache: AppConfig | null = null

export function getConfig(): AppConfig {
  if (cache) return cache
  try {
    if (existsSync(configPath())) {
      const parsed = JSON.parse(readFileSync(configPath(), 'utf-8')) as Partial<AppConfig>
      cache = {
        ...DEFAULTS,
        ...parsed,
        desktopLyric: { ...DEFAULTS.desktopLyric, ...(parsed.desktopLyric || {}) }
      }
      return cache
    }
  } catch {
    // 损坏配置回退默认
  }
  cache = { ...DEFAULTS }
  return cache
}

export function setConfig(patch: Partial<AppConfig>): AppConfig {
  const merged: AppConfig = {
    ...getConfig(),
    ...patch,
    desktopLyric: { ...getConfig().desktopLyric, ...(patch.desktopLyric || {}) }
  }
  cache = merged
  mkdirSync(dirname(configPath()), { recursive: true })
  writeFileSync(configPath(), JSON.stringify(merged, null, 2), 'utf-8')
  return merged
}
