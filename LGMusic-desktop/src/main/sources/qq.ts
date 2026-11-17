/**
 * QQ 音乐适配器（musicu.fcg）。
 * 逻辑忠实还原自青听 v1.0.3 桌面端主进程。
 */
import { httpGetText, httpPostText, normalizeDuration } from './types'
import type { PlaylistResult, Track } from './types'

const QQ_HEADERS = { Referer: 'https://y.qq.com/', Origin: 'https://y.qq.com' }

/** QQ 歌曲详情（UniformRuleCtrl CgiGetTrackInfo） */
export async function qqSongDetail(songMid: string): Promise<Track | null> {
  try {
    const payload = JSON.stringify({
      comm: {
        ct: 11,
        cv: '1003006',
        v: '1003006',
        QIMEI36: 'c2cff9d0d3310d40ea444083100014717907',
        QIMEI: 'c2cff9d0d3310d40ea444083100014717907',
        os_ver: '12',
        phonetype: 'Redmi K30 Pro',
        devicelevel: '31',
        tmeAppID: 'qqmusiclight',
        nettype: 'NETWORK_WIFI'
      },
      req: {
        module: 'music.trackInfo.UniformRuleCtrl',
        method: 'CgiGetTrackInfo',
        param: { mids: [songMid], types: [0] }
      }
    })
    const text = await httpPostText('http://u.y.qq.com/cgi-bin/musicu.fcg', payload, {
      Referer: 'https://y.qq.com/',
      'Content-Type': 'application/x-www-form-urlencoded'
    })
    const data = JSON.parse(text)?.req?.data
    const track = ((data?.tracks as Array<Record<string, unknown>>) || [])[0]
    if (!track) return null
    const album = (track.album as Record<string, unknown>) || {}
    const sec = Number(track.interval || 0)
    const albumMid = String(album.mid || '')
    const pic = albumMid ? `http://y.qq.com/music/photo_new/T002R800x800M000${albumMid}.jpg` : ''
    return {
      rid: songMid,
      name: String(track.title || ''),
      artist: ((track.singer as Array<{ name?: string }>) || []).map((s) => s.name).join(' & '),
      album: String(album.name || ''),
      pic,
      duration: `${Math.floor(sec / 60)}分${sec % 60}秒`
    }
  } catch (err) {
    console.error('getQqSongDetail error:', err)
    return null
  }
}

