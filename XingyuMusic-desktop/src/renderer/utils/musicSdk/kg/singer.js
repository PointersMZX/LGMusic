import { httpFetch } from '../../request'

export default {
  limit: 30,
  /**
   * 按关键词搜索歌手（酷狗 msearch v3，实测可用）
   */
  search(str, page = 1, limit = this.limit) {
    const req = httpFetch(`https://msearch.kugou.com/api/v3/search/singer?keyword=${encodeURIComponent(str)}&page=${page}&pagesize=${limit}&type=0`)
    return req.promise.then(({ body: result }) => {
      if (!result || result.status != 1) return Promise.reject(new Error('kg singer search failed'))
      const raw = Array.isArray(result.data) ? result.data : (result.data?.list || [])
      const list = raw.map(item => ({
        source: 'kg',
        id: String(item.singerid ?? ''),
        name: item.singername || '',
        avatar: item.img ? String(item.img).replace(/^http:/, 'https:') : null,
      })).filter(i => i.id && i.name)
      const total = (result.data?.total) ?? list.length
      return { source: 'kg', list, page, limit, total, allPage: Math.max(1, Math.ceil(total / limit)) }
    })
  },
}
