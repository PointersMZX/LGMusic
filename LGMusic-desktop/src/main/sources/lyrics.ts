/**
 * 歌词通道（QQ/WY/KW/KG）。
 * 逻辑忠实还原自青听 v1.0.3 桌面端主进程。
 */
import { createHash } from 'node:crypto'
import { httpGetText } from './types'

/** base64 → UTF-8 文本 */
function decodeBase64Text(input: string): string {
  return Buffer.from(input, 'base64').toString('utf8')
}

/** 解析一行 LRC：返回 { time, line }，无效行返回 null */
function parseLrcLine(line: string): { time: number; line: string } | null {
  const m = line.match(/^\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\](.*)$/)
  if (!m) return null
  const time = Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(`0.${m[3]}`) : 0)
  return { time, line: m[4] }
}

/** 原文行规范化（去多余空行/时间标签保留原文） */
function normalizeLrcLine(line: string): string {
  return line.replace(/\s+$/, '')
}

/** 原文与翻译按时间合并（原文行后跟翻译行） */
function mergeLrcWithTranslation(original: string, translation: string): string {
  const transRows: Array<[number, string]> = []
  for (const line of translation.split(/\r?\n/)) {
    const parsed = parseLrcLine(line)
    if (parsed) transRows.push([parsed.time, parsed.line])
  }
  let out = ''
  for (const line of original.split(/\r?\n/)) {
    const parsed = parseLrcLine(line)
    if (!parsed) continue
    out += normalizeLrcLine(line) + '\n'
    const hit = transRows.find(([t]) => t === parsed.time)
    if (hit) out += hit[1] + '\n'
  }
  return out
}

