import { httpFetch } from '../../request'
import { createSignature } from './musicSearch'

/**
 * 咪咕歌词检索：v3 searchAll 网关（searchSwitch 换 lyricSong）
 * 响应结构：{ code, lyricResultData: { totalCount, result: [{ songId, songName, multiLyricStr, lyricUrl, ... }] } }
 */
const searchAll = (text, page, limit, switchJson) => {
  const time = Date.now().toString()
  const signData = createSignature(time, text)
  return httpFetch(`https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0&isCopyright=1&searchSwitch=${encodeURIComponent(switchJson)}&pageSize=${limit}&text=${encodeURIComponent(text)}&pageNo=${page}&sort=0&sid=USS`, {
    headers: {
      uiVersion: 'A_music_3.6.1',
      deviceId: signData.deviceId,
      timestamp: time,
      sign: signData.sign,
      channel: '0146921',
      'User-Agent': 'Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11 Build/OPR1.170623.032) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30',
    },
  }).promise.then(({ body }) => body)
}

export default {
  limit: 30,
  search(str, page = 1, limit = this.limit) {
    return searchAll(str, page, limit, JSON.stringify({ song: 1, album: 0, singer: 0, tagSong: 0, mvSong: 0, bestShow: 0, songlist: 0, lyricSong: 1 }))
      .then((body) => {
        const resultData = body?.lyricResultData || {}
        const raw = resultData.result || []
        const list = raw.map(item => ({
          source: 'mg',
          id: String(item.songId || item.id || ''),
          name: item.songName || item.name || '',
          singer: (item.singers || [])[0]?.name || '',
          img: null,
          lyric: item.multiLyricStr || item.lyricUrl || '',
        })).filter(i => i.name)
        const total = resultData.totalCount ?? list.length
        return { source: 'mg', list, page, limit, total, allPage: Math.max(1, Math.ceil(total / limit)) }
      })
  },
}
