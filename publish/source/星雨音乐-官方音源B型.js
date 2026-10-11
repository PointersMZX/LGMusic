/**
 * @name 星雨官方音源A型
 * @description 六线官方音源：哔哩/网易直连优先，青听渠道网关兜底
 * @version 2.0.0
 * @author XingyuMusic
 * @homepage https://github.com/PointersMZX/XingyuMusic
 */
(function () {
  'use strict'

  // ================= 配置区 =================
  // 青听渠道解析网关（与官方音源 B 型同源；青听作者调整接口时改这里一处即可）
  const GATEWAY = {
    resolve: 'https://musicserver.haitangw.cc/v1/music/resolve-url',
    timeout: 12000,
  }

  // 六条线路：our=应用内源 id，qing=青听渠道原生 id（星腾=qq）
  const LINES = {
    kw: { qing: 'kw', direct: null },
    wy: { qing: 'wy', direct: 'wy' },
    tx: { qing: 'qq', direct: null },
    kg: { qing: 'kg', direct: null },
    mg: { qing: 'mg', direct: null },
    bili: { qing: 'bili', direct: 'bili' },
  }

  // 应用音质 → 网关档位
  const QUALITY_TO_TIER = {
    '128k': 'standard',
    '320k': 'exhigh',
    flac: 'lossless',
    flac24bit: 'hires',
    '192k': 'bili192',
    ape: 'lossless',
    wav: 'hires',
  }

  // 各线对应用声明的可选音质（取应用支持档；网关失败自动降档 exhigh→standard）
  const QUALITIES = {
    kw: ['128k', '320k', 'flac', 'flac24bit'],
    wy: ['128k', '320k', 'flac', 'flac24bit'],
    tx: ['128k', '320k', 'flac', 'flac24bit'],
    kg: ['128k', '320k', 'flac', 'flac24bit'],
    mg: ['128k', '320k', 'flac', 'flac24bit'],
    bili: ['192k', '320k'],
  }

  // ================= 基础设施 =================
  const urlCache = new Map()
  const CACHE_TTL = 45 * 1000
  const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

  const http = (url, opts) => new Promise((resolve, reject) => {
    lx.request(url, opts, (err, resp, body) => {
      if (err) return reject(err)
      let b = (body !== undefined && body !== null) ? body : (resp && resp.body)
      if (typeof b === 'string') { try { b = JSON.parse(b) } catch (e) { /* keep string */ } }
      resolve({ status: resp && resp.statusCode, body: b })
    })
  })

  // ================= 直连（落雪风格：各平台公开端点） =================
  // 星宝（哔哩）：公开 playurl（非 WBI），dash 音频流；192k 档优先取 flac 流
  const getBiliDirect = (musicInfo, type) => {
    const bvid = String(musicInfo.id || '')
    let cid = String(musicInfo.cid || '')
    const headers = { 'User-Agent': UA_PC, Referer: 'https://www.bilibili.com/' }
    const pickAudio = (audios, hi) => {
      if (hi) return audios.find(a => a.id >= 30280) || audios.find(a => a.id === 30216) || audios[0]
      return audios.find(a => a.id === 30216 || a.id === 8002) || audios[0]
    }
    const fetchUrl = (cidOf) => {
      const play = 'https://api.bilibili.com/x/player/playurl?bvid=' + encodeURIComponent(bvid)
        + '&cid=' + encodeURIComponent(cidOf || '0') + '&fnver=0&fnval=16&fourk=0&qn=0'
      return http(play, { method: 'get', headers, timeout: 10000 }).then(({ body }) => {
        if (!body || body.code !== 0 || !body.data || !body.data.dash || !body.data.dash.audio || !body.data.dash.audio.length) {
          throw new Error('哔哩未返回音频流（可能风控）')
        }
        const pick = pickAudio(body.data.dash.audio, type !== '320k')
        const base = pick.baseUrl || pick.base_url || pick.url || ''
        if (!base) throw new Error('哔哩音频流地址为空')
        return base + (pick.extra ? '?' + pick.extra : '')
      })
    }
    if (cid) return fetchUrl(cid)
    return http('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid), {
      method: 'get', headers, timeout: 10000,
    }).then(({ body }) => {
      if (!body || body.code !== 0 || !body.data) throw new Error('哔哩视频信息获取失败')
      return fetchUrl(String(body.data.cid || ''))
    })
  }

  // 星芸（网易云）：公开 API 免费档（128k/320k）；flac 需会员 → 取址失败回落网关
  const getWyDirect = (musicInfo, type) => {
    if (type === 'flac' || type === 'flac24bit') throw new Error('网易直连仅免费档')
    const br = type === '128k' ? 128000 : 320000
    const id = String(musicInfo.id || '')
    return http('https://music.163.com/api/song/' + encodeURIComponent(id) + '?br=' + br, {
      method: 'get',
      headers: { 'User-Agent': UA_PC },
      timeout: 10000,
    }).then(({ body }) => {
      const info = body && body.data && (Array.isArray(body.data) ? body.data[0] : null)
      if (!info || !info.url) throw new Error('网易直连未返回地址')
      return info.url
    })
  }

  const DIRECT = {
    bili: getBiliDirect,
    wy: getWyDirect,
  }

  // ================= 青听渠道网关兜底（青听风格：解析失败自动降档/回落） =================
  const cacheKey = (qing, rid, tier) => qing + '|' + rid + '|' + tier
  const gatewayCall = (qing, rid, tier) => {
    const key = cacheKey(qing, rid, tier)
    const cached = urlCache.get(key)
    if (cached && cached.exp > Date.now()) return Promise.resolve(cached.url)
    return http(GATEWAY.resolve, {
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: qing, rid: rid, level: tier }),
      timeout: GATEWAY.timeout,
    }).then(({ body }) => {
      const data = (body && body.data) || body
      if (!body || (body.code != null && body.code !== 0) || !data || !data.url) {
        throw new Error((body && (body.msg || body.message)) || '网关未返回播放地址')
      }
      urlCache.set(key, { url: data.url, exp: Date.now() + CACHE_TTL })
      return data.url
    })
  }
  // 档位阶梯：想要档 → exhigh → standard（哔哩线无阶梯）
  const gatewayLadder = (qing, rid, wantTier) => {
    const ladder = [wantTier]
    if (wantTier !== 'exhigh') ladder.push('exhigh')
    if (wantTier !== 'standard') ladder.push('standard')
    const tryLadder = (idx) => {
      if (idx >= ladder.length) return Promise.reject(new Error('青听渠道网关：各档均失败'))
      return gatewayCall(qing, rid, ladder[idx]).catch(() => tryLadder(idx + 1))
    }
    return tryLadder(0)
  }

  // ================= 取址主逻辑 =================
  const getMusicUrl = (source, musicInfo, type) => {
    const line = LINES[source]
    if (!line) throw new Error('未支持的线路：' + source)
    const rid = String(musicInfo.id || musicInfo.songmid || '')
    if (!rid) throw new Error('缺少歌曲标识')
    const wantTier = QUALITY_TO_TIER[type] || 'exhigh'
    const direct = DIRECT[line.direct]
    if (direct) {
      return direct(musicInfo, type).catch(() => {
        // 直连失败 → 青听渠道网关兜底（哔哩线网关无此线路，直连失败即失败）
        if (source === 'bili') {
          throw new Error('哔哩直连取址失败（网关无哔哩线路）')
        }
        return gatewayLadder(line.qing, rid, wantTier)
      })
    }
    return gatewayLadder(line.qing, rid, wantTier)
  }

  // ================= 注册 =================
  lx.on('request', (req) => {
    if (req.action !== 'musicUrl') return Promise.reject(new Error('仅支持 musicUrl'))
    return getMusicUrl(req.source, req.info.musicInfo, req.info.type)
  })

  const sources = {}
  for (const id of Object.keys(LINES)) {
    sources[id] = { type: 'music', actions: ['musicUrl'], qualitys: QUALITIES[id] }
  }
  void lx.send('inited', { sources })
})()
