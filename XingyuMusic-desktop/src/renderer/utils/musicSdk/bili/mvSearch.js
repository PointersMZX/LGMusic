import { httpFetch } from '../../request'
import { decodeName } from '../../index'

export default {
  limit: 30,
  /**
   * 哔哩哔哩 MV（视频）检索，站内播放；与歌曲检索同端点（免 WBI），带 UA/Referer 与重试
   */
  search(text, page = 1, limit = this.limit, retryNum = 0) {
    if (++retryNum > 3) return Promise.reject(new Error('try max num'))
    const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(text)}&page=${page}&page_size=${limit}`
    return httpFetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://search.bilibili.com/',
      },
    }).promise.then(({ statusCode, body }) => {
      if (statusCode !== 200 || !body || body.code !== 0) return this.search(text, page, limit, retryNum)
      const raw = body.data?.result || []
      const list = raw.map(item => ({
        source: 'bili',
        id: item.bvid || '',
        name: decodeName((item.title || '').replace(/<[^>]+>/g, '')),
        singer: item.author || '',
        img: item.pic ? item.pic.replace(/^\/\//, 'https://') : null,
        pageUrl: item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : '',
        duration: item.duration || null,
      })).filter(item => item.id)
      const total = body.data?.numResults || 0
      return { source: 'bili', list, page, limit, total, allPage: Math.max(1, Math.ceil(total / limit)) }
    })
  },
}
