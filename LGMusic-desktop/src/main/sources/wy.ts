/**
 * 网易云音源适配器。
 * 逻辑忠实还原自青听 v1.0.3 桌面端主进程。
 */
import { createCipheriv, createHash } from 'node:crypto'
import { httpGetText, normalizeDuration, secondsLabel } from './types'
import type { PlaylistResult, Track } from './types'

interface WyQualityRow {
  rid: number
  name: string
  artist: string
  album: string
  duration: string
  pic: string
  level: string
  url: string
}

const WY_COOKIE =
  'EVNSM=1.0.0; osver=14; MUSIC_U=; NMCID=oyapoh.1707738771510.01.4; versioncode=1000022; URS_APPID=E26D3B65474AEE2FC2586DCAE42BCF0CBEA421D4CB53C42A74EBEF035ACE98E0B6F0E44087D61EFC06BE92279CD6EEC6; buildver=231106171719; resolution=3040x1440; sDeviceId=bnVsbAljNjowOTpiMzphYzo4NDowNgk4NzNjZWYxNGQxYjY4MWI5CWY1ZjVhNTIxOGFjNDA3ZmY%3D; os=magicos; channel=netease; screenType=other; deviceId=bnVsbAljNjowOTpiMzphYzo4NDowNgk4NzNjZWYxNGQxYjY4MWI5CWY1ZjVhNTIxOGFjNDA3ZmY%3D; appver=1.0.22; NMDI=Q1NKTQkBDACdyBclTqtsEuV2ecI7AAAAKyV%2B9xWzSJenvmG2RFU9D82gQoo96WkqNFpO59px3PrvpN5DF0cFPRJ3BXMIBMdBOcxhjUoyxI898tU%3D; ntes_kaola_ad=1; language=zh-CN; mobilename=22041211AC; __csrf=b383e0976daab42a166a9544f90a1dc3; NMTID=00O3nhQ8Br3egFvnEAIjk_hf0yT9jsAAAGNnSmw4w; packageType=release'
const WY_UA =
  'NeteaseMusic/1.0.22.231106171719(1000022);Dalvik/2.1.0 (Linux; U; Android 14; 22041211AC Build/UP1A.231005.007)'

/** 网易音质档位表（level → [序号, 判定阈值/flag]） */
const WY_LEVELS: Array<[string, [number, number]]> = [
  ['standard', [0, 128000]],
  ['exhigh', [1, 320000]],
  ['lossless', [2, 999000]],
  ['hires', [3, 4096]],
  ['sky', [4, 262144]],
  ['jyeffect', [5, 131072]],
  ['jymaster', [6, 65536]]
]

/** 网易歌曲详情（v3/song/detail，带固定设备 Cookie） */
export async function wySongDetail(id: string, level = 'standard'): Promise<WyQualityRow | null> {
  try {
    const c = JSON.stringify([{ id: parseInt(String(id)) }])
    const url = `http://interface3.music.163.com/api/v3/song/detail?c=${encodeURIComponent(c)}`
    const text = await httpGetText(url, { Cookie: WY_COOKIE, 'User-Agent': WY_UA })
    const json = JSON.parse(text)
    if (!json.songs || json.songs.length === 0) return null
    const song = json.songs[0]
    const artists: Array<{ name?: string }> = song.ar || []
    const artist = artists.map((a) => a.name).filter(Boolean).join(' & ')
    const albumName = song.al ? song.al.name : ''
    const pic = song.al ? song.al.picUrl : ''
    const sec = Math.floor((song.dt || 0) / 1000)
    const duration = secondsLabel(sec)
    const privilege = (json.privileges || [])[0] || {}
    const maxbr = privilege.maxbr || 0
    const flag = privilege.flag || 0
    let outLevel = 'standard'
    const target = WY_LEVELS.find(([name]) => name === level)
    const targetIndex = target ? target[1][0] : 0
    for (const [name, [idx, threshold]] of WY_LEVELS) {
      if (idx < 3 ? maxbr >= threshold : (flag & threshold) !== 0) outLevel = name
      if (idx === targetIndex) break
    }
    return {
      rid: parseInt(String(id)),
      name: song.name,
      artist,
      album: albumName,
      duration,
      pic,
      level: outLevel,
      url: `http://music.163.com/song/media/outer/url?id=${id}.mp3`
    }
  } catch (err) {
    console.error('wySongDetail error:', err)
    return null
  }
}

