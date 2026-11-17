/**
 * 酷我音源适配器。
 * 逻辑忠实还原自青听 v1.0.3 桌面端主进程。
 * 播放地址优先走自建网关，解密线路由网关客户端负责（见 gateway/client）。
 */
import { httpGetText, normalizeDuration, secondsLabel } from './types'
import type { PlaylistResult, Track } from './types'

const KW_UA =
  'Mozilla/5.0 (Windows NT 6.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/37.0.2062.120 Safari/537.36'

const KW_BR_MAP: Record<string, string> = {
  standard: '128kmp3',
  exhigh: '320kmp3',
  lossless: '2000kflac',
  aac: '24kaac',
  wma: '96kwma',
  ape: '1000kape'
}

/** 酷我直连播放地址转换（mobi.s convert_url_with_sign） */
export async function kwConvertUrl(rid: string, level = 'standard'): Promise<string> {
  const br = KW_BR_MAP[level] || '320kmp3'
  const text = await httpGetText(
    `http://mobi.kuwo.cn/mobi.s?f=web&user=0&source=kwplayercar_ar_6.0.0.9_B_jiakong_vh.apk&type=convert_url_with_sign&br=${br}&sig=0&rid=${rid}`,
    { 'User-Agent': KW_UA }
  )
  let url = String(JSON.parse(text)?.data?.url || '')
  if (url) {
    url = url.replace(/\?.*/, '')
    url = url.replace('http:', 'https:')
    url = url.replace(/(?<=https:\/\/)(.*?)(?=\.sycdn)/, '$1')
    url = url.replace('.sycdn', '-sycdn')
  }
  return url
}

/** 酷我歌曲详情（musicpay 元数据 + 封面 + 歌词） */
export async function kwSongDetail(rid: string): Promise<Track | null> {
  try {
    const pay = await httpGetText(`http://musicpay.kuwo.cn/music.pay?op=query&action=play&ids=${rid}`, {
      'User-Agent': KW_UA,
      'x-forwarded-for': '1.0.1.114',
      'x-real-ip': '1.0.1.114'
    })
    const song = (JSON.parse(pay)?.songs || [])[0] || {}
    const url = await kwConvertUrl(rid)
    const sec = Number(song.duration || 0)
    const duration = secondsLabel(sec)
    const picText = await httpGetText(
      `http://artistpicserver.kuwo.cn/pic.web?corp=kuwo&type=rid_pic&pictype=url&content=list&size=800&rid=${rid}`
    )
    const pic = picText.replace('http://', 'https://').replace('kwcdn.kuwo.cn', 'kuwo.cn')
    const lyricText = await httpGetText(`https://wapi.kuwo.cn/openapi/v1/www/lyric/getlyric?musicId=${rid}&httpsStatus=1`)
    let lrc = ''
    try {
      const lines = ((JSON.parse(lyricText)?.data?.lrclist as Array<{ time: string; lineLyric: string }>) || [])
      for (const line of lines) {
        const t = parseFloat(line.time)
        const m = Math.floor(t / 60)
        const s = Math.floor(t % 60)
        const ms = Math.round((t - Math.floor(t)) * 1000)
        lrc += `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}]${line.lineLyric}\n`
      }
    } catch (err) {
      console.error('Kw lrc parse error', err)
    }
    return {
      rid,
      name: String(song.name || ''),
      artist: String(song.artist || ''),
      album: String(song.album || ''),
      pic,
      duration,
      url,
      lrc
    }
  } catch (err) {
    console.error('getKwSongDetail error', err)
    return null
  }
}

/** 酷我歌单（newh5 playListInfo） */
export async function kwPlaylist(playlistId: string, page = 1, pageSize = 30): Promise<PlaylistResult> {
  const url = `https://m.kuwo.cn/newh5app/wapi/api/www/playlist/playListInfo?pid=${playlistId}&pn=${page}&rn=${pageSize}`
  try {
    const json = JSON.parse(await httpGetText(url))
    const list = json.data?.musicList
    if (!list) return { code: 500, msg: '获取歌单失败', data: null }
    const musicList = list.map((item: Record<string, unknown>) => {
      const ridMatch = String(item.rid).match(/[\d]+/)
      const rid = ridMatch ? ridMatch[0] : item.rid
      const pic = item.pic ? String(item.pic).replace('http://', 'https://') : ''
      return {
        rid,
        name: item.name,
        artist: item.artist,
        pic,
        album: item.album,
        duration: normalizeDuration(item.duration || item.songTimeMinutes)
      } as Track
    })
    const d = json.data
    const img = d.img ? String(d.img).replace('http://', 'https://').replace('kwcdn.kuwo.cn', 'kuwo.cn') : ''
    return {
      code: 200,
      msg: '获取歌单成功',
      data: {
        name: String(d.name || ''),
        img,
        userName: String(d.userName || ''),
        uPic: d.uPic ? String(d.uPic).replace('http://', 'https://') : '',
        total: d.total,
        totalCount: Number(d.total) || musicList.length,
        tag: d.tag,
        id: playlistId,
        musicList,
        desc: d.info
      }
    }
  } catch (err) {
    console.error('getKwPlaylist error:', err)
    return { code: 500, msg: '获取歌单失败: ' + String(err), data: null }
  }
}
