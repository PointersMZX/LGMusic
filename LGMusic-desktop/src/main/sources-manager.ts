/**
 * 音源配置管理：外置音源脚本导入/列表/删除（userData/sources/）。
 * 音源本体由用户导入（MusicFree 插件 JS / LX 音源 JS / JSON 配置），
 * 本体不内置任何音源（合规要求）。播放执行由 QuickJS 插件运行时承担。
 */
import { app, dialog, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'

export interface SourceMeta {
  fileName: string
  name: string
  type: string
  version: string
  importedAt: number
}

const sourcesDir = (): string => join(app.getPath('userData'), 'sources')
const indexPath = (): string => join(sourcesDir(), 'index.json')

function ensureDir(): void {
  if (!existsSync(sourcesDir())) mkdirSync(sourcesDir(), { recursive: true })
}

function readIndex(): SourceMeta[] {
  ensureDir()
  try {
    if (existsSync(indexPath())) return JSON.parse(readFileSync(indexPath(), 'utf-8')) as SourceMeta[]
  } catch {
    // 损坏索引重建
  }
  return []
}

function writeIndex(list: SourceMeta[]): void {
  ensureDir()
  writeFileSync(indexPath(), JSON.stringify(list, null, 2), 'utf-8')
}

/** 从脚本内容提取展示名/类型（MusicFree: platform 字段；LX: lx_setup 注释；JSON: name 字段） */
function probeMeta(fileName: string, content: string): { name: string; type: string; version: string } {
  let name = fileName.replace(/\.(js|json)$/i, '')
  let type = 'unknown'
  let version = ''
  if (/musicfree|getMediaSource/i.test(content)) {
    type = 'musicfree'
    const m = content.match(/platform\s*:\s*['"]([^'"]+)['"]/)
    if (m) name = m[1]
    const v = content.match(/version\s*:\s*['"]([^'"]+)['"]/)
    if (v) version = v[1]
  } else if (/lx_setup|globalThis\.lx|__lx/i.test(content)) {
    type = 'lx'
    const m = content.match(/音源名[：:]\s*([^\n]+)/)
    if (m) name = m[1].trim()
  } else {
    try {
      const json = JSON.parse(content)
      if (json.name) name = String(json.name)
      type = 'json-config'
    } catch {
      type = 'unknown'
    }
  }
  return { name, type, version }
}

export function listSources(): SourceMeta[] {
  return readIndex()
}

export function importSourceDialog(parent?: BrowserWindow): Promise<SourceMeta[] | null> {
  const win = parent ?? BrowserWindow.getAllWindows()[0]
  const result = dialog.showOpenDialogSync(win, {
    title: '导入音源配置',
    filters: [{ name: '音源配置', extensions: ['js', 'json'] }],
    properties: ['openFile', 'multiSelections']
  })
  if (!result || result.length === 0) return Promise.resolve(null)
  ensureDir()
  const list = readIndex()
  const added: SourceMeta[] = []
  for (const filePath of result) {
    try {
      const content = readFileSync(filePath, 'utf-8')
      const baseName = filePath.split(/[\\/]/).pop() as string
      const meta = probeMeta(baseName, content)
      const target = join(sourcesDir(), baseName)
      writeFileSync(target, content, 'utf-8')
      const entry: SourceMeta = {
        fileName: baseName,
        name: meta.name,
        type: meta.type,
        version: meta.version,
        importedAt: Date.now()
      }
      const existing = list.findIndex((x) => x.fileName === baseName)
      if (existing >= 0) list[existing] = entry
      else list.push(entry)
      added.push(entry)
    } catch {
      // 单个文件失败跳过
    }
  }
  writeIndex(list)
  return Promise.resolve(added)
}

export function deleteSource(fileName: string): SourceMeta[] {
  const list = readIndex().filter((x) => x.fileName !== fileName)
  try {
    const target = join(sourcesDir(), fileName)
    if (existsSync(target)) unlinkSync(target)
  } catch {
    // 删除失败忽略
  }
  writeIndex(list)
  return list
}

export function chooseSourceFileViaMenu(parent?: BrowserWindow): void {
  void importSourceDialog(parent)
}
