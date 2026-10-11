import { httpFetch } from '../../request'
import { createSignature } from './musicSearch'

/**
 * 咪咕 MV 检索：v3 searchAll 网关（与歌曲检索同一签名机制，searchSwitch 换 mvSong）
 * 响应结构：{ code, mvSongResultData: { totalCount, result: [{ id, name, singers, mvList: [{ copyrightId, mvPicUrl }] }] } }
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
    return searchAll(str, page, limit, JSON.stringify({ song: 0, album: 0, singer: 0, tagSong: 0, mvSong: 1, bestShow: 0, songlist: 0, lyricSong: 0 }))
      .then((body) => {
        const resultData = body?.mvSongResultData || {}
        const raw = resultData.result || []
        const list = raw.map(item => {
          const mv = (item.mvList || [])[0] || {}
          const pic = (mv.mvPicUrl || [])[0]
          return {
            source: 'mg',
            id: String(mv.copyrightId || item.id || ''),
            name: item.name || '',
            singer: (item.singers || [])[0]?.name || '',
            img: pic?.img ? String(pic.img).replace(/^http:/, 'https:') : null,
          }
        }).filter(i => i.id && i.name)
        const total = resultData.totalCount ?? list.length
        return { source: 'mg', list, page, limit, total, allPage: Math.max(1, Math.ceil(total / limit)) }
      })
  },
}
