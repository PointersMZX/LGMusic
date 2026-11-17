/**
 * 酷狗音源适配器。
 * 逻辑忠实还原自青听 v1.0.3 桌面端主进程。
 */
import { appendQuery, httpGetText, httpPostText, kgSignature, md5Hex, normalizeDuration } from './types'
import type { PlaylistResult, Track } from './types'

const KG_CATEGORY_ENDPOINTS: Record<string, string> = {
  'album-search': 'https://msearch.kugou.com/api/v3/search/album',
  'artist-search': 'https://msearch.kugou.com/api/v3/search/singer',
  'playlist-search': 'https://msearch.kugou.com/api/v3/search/special',
  'album-detail': 'http://mobilecdn.kugou.com/api/v3/album/song',
  'artist-detail': 'http://mobilecdnbj.kugou.com/api/v3/singer/song'
}

/** 酷狗分类/榜单接口（HTML 注释包裹的 JSON） */
export async function kgCategoryRequest(action: string, params: Record<string, unknown>): Promise<unknown> {
  const endpoint = KG_CATEGORY_ENDPOINTS[action]
  if (!endpoint) throw new Error('不支持的酷狗分类请求')
  const query = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  try {
    const res = await fetch(`${endpoint}?${query}`, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/106.0.0.0 Safari/537.36'
      }
    })
    if (!res.ok) throw new Error(`酷狗分类接口请求失败（${res.status}）`)
    const text = (await res.text())
      .replace(/^\s*<!--KG_TAG_RES_START-->/, '')
      .replace(/<!--KG_TAG_RES_END-->\s*$/, '')
      .trim()
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('酷狗分类接口返回了无效数据')
    }
  } catch (err) {
    throw err instanceof DOMException && err.name === 'AbortError' ? new Error('酷狗分类请求超时') : err
  } finally {
    clearTimeout(timer)
  }
}