/** 网易歌单详情（v6/playlist/detail，含 trackIds 分批补全） */
export async function wyPlaylist(playlistId: string, count = 30): Promise<PlaylistResult> {
  const url = `https://music.163.com/api/v6/playlist/detail?s=0&id=${playlistId}&n=${count}&t=0`
  const cookie =
    'MUSIC_U=0007A978925988D5B41C4380BDB8E91BD23886F476867BD39EE7B653E5AB8D53878F75577D3D2D30CFD7F016C07B332F84C15E1AF67FAE750CAAFC6A9A26CBF575AD7790F08BC96B4B9291DE806051F18A4A9A332C9946AE6913E1216BCE7B3FACA1F88B37F08179530E4DEB6AF404720C764CF9F9CC7A95622BF775606CC4ABD4B0771C1A846B8BC21017C51C55FC66F6A68855DE7F758CF1BCE0BE43304A52C506ECC5EF324DF6BAE825863D1195D235C6BAF083C31EEC9F26350498FA9431748B44E116C7817DA7F603B56F384441F6CC83E8A9E5BF52B3399A44A29A1D00315C3F0F2428C747E766C5ABEB5B86D0D8F0AA51704418EB52E09201BB016B9DE438DEBF43244805F95B6D3D038345C6E07F1A2CCAC5D71EA487BBB1E2CC61A1D1D6C6661C0C0F52D358B9152ECAF8813BBBF7A3318176CA086732652BEFD8F53E2C287DC0F2EA8BCA1937DEB7E7BBD18BECA04CD2E30FC83E17C1D6D8A70E4176D0D189A78FF084445B75631E6821018A6C0F40DA9FD3C75029530F10EA77E3FB92F153C6E9547B6F5F81905CA3CCC050C600BC2F2E25B7578341AA96B2447B8E92E2EEB13E3CC7C879ACC0A2449787AF;os=pc;appver=8.9.70;'
  const fakeIp = Array(4)
    .fill(0)
    .map(() => Math.floor(Math.random() * 256))
    .join('.')
  const headers: Record<string, string> = {
    Cookie: cookie,
    'X-FORWARDED-FOR': fakeIp,
    'CLIENT-IP': fakeIp
  }
  try {
    const text = await httpGetText(url, headers)
    const json = JSON.parse(text)
    if (!json.playlist) {
      return { code: 500, msg: '获取歌单失败: 歌单为空', data: null }
    }
    const playlist = json.playlist
    let tracks = playlist.tracks || []
    const trackIds: Array<{ id?: number }> = Array.isArray(playlist.trackIds) ? playlist.trackIds : []
    if (trackIds.length > tracks.length) {
      const ids = trackIds.map((t) => Number(t?.id)).filter((n) => Number.isFinite(n) && n > 0)
      const filled: Array<Record<string, unknown>> = []
      const batch = 200
      for (let i = 0; i < ids.length; i += batch) {
        const slice = ids.slice(i, i + batch)
        try {
          const detail = JSON.parse(
            await httpGetText(`https://music.163.com/api/song/detail?ids=${encodeURIComponent(JSON.stringify(slice))}`, headers)
          )
          if (Array.isArray(detail.songs)) filled.push(...detail.songs)
        } catch (err) {
          console.warn('[网易云歌单] 补全歌曲详情失败', err)
        }
      }
      if (filled.length > tracks.length) tracks = filled
    }
    const musicList = tracks.map((song: Record<string, unknown>) => {
      const alia = (song.alia as string[] | undefined) || []
      const alias = alia.length > 0 ? alia.join('-') : ''
      const name = alias ? `${song.name} - (${alias})` : String(song.name)
      const al = (song.al || song.album || {}) as Record<string, unknown>
      const ar = (song.ar || song.artists || []) as Array<{ name?: string }>
      const pic = al.picUrl ? String(al.picUrl).replace(/^http:\/\//, 'https://') : ''
      const artist = Array.isArray(ar) ? ar.map((a) => a?.name).filter(Boolean).join(' & ') : ''
      return {
        rid: String(song.id),
        name,
        artist,
        pic,
        album: String(al.name || ''),
        duration: normalizeDuration((song.dt as number) || (song.duration as number))
      } as Track
    })
    const totalCount = Number(playlist.trackCount ?? trackIds.length ?? musicList.length) || musicList.length
    return {
      code: 200,
      msg: '获取歌单成功',
      data: {
        name: String(playlist.name || ''),
        img: playlist.coverImgUrl ? String(playlist.coverImgUrl).replace(/^http:\/\//, 'https://') : '',
        userName: playlist.creator ? String(playlist.creator.nickname || '') : '',
        uPic: playlist.creator?.avatarUrl ? String(playlist.creator.avatarUrl).replace(/^http:\/\//, 'https://') : '',
        id: playlistId,
        musicList,
        totalCount,
        hasMore: musicList.length < totalCount,
        desc: playlist.description,
        playCount: playlist.playCount
      }
    }
  } catch (err) {
    console.error('getWyPlaylist error:', err)
    return { code: 500, msg: '获取歌单失败: ' + String(err), data: null }
  }
}

/** 网易 eapi 签名（AES-128-ECB + nobody 串） */
export function wyEapiEncrypt(path: string, data: string): string {
  const secret = 'e82ckenh8dichen8'
  const digest = createHash('md5').update(`nobody${path}use${data}md5forencrypt`).digest('hex')
  const message = `${path}-36cd479b6b5-${data}-36cd479b6b5-${digest}`
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(secret), null)
  return cipher.update(message, 'utf8', 'hex') + cipher.final('hex')
}

/** 网易歌词（eapi/song/lyric/v1） */
export async function wyLyric(id: string): Promise<string> {
  try {
    const path = '/api/song/lyric/v1'
    const payload = JSON.stringify({ id: String(id), tv: '-1', lv: '-1', rv: '-1', kv: '-1', yv: '-1' })
    const sign = wyEapiEncrypt(path, payload)
    const http = await import('node:http')
    const body = `params=${encodeURIComponent(sign)}`
    return await new Promise<string>((resolve, reject) => {
      const req = http.default.request(
        {
          hostname: 'interface3.music.163.com',
          port: 80,
          path: '/eapi/song/lyric/v1',
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
            Cookie: WY_COOKIE,
            'User-Agent': WY_UA
          }
        },
        (res: { statusCode?: number; setEncoding: (e: string) => void; on: (ev: string, cb: (c?: string) => void) => void }) => {
          let data = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => (data += chunk ?? ''))
          res.on('end', () => {
            try {
              const json = JSON.parse(data)
              resolve(String(json?.lrc?.lyric || ''))
            } catch {
              resolve('')
            }
          })
        }
      )
      req.on('error', reject)
      req.write(body)
      req.end()
    })
  } catch (err) {
    console.error('Fetch lyric by eapi failed:', err)
    return ''
  }
}
