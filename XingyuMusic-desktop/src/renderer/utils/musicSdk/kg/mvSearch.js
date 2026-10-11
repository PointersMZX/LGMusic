import { httpFetch } from '../../request'

export default {
  limit: 30,
  /**
   * 按关键词搜索 MV（酷狗 msearch v3，实测可用）
   */
  search(str, page = 1, limit = this.limit) {
    const req = httpFetch(`https://msearch.kugou.com/api/v3/search/mv?keyword=${encodeURIComponent(str)}&page=${page}&pagesize=${limit}&type=0`)
    return req.promise.then(({ body: result }) => {
      if (!result || result.status != 1 || !result.data) return Promise.reject(new Error('kg mv search failed'))
      const raw = result.data.info || []
      const list = raw.map(item => ({
        source: 'kg',
        id: String(item.hash || ''),
        name: item.filename || '',
        singer: item.singername || '',
        img: item.imgurl ? String(item.imgurl).replace('/{size}/', '/300/').replace(/^http:/, 'https:') : null,
        duration: item.duration ? `${Math.trunc(item.duration / 60)}:${String(item.duration % 60).padStart(2, '0')}` : null,
      })).filter(i => i.name)
      const total = result.data.total ?? list.length
      return { source: 'kg', list, page, limit, total, allPage: Math.max(1, Math.ceil(total / limit)) }
    })
  },
}