/** QQ 歌单广场（PlayListPlazaServer / PlayListCategoryServer） */
export async function qqPlaylistSquare(
  categoryId: string,
  page = 1,
  pageSize = 30
): Promise<PlaylistResult> {
  const id = String(categoryId || '10000000').trim()
  const pageNum = Math.max(1, Number(page) || 1)
  const size = Math.min(50, Math.max(1, Number(pageSize) || 30))
  const payload = {
    comm: { cv: 1602, ct: 20 },
    playlist:
      id === '10000000'
        ? {
            method: 'get_playlist_by_tag',
            param: { id: 10000000, sin: size * (pageNum - 1), size, order: 5, cur_page: pageNum },
            module: 'playlist.PlayListPlazaServer'
          }
        : {
            method: 'get_category_content',
            param: {
              titleid: Number(id),
              caller: '0',
              category_id: Number(id),
              size,
              page: pageNum - 1,
              use_page: 1
            },
            module: 'playlist.PlayListCategoryServer'
          }
  }
  const url = `https://u.y.qq.com/cgi-bin/musicu.fcg?loginUin=0&hostUin=0&format=json&inCharset=utf-8&outCharset=utf-8&notice=0&platform=wk_v15.json&needNewCode=0&data=${encodeURIComponent(JSON.stringify(payload))}`
  try {
    const json = JSON.parse(await httpGetText(url, QQ_HEADERS))
    if (json?.code !== 0 || json?.playlist?.code !== 0) {
      return { code: 500, msg: String(json?.playlist?.msg || '获取QQ歌单广场失败'), data: null }
    }
    const data = (json.playlist?.data as Record<string, unknown>) || {}
    const raw = Array.isArray(data.v_playlist)
      ? (data.v_playlist as Array<Record<string, unknown>>)
      : Array.isArray((data.content as Record<string, unknown> | undefined)?.v_item)
        ? ((data.content as Record<string, unknown>).v_item as Array<Record<string, unknown>>)
        : []
    const musicList = raw
      .map((item) => {
        const basic = (item.basic as Record<string, unknown> | undefined) || item
        return {
          rid: String(item.tid ?? basic.tid ?? ''),
          name: String(item.title ?? basic.title ?? ''),
          pic: String(
            item.cover_url_medium ??
              item.cover_url_big ??
              ((basic.cover as Record<string, unknown> | undefined)?.medium_url) ??
              ((basic.cover as Record<string, unknown> | undefined)?.default_url) ??
              ''
          ).replace(/^http:/, 'https:'),
          PlayCnt: item.access_num ?? basic.play_cnt ?? 0,
          total: (item.song_ids as Array<unknown> | undefined)?.length ?? basic.song_cnt ?? 0,
          uname: String(
            (item.creator_info as Record<string, unknown> | undefined)?.nick ??
              ((basic.creator as Record<string, unknown> | undefined)?.nick) ??
              ''
          ),
          desc: String(item.desc ?? basic.desc ?? '')
        }
      })
      .filter((t) => t.rid && t.name)
    return {
      code: 200,
      msg: '获取QQ歌单成功',
      data: {
        name: '',
        img: '',
        userName: '',
        uPic: '',
        id,
        musicList: musicList as unknown as Track[],
        total: Number(data.total ?? (data.content as Record<string, unknown> | undefined)?.total_cnt) || musicList.length
      }
    }
  } catch (err) {
    console.error('getQqPlaylistSquare error:', err)
    return { code: 500, msg: '获取QQ歌单广场失败: ' + String(err), data: null }
  }
}

/** QQ 歌单详情（fcg_v8_playlist_cp） */
export async function qqPlaylist(playlistId: string): Promise<PlaylistResult> {
  const url = `https://c.y.qq.com/v8/fcg-bin/fcg_v8_playlist_cp.fcg?id=${playlistId}&format=json&newsong=1&platform=jqspaframe.json`
  try {
    const json = JSON.parse(await httpGetText(url, { referer: `https://y.qq.com/n/yqq/playlist/${playlistId}.html`, origin: 'https://y.qq.com' }))
    if (!json.data || !json.data.cdlist || json.data.cdlist.length === 0) {
      return { code: 500, msg: '获取歌单失败或歌单为空', data: null }
    }
    const disc = json.data.cdlist[0]
    const musicList = disc.songlist.map((song: Record<string, unknown>) => {
      const album = (song.album as Record<string, unknown> | undefined) || ({} as Record<string, unknown>)
      const albumMid = String(album.mid || '')
      const pic = albumMid ? `https://y.qq.com/music/photo_new/T002R300x300M000${albumMid}.jpg?max_age=2592000` : ''
      let artist = 'Unknown'
      if (song.singer && Array.isArray(song.singer)) {
        artist = (song.singer as Array<{ name?: string }>).map((s) => s.name).join(' & ')
      }
      return {
        rid: String(song.mid),
        name: String(song.name),
        artist,
        pic,
        album: String(album.name || ''),
        duration: normalizeDuration(song.interval || song.duration)
      } as Track
    })
    return {
      code: 200,
      msg: '获取歌单成功',
      data: {
        name: String(disc.dissname || ''),
        img: disc.logo ? String(disc.logo).replace('http://', 'https://') : '',
        userName: String(disc.nickname || ''),
        uPic: disc.headurl ? String(disc.headurl).replace('http://', 'https://') : '',
        id: playlistId,
        musicList,
        totalCount: Number(disc.songnum ?? disc.songlist?.length ?? musicList.length) || musicList.length,
        desc: String(disc.desc || ''),
        tags: Array.isArray(disc.tags) ? (disc.tags as Array<{ name?: string }>).map((t) => t.name || '') : []
      }
    }
  } catch (err) {
    console.error('getQqPlaylist error:', err)
    return { code: 500, msg: '获取歌单失败: ' + String(err), data: null }
  }
}
