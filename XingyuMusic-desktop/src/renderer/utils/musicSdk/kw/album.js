import { httpFetch } from '../../request'

/**
 * 酷我 r.s 极简参数集才返回 ft=album 结果，且返回单引号 JSON5（JSON.parse 直接失败）。
 * 这里做一个最小 JSON5 → JSON 归一（只改字符串引号 + 内部转义），再 parse。
 */
const json5ToJson = (text) => {
  let out = ''
  let inStr = false
  let q = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (!inStr) {
      if (c === "'" || c === '"') {
        inStr = true
        q = c
        out += '"'
      } else out += c
    } else {
      if (c === '\\') {
        const next = text[i + 1]
        if (q === "'" && next === "'") out += "'" // \' → '
        else out += c + (next ?? '')
        i += 1
        continue
      }
      if (c === q) {
        inStr = false
        out += '"'
      } else if (c === '"' && q === "'") out += '\\"'
      else out += c
    }
  }
  return out
}

const parseKwBody = (body) => {
  if (body && typeof body === 'object') return body
  const text = String(body || '').trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    try {
      return JSON.parse(json5ToJson(text))
    } catch {
      return null
    }
  }
}

export default {
  limit: 30,
  /**
   * 按关键词搜索专辑（酷我 r.s ft=album，极简参数集实测有结果）
   */
  search(str, page = 1, limit = this.limit) {
    const req = httpFetch(`https://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(str)}&pn=${page - 1}&rn=${limit}&ft=album&ver=kwplayer_ar_9.2.2.1&rformat=json&encoding=utf8`)
    return req.promise.then(({ body }) => {
      const result = parseKwBody(body)
      if (!result) return Promise.reject(new Error('kw album search failed'))
      const raw = result.albumlist || []
      const list = raw.map(item => ({
        source: 'kw',
        id: String(item.id || item.albumid || ''),
        name: item.name || '',
        author: item.artist || item.fartist || '',
        img: String(item.hts_img || item.img || '').replace(/^http:/, 'https:'),
        desc: String(item.info || '').slice(0, 80),
        publishDate: item.pub || null,
        playCount: item.PLAYCNT ? Number(item.PLAYCNT) : null,
      })).filter(i => i.name)
      const total = parseInt(result.TOTAL, 10) || list.length
      return { source: 'kw', list, page, limit, total, allPage: Math.max(1, Math.ceil(total / limit)) }
    })
  },
}