/** 酷狗网关签名请求（gateway.kugou.com） */
export async function kgGatewayRequest(
  req: { url: string; params: Record<string, unknown>; data?: unknown; headers?: Record<string, string> },
  method = 'GET'
): Promise<{ status: number; body: unknown }> {
  try {
    const dfid = '-' + Date.now() + Math.floor(Math.random() * 100000)
    const mid = md5Hex(dfid)
    const uuid = md5Hex(dfid + mid)
    const clienttime = Math.floor(Date.now() / 1000)
    const userid = 111111
    const token = md5Hex('11111111111111111111' + clienttime)
    const base: Record<string, unknown> = {
      dfid,
      mid,
      uuid,
      appid: 1005,
      clientver: 12429,
      userid,
      clienttime,
      token
    }
    const params = { ...base, ...req.params }
    const body = req.data ? JSON.stringify(req.data) : null
    if (!(params as Record<string, unknown>).signature) {
      ;(params as Record<string, unknown>).signature = kgSignature(params as Record<string, unknown>, body, false)
    }
    let url = 'https://gateway.kugou.com' + req.url
    const headers: Record<string, string> = {
      'X-Fixed-IP': '121.12.162.142',
      'X-Router': req.headers?.['x-router'] || 'pubsongscdn.kugou.com',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
    if (method === 'GET') url = appendQuery(url, params)
    const text = await httpGetText(url, headers)
    try {
      return { status: 200, body: JSON.parse(text) }
    } catch {
      return { status: 200, body: text }
    }
  } catch (err) {
    console.error('Kg request failed:', err)
    return { status: 500, body: null }
  }
}

/** 酷狗歌单搜索（special） */
export async function kgSearchSpecial(keyword: string, page = 1, pagesize = 10): Promise<{ status: number; body: unknown }> {
  return kgGatewayRequest(
    {
      url: '/v1/search/special',
      params: {
        keyword,
        platform: 'WebFilter',
        page,
        pagesize,
        iscorrection: 1,
        area_code: 1
      },
      headers: { 'x-router': 'complexsearch.kugou.com' }
    },
    'GET'
  )
}

/** 酷狗歌单内容（分页拉取） */
export async function kgPlaylistContent(
  req: { id: string | number; page: number; pagesize: number }
): Promise<{ status: number; body: unknown }> {
  return kgGatewayRequest(
    {
      url: '/v2/get_other_list_file',
      params: {
        type: 1,
        module: 'CloudMusic',
        page: req.page,
        pagesize: req.pagesize,
        global_collection_id: req.id,
        specialid: 0,
        need_sort: 1,
        area_code: 1
      },
      headers: { 'x-router': 'pubsongscdn.kugou.com' }
    },
    'GET'
  )
}

interface KgSongDetail {
  status: number
  data?: {
    play_url?: string
    play_backup_url?: string
    timelength?: number
    img?: string
    song_name?: string
    author_name?: string
    album_name?: string
    lyrics?: string
  }
}

/** 酷狗歌曲详情（wwwapi 优先，m 站兜底） */
export async function kgSongDetail(hash: string): Promise<Track | null> {
  try {
    const text = await httpGetText(
      `https://wwwapi.kugou.com/yy/index.php?r=play/getdata&hash=${hash}&dfid=1&mid=1&platid=4`,
      {
        Cookie: 'kg_mid=1; kg_dfid=1',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.90 Safari/537.36'
      }
    )
    const json = JSON.parse(text) as KgSongDetail
    if (json.status === 1 && json.data && (json.data.play_url || json.data.play_backup_url)) {
      const d = json.data
      const sec = Math.floor((d.timelength || 0) / 1000)
      let pic = d.img || ''
      if (pic) {
        pic = pic
          .replace(/http:\/\/|\/\{size\}/g, (m) => (m === 'http://' ? 'https://' : '/480'))
          .replace('{size}', '480')
      }
      return {
        rid: hash,
        name: d.song_name || '',
        artist: d.author_name || '',
        album: d.album_name || '',
        pic,
        duration: `${Math.floor(sec / 60)}分${sec % 60}秒`,
        url: d.play_url || d.play_backup_url,
        lrc: d.lyrics
      }
    }
    const fallback = JSON.parse(await httpGetText(`https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${hash}`))
    if (fallback.url) {
      const sec = fallback.timeLength ? Math.floor(fallback.timeLength) : 0
      let pic: string = fallback.imgUrl || fallback.albumImgUrl || ''
      pic = pic.replace('{size}', '480')
      return {
        rid: hash,
        name: fallback.songName,
        artist: fallback.singerName,
        album: fallback.albumName || '',
        pic,
        duration: `${Math.floor(sec / 60)}分${sec % 60}秒`,
        url: fallback.url,
        lrc: ''
      }
    }
    return null
  } catch (err) {
    console.error('getKgSongDetail error:', err)
    return null
  }
}

const KG_PAGE_SIZE = 300
const KG_MAX_PAGES = 50

const KG_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9'
}

