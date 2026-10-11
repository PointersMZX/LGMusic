import { httpFetch } from '../../request'

export default {
  limit: 30,
  /**
   * 按关键词搜索专辑（酷狗 msearch v3，实测可用）
   */
  search(str, page = 1, limit = this.limit) {
    const req = httpFetch(`https://msearch.kugou.com/api/v3/search/album?keyword=${encodeURIComponent(str)}&page=${page}&pagesize=${limit}&type=0`)
    return req.promise.then(({ body: result }) => {
      if (!result || result.status != 1 || !result.data) return Promise.reject(new Error('kg album search failed'))
      const raw = result.data.info || []
      const list = raw.map(item => ({
        source: 'kg',
        id: String(item.albumid ?? ''),
        name: item.albumname || '',
        author: item.singername || '',
        img: item.imgurl ? String(item.imgurl).replace(/^http:/, 'https:') : null,
        desc: item.intro || '',
        publishDate: item.pubtime ? new Date(item.pubtime * 1000).toISOString().slice(0, 10) : null,
        playCount: null,
      })).filter(i => i.name)
      const total = result.data.total ?? list.length
      return { source: 'kg', list, page, limit, total, allPage: Math.max(1, Math.ceil(total / limit)) }
    })
  },
}