/** QQ 歌词（PlayLyricInfo，base64 歌词 + 翻译合并） */
export async function qqLyric(songMid: string): Promise<{
  code: number
  lyric?: string
  raw_lyric?: string
  raw_trans?: string
  source?: string
  msg?: string
}> {
  const mid = String(songMid ?? '').trim()
  if (!mid) return { code: 400, msg: 'songMid 为空' }
  const payload = JSON.stringify({
    comm: { ct: 11, cv: 0 },
    req: {
      module: 'music.musichallSong.PlayLyricInfo',
      method: 'GetPlayLyricInfo',
      param: {
        format: 'json',
        crypt: 0,
        ct: 11,
        cv: 0,
        interval: 0,
        lrc_t: 0,
        trans: 1,
        trans_t: 0,
        type: -1,
        songMID: mid
      }
    }
  })
  const postOnce = async (secure: boolean): Promise<string> => {
    const http = await import(secure ? 'node:https' : 'node:http')
    return new Promise((resolve, reject) => {
      const req = http.default.request(
        {
          hostname: 'u.y.qq.com',
          port: secure ? 443 : 80,
          path: '/cgi-bin/musicu.fcg',
          method: 'POST',
          headers: {
            Host: 'u.y.qq.com',
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            Referer: 'https://y.qq.com/',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36 Edg/113.0.1774.42'
          }
        },
        (res) => {
          let data = ''
          res.on('data', (chunk) => (data += chunk))
          res.on('end', () => resolve(data))
        }
      )
      req.on('error', reject)
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.write(payload)
      req.end()
    })
  }
  let raw: string
  try {
    raw = await postOnce(false)
  } catch (err) {
    console.warn('[Main] QQ歌词 http 失败，回退 https:', err)
    try {
      raw = await postOnce(true)
    } catch (err2) {
      console.error('[Main] qq lyric request error', err2)
      return { code: 500, msg: '请求失败' }
    }
  }
  let json: Record<string, unknown>
  try {
    json = JSON.parse(raw)
  } catch (err) {
    console.error('[Main] qq lyric parse error', err)
    return { code: 500, msg: '解析失败' }
  }
  const data = (json?.req as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined
  const lyricB64 = data?.lyric ? decodeBase64Text(String(data.lyric)) : ''
  const transB64 = data?.trans ? decodeBase64Text(String(data.trans)) : ''
  return {
    code: 0,
    lyric: mergeLrcWithTranslation(lyricB64, transB64),
    raw_lyric: lyricB64,
    raw_trans: transB64,
    source: 'qq'
  }
}

/** 网易歌词（api/song/lyric Linux UA） */
export async function wyLyricPlain(id: string): Promise<{ code: number; lrc?: Record<string, unknown>; msg?: string }> {
  console.log(`[Main] 收到歌词请求: ${id}`)
  try {
    const text = await httpGetText(
      `http://interface3.music.163.com/api/song/lyric?id=${id}&os=Linux&lv=-1&kv=-1&tv=-1`,
      {
        'User-Agent':
          'NeteaseMusic/1.0.22.231106171719(1000022);Dalvik/2.1.0 (Linux; U; Android 14; 22041211AC Build/UP1A.231005.007)'
      }
    )
    console.log(`[Main] 歌词请求成功，长度: ${text.length}`)
    return JSON.parse(text)
  } catch (err) {
    console.error('[Main] wy lyric parse error', err)
    return { code: 500, msg: '解析失败' }
  }
}

/** 酷我歌词（openapi getlyric，lrclist 转 LRC 文本由渲染层处理） */
export async function kwLyric(musicId: string): Promise<{ code: number; data?: Record<string, unknown>; msg?: string }> {
  console.log('[Main] 收到获取酷我歌词请求:', musicId)
  try {
    const text = await httpGetText(
      `https://wapi.kuwo.cn/openapi/v1/www/lyric/getlyric?musicId=${musicId}&httpsStatus=1`,
      {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36 Edg/113.0.1774.42'
      }
    )
    console.log('[Main] 酷我歌词请求成功')
    return JSON.parse(text)
  } catch (err) {
    console.error('[Main] kw lyric parse error', err)
    return { code: 500, msg: '解析失败' }
  }
}

/** 酷狗 KRC 歌词（m3ws get_lyrics + NVPh5 盐签名），含翻译合并 */
export async function kgLyric(hash: string): Promise<{
  code: number
  lyric?: string
  raw_lrc?: string
  raw_trans?: string
  msg?: string
}> {
  const h = String(hash ?? '').trim()
  if (!h) return { code: 400, msg: 'hash 为空' }
  try {
    const now = Date.now()
    const signRaw = `NVPh5oo715z5DIWAeQlhMDsWXXQV4hwtclienttime=${now}clientver=20000dfid=-hash=${h}keyword=mid=${now}srcappid=2919timelength=0NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt`
    const signature = createHash('md5').update(signRaw).digest('hex')
    const url = `https://m3ws.kugou.com/api/v1/krc/get_lyrics?clienttime=${now}&clientver=20000&dfid=-&hash=${encodeURIComponent(h)}&keyword=&mid=${now}&srcappid=2919&timelength=0&signature=${signature}`
    const text = await httpGetText(url, {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36 Edg/113.0.1774.42',
      Referer: 'https://www.kugou.com/'
    })
    let json: Record<string, unknown>
    try {
      json = JSON.parse(text)
    } catch (err) {
      console.error('[Main] kg lyric parse error', err)
      return { code: 500, msg: '解析失败' }
    }
    const data = json?.data as Record<string, unknown> | undefined
    if (!data) return { code: 500, msg: '返回数据为空' }
    const lrc = String(data.lrc ?? '').replace(/\r/g, '')
    let trans: string | null = null
    const landata = data.landata
    if (Array.isArray(landata)) {
      for (const item of landata) {
        if (item?.type === 1 || item?.type === '1') {
          trans = String(item.content ?? '')
          break
        }
      }
    }
    return {
      code: 200,
      lyric: mergeLrcWithTranslation(lrc, trans ?? ''),
      raw_lrc: lrc,
      raw_trans: trans ?? ''
    }
  } catch (err) {
    console.error('[Main] kg lyric request error', err)
    return { code: 500, msg: '请求失败' }
  }
}