function normalizeCover(input: unknown, size = '150'): string {
  if (typeof input !== 'string' || !input.trim()) return ''
  return input
    .replace(/^http:\/\//, 'https://')
    .replace(/\/\{size\}/g, `/${size}`)
    .replace('{size}', size)
}

/** 酷狗码提取（仅纯数字） */
function parseKugouCode(input: unknown): string {
  const raw = String(input || '').trim()
  if (!raw) return ''
  const m = raw.match(/^(?:酷狗码|小狗码|kugou\s*code)?\s*[:：]?\s*(\d{4,})$/i)
  return m?.[1] || ''
}

function itemHash(item: Record<string, unknown> | undefined): string {
  return String(
    item?.hash || item?.HASH || (item?.audio_info as Record<string, unknown> | undefined)?.hash || item?.rid || ''
  ).trim()
}

function itemsFingerprint(items: Array<Record<string, unknown>>): string {
  return items
    .map((item, i) => itemHash(item) || String(item?.filename || item?.name || item?.songname || i))
    .join('|')
}

async function kgPostJson(url: string, data: unknown): Promise<Record<string, unknown>> {
  const text = await httpPostText(url, JSON.stringify(data), { ...KG_HEADERS, 'Content-Type': 'application/json' })
  return JSON.parse(text) as Record<string, unknown>
}

/** 酷狗码 → 歌单（t.kugou.com command） */
async function kucodeCommand(data: unknown): Promise<Record<string, unknown>> {
  return kgPostJson('http://t.kugou.com/command/', {
    appid: 1001,
    clientver: 9020,
    mid: '21511157a05844bd085308bc76ef3343',
    clienttime: 640612895,
    key: '36164c4015e704673c588ee202b9ecb8',
    data
  })
}

function collectionIdOf(info: Record<string, unknown> | undefined | null): string {
  const i = info as Record<string, unknown> | undefined
  return (
    String(i?.global_collection_id || i?.copy_gcid || '') ||
    (i?.id && i?.userid
      ? `collection_${i.id}_${i.userid}_${i.id}_${(i as Record<string, unknown>).collect_type || 0}`
      : '')
  )
}

/** 酷狗码内容分页拉取（kucodeAndShare） */
async function fetchKucodeSongs(info: Record<string, unknown> | undefined): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  for (let page = 1; page <= KG_MAX_PAGES; page++) {
    let res: Record<string, unknown>
    try {
      res = await kgPostJson('http://www2.kugou.kugou.com/apps/kucodeAndShare/app/', {
        appid: 1001,
        clientver: 10112,
        mid: '70a02aad1ce4648e7dca77f2afa7b182',
        clienttime: 722219501,
        key: '381d7062030e8a5a94cfbe50bfe65433',
        data: {
          id: info?.id,
          type: 3,
          userid: info?.userid,
          collect_type: info?.collect_type,
          page,
          pagesize: KG_PAGE_SIZE
        }
      })
    } catch (err) {
      console.warn('[酷狗歌单] 酷狗码内容接口失败:', err)
      break
    }
    const list = res?.status === 1 && Array.isArray(res.data) ? (res.data as Array<Record<string, unknown>>) : []
    if (list.length === 0) break
    const fp = itemsFingerprint(list)
    if (fp && seen.has(fp)) break
    seen.add(fp)
    out.push(...list)
    if (list.length < KG_PAGE_SIZE) break
  }
  return out
}

/** 酷狗歌单内容分页拉取（get_other_list_file） */
async function fetchCollectionSongs(collectionId: string): Promise<Array<Record<string, unknown>>> {
  if (!collectionId) return []
  const out: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  for (let page = 1; page <= KG_MAX_PAGES; page++) {
    const res = await kgPlaylistContent({ id: collectionId, page, pagesize: KG_PAGE_SIZE })
    if (res?.status !== 200) break
    const body = res.body as Record<string, unknown> | undefined
    const list = Array.isArray((body?.data as Record<string, unknown> | undefined)?.info)
      ? ((body!.data as Record<string, unknown>).info as Array<Record<string, unknown>>)
      : []
    if (list.length === 0) break
    const fp = itemsFingerprint(list)
    if (fp && seen.has(fp)) break
    seen.add(fp)
    out.push(...list)
    if (list.length < KG_PAGE_SIZE) break
  }
  return out
}

interface KgListSong {
  rid: string
  name: string
  artist: string
  pic: string
  album: string
  duration: number | string
  hash: string
  sqHash: string
  source: string
}

/** 酷狗原始条目 → 统一曲目 */
function normalizeKgItem(item: Record<string, unknown> | undefined): KgListSong | null {
  const i = item as Record<string, unknown> | undefined
  const hash = itemHash(i)
  if (!hash) return null
  const audioInfo = i?.audio_info as Record<string, unknown> | undefined
  const rawName = String(i?.name || i?.filename || i?.songname || audioInfo?.songname || '')
    .replace(/\.mp3$/i, '')
    .trim()
  const parts = rawName.split(' - ')
  const artist =
    String(i?.singername || i?.singer || i?.author_name || audioInfo?.author_name || '未知艺术家') ||
    (parts.length > 1 ? parts[0]?.trim() : '')
  const songName =
    parts.length > 1
      ? parts.slice(1).join(' - ').trim()
      : String(i?.songname || audioInfo?.songname || rawName || '未知歌曲')
  return {
    rid: hash,
    name: songName,
    artist: artist || '未知艺术家',
    pic: normalizeCover(
      (i?.info as Record<string, unknown> | undefined)?.image || i?.image || i?.album_sizable_cover || i?.cover || i?.img || i?.pic,
      '150'
    ),
    album: String(i?.albumname || i?.album_name || (i?.album_info as Record<string, unknown> | undefined)?.albumName || i?.albumName || ''),
    duration: normalizeDuration(i?.timelength || i?.duration || i?.time || audioInfo?.timelength),
    hash,
    sqHash: String(i?.sqhash || i?.sq_hash || audioInfo?.sqhash || '').trim(),
    source: 'kg'
  }
}

