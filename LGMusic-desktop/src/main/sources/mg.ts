/**
 * 咪咕音乐适配器。
 * 逻辑忠实还原自青听 v1.0.3 桌面端主进程（jadeite 搜索签名 + 歌词链路）。
 */
import { createHash } from 'node:crypto'
import { httpGetText } from './types'

/** 咪咕搜索签名（yyapp 双盐 MD5） */
export function mgSign(timestamp: string, keyword: string): { sign: string; deviceId: string } {
  const deviceId = '963B7AA0D21511ED807EE5846EC87D20'
  const raw =
    keyword +
    '6cdc72a439cef99a3418d2a78aa28c73' +
    'yyapp2d16148780a1dcc7408e06336b98cfd50' +
    deviceId +
    timestamp
  return { sign: createHash('md5').update(raw).digest('hex'), deviceId }
}

export interface MgSearchResult {
  code: number
  msg: string
  data: unknown[]
}

/** 咪咕聚合搜索（jadeite searchAll） */
export async function mgSearch(name: string, page = 0, limit = 30): Promise<MgSearchResult> {
  const keyword = String(name || '').trim()
  if (!keyword) return { code: 400, msg: '请提供搜索关键词', data: [] }
  const pageNo = (page ?? 0) + 1
  const pageSize = limit ?? 30
  const timestamp = String(Date.now())
  const { sign, deviceId } = mgSign(timestamp, keyword)
  const searchSwitch = encodeURIComponent(
    '{"song":1,"album":0,"singer":0,"tagSong":1,"mvSong":0,"bestShow":1,"songlist":0,"lyricSong":0}'
  )
  const url =
    `https://jadeite.migu.cn/music_search/v3/search/searchAll?` +
    new URLSearchParams({
      isCorrect: '0',
      isCopyright: '1',
      searchSwitch,
      pageSize: String(pageSize),
      text: keyword,
      pageNo: String(pageNo),
      sort: '0',
      sid: 'USS'
    }).toString()
  try {
    const res = await fetch(url, {
      headers: {
        uiVersion: 'A_music_3.6.1',
        deviceId,
        timestamp,
        sign,
        channel: '0146921',
        'User-Agent':
          'Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11 Build/OPR1.170623.032) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30'
      },
      signal: AbortSignal.timeout(10000)
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`请求失败，状态码: ${res.status}`)
    return JSON.parse(text) as MgSearchResult
  } catch (err) {
    throw err instanceof Error && err.name === 'TimeoutError' ? new Error('请求超时') : err
  }
}

/** 咪咕歌词（song by-contentids → 专辑资源 → lrcUrl） */
export async function mgLyric(contentId: string): Promise<string> {
  try {
    const detail = await httpGetText(
      `https://c.musicapp.migu.cn/MIGUM3.0/resource/song/by-contentids/v2.0?contentId=${contentId}`,
      {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36 Edg/113.0.1774.42',
        Referer: 'http://music.migu.cn/',
        Connection: 'Keep-Alive'
      }
    )
    const json = JSON.parse(detail)
    if (!json.data || json.data.length === 0) {
      console.log('未找到咪咕歌曲信息')
      return ''
    }
    const song = json.data[0]
    const albumId = song.albumId
    if (!albumId) return ''
    const resource = JSON.parse(
      await httpGetText(
        `https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/resourceinfo.do?needSimple=01&resourceId=${albumId}&resourceType=2003`
      )
    )
    if (!resource.resource || resource.resource.length === 0 || !resource.resource[0].songItems) return ''
    const items = resource.resource[0].songItems
    let hit: { lrcUrl?: string } | null = null
    for (const item of items) {
      if (
        item.contentId == contentId ||
        item.copyrightId == contentId ||
        item.contentId == song.contentId ||
        item.copyrightId == song.copyrightId
      ) {
        hit = item
        break
      }
    }
    if (!hit || !hit.lrcUrl) {
      hit = items.find((it: { lrcUrl?: string }) => it.lrcUrl) || null
      if (!hit) return ''
    }
    return hit.lrcUrl ? await httpGetText(hit.lrcUrl) : ''
  } catch (err) {
    console.error('getMgLyric error:', err)
    return ''
  }
}