/** 酷狗码精确解析 */
async function resolveKugouCode(code: string): Promise<PlaylistResult | null> {
  try {
    const cmd = await kucodeCommand(code)
    if (cmd?.status !== 1) return null
    const info = cmd?.data as Record<string, unknown> | undefined
    if (!(info as Record<string, unknown> | undefined)?.id) return null
    const collectionId = collectionIdOf(info)
    const [shareSongs, legacySongs] = await Promise.all([fetchKucodeSongs(info), fetchCollectionSongs(collectionId)])
    const songs = (legacySongs.length > shareSongs.length ? legacySongs : shareSongs)
      .map((it) => normalizeKgItem(it))
      .filter((t): t is KgListSong => !!t)
    const expected = Math.max(Number(info?.count) || 0, 0)
    console.log('[酷狗歌单] PC 酷狗码解析完成:', {
      code,
      collectionId,
      expectedCount: expected,
      shareCount: shareSongs.length,
      legacyCount: legacySongs.length,
      finalCount: songs.length
    })
    const cover = normalizeCover(info?.img || info?.cover || info?.imgurl, '150')
    return {
      code: 200,
      msg: '获取歌单成功',
      data: {
        name: String(info?.name || info?.specialname || info?.title || ''),
        img: cover,
        userName: String(info?.username || info?.nickname || info?.user_name || ''),
        uPic: normalizeCover(info?.user_pic || info?.headurl, '150'),
        desc: String(info?.intro || info?.description || info?.desc || ''),
        playCount: String(info?.play_count || info?.playcount || ''),
        id: code,
        resolvedId: collectionId,
        totalCount: expected || songs.length,
        musicList: songs as Track[],
        hasMore: false
      }
    }
  } catch (err) {
    console.warn('[酷狗歌单] 酷狗码精确解析失败，回退旧链路:', err)
    return null
  }
}

/** 酷狗歌单主入口（酷狗码 / collection id） */
export async function kgPlaylist(
  playlistId: string,
  page = 1,
  nameHint?: string
): Promise<PlaylistResult> {
  try {
    const rawId = String(playlistId || '').trim()
    const isCollection = /^collection_\d+_\d+_\d+(?:_\d+)?$/.test(rawId)
    const isCode = /^\d{4,}$/.test(rawId)
    if (!isCollection && !isCode) {
      return {
        code: 500,
        msg: '酷狗仅支持输入酷狗码（纯数字），不支持粘贴歌单链接',
        data: { name: '', img: '', userName: '', uPic: '', id: rawId, musicList: [] }
      }
    }
    console.log('开始解析酷狗歌单ID:', rawId, 'name=', nameHint || '')
    let listId: string = rawId
    let meta: Record<string, unknown> | null = null
    if ((page || 1) === 1 && !String(rawId || '').includes('collection')) {
      const precise = await resolveKugouCode(rawId)
      if (precise) return precise
      if (!(typeof nameHint === 'string' && nameHint.trim())) {
        return {
          code: 500,
          msg: '酷狗码无效或已失效，请检查后重新输入',
          data: { name: '', img: '', userName: '', uPic: '', id: rawId, musicList: [] }
        }
      }
    }
    if (typeof playlistId === 'string' && /^collection_\d+_\d+_\d+(_\d+)?$/.test(playlistId.trim())) {
      listId = playlistId.trim()
      try {
        const search = await kgSearchSpecial(listId)
        const lists = (search?.body as Record<string, unknown> | undefined)?.data as
          | Record<string, unknown>
          | undefined
        const arr = Array.isArray(lists?.lists) ? (lists.lists as Array<Record<string, unknown>>) : []
        if (arr.length > 0 && arr[0]?.gid) meta = arr[0]
      } catch {
        /* 搜索失败不阻塞 */
      }
    } else {
      const hint = typeof nameHint === 'string' && nameHint.trim() ? nameHint.trim() : playlistId
      const search = await kgSearchSpecial(hint)
      const body = (search?.body as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined
      const arr = Array.isArray(body?.lists) ? (body.lists as Array<Record<string, unknown>>) : []
      if (arr.length > 0) {
        let hit: Record<string, unknown> | null = null
        if (typeof nameHint === 'string' && nameHint.trim()) {
          hit = arr.find((n) => n.specialname === nameHint.trim()) || null
        }
        if (!hit && /^\d+$/.test(playlistId.trim())) {
          hit = arr.find((n) => String(n.specialid) === playlistId.trim()) || null
        }
        if (hit?.gid) {
          listId = String(hit.gid)
          meta = hit
        }
      }
    }
    if (typeof listId !== 'string' || !/^collection_\d+_\d+_\d+(_\d+)?$/.test(listId.trim())) {
      return {
        code: 500,
        msg: '无法解析酷狗歌单，请确认酷狗码有效且歌单未设为私密',
        data: {
          name: meta ? String(meta.specialname || '') : '',
          img: '',
          userName: '',
          uPic: '',
          id: rawId,
          musicList: []
        }
      }
    }
    const collected: Array<Record<string, unknown>> = []
    let pages = 0
    let curPage = page || 1
    let hasMore = false
    while (pages < KG_MAX_PAGES) {
      const res = await kgPlaylistContent({ id: listId, page: curPage, pagesize: KG_PAGE_SIZE })
      if (res?.status !== 200) {
        console.error('获取歌单内容请求失败', res)
        break
      }
      const body = res.body as Record<string, unknown> | undefined
      const info = (body?.data as Record<string, unknown> | undefined)?.info
      const list = Array.isArray(info) ? (info as Array<Record<string, unknown>>) : []
      collected.push(...list)
      pages++
      const full = list.length >= KG_PAGE_SIZE
      hasMore = full
      if (!full || (page || 1) > 1) break
      curPage++
    }
    const musicList = collected
      .map((item) => {
        const i = item as Record<string, unknown>
        const audioInfo = i.audio_info as Record<string, unknown> | undefined
        const rawName = String(i.name || i.filename || '')
        const parts = rawName.split(' - ')
        const artist = parts.length > 1 ? parts[0] : '未知艺术家'
        const song = parts.length > 1 ? parts.slice(1).join(' - ') : rawName
        let pic: string = i.cover || i.img || i.image || (i.info as Record<string, unknown> | undefined)?.image || ''
        if (pic) {
          pic = pic
            .replace(/http:\/\/|\/\{size\}/g, (m) => (m === 'http://' ? 'https://' : '/150'))
            .replace('{size}', '150')
        }
        return {
          rid: String(i.hash),
          name: song || '未知歌曲',
          artist,
          pic,
          album: String(i.album_name || i.albumname || ''),
          duration: normalizeDuration(i.timelength || i.duration || i.time || audioInfo?.timelength),
          hash: String(i.hash),
          sqHash: String(i.sqhash || i.sq_hash || audioInfo?.sqhash || '').trim(),
          source: 'kg'
        } as Track
      })
      .filter((t) => t.rid)
    let name = ''
    let img = ''
    let userName = ''
    let uPic = ''
    let desc = ''
    let playCount = ''
    if (meta) {
      name = String(meta.specialname || meta.special_name || meta.name || meta.title || '')
      img = String(meta.img || meta.cover || meta.pic || '')
      if (img) img = img.replace('http://', 'https://').replace('{size}', '150').replace("/{size}", "/150")
      userName = String(meta.username || meta.user_name || meta.nickname || '')
      uPic = String(meta.user_avatar || meta.user_pic || meta.headurl || meta.active_url || meta.avatar || '')
      if (uPic) uPic = uPic.replace('http://', 'https://')
      desc = String(meta.intro || meta.description || meta.desc || '')
      playCount = String(meta.play_count || meta.play_amt || meta.playcount || '')
    }
    return {
      code: 200,
      msg: '获取歌单成功',
      data: {
        name,
        img,
        userName,
        uPic,
        desc,
        playCount,
        id: rawId,
        resolvedId: listId,
        totalCount: musicList.length,
        musicList,
        hasMore
      }
    }
  } catch (err) {
    console.error('getKgPlaylist Critical Error:', err)
    return {
      code: 500,
      msg: '解析歌单异常: ' + String(err),
      data: { name: '', img: '', userName: '', uPic: '', id: playlistId, musicList: [] }
    }
  }
}
