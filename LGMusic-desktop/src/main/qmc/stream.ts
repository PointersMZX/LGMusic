/**
 * QMC 流式解密器（map / RC4 双模式，与 QQ 音乐 v2 加密一致）。
 * 逻辑忠实还原自青听 v1.0.3 桌面端主进程（lo 类）。
 */
import { unpackEkey } from './key'

const RC4_HEAD_SIZE = 128
const RC4_SEGMENT_SIZE = 5120

export class QmcStreamDecoder {
  private key: Buffer
  private keySize: number
  private initialSbox: Buffer
  private keyHash: number

  constructor(encodedEkey: string) {
    this.key = unpackEkey(encodedEkey)
    this.keySize = this.key.length
    this.initialSbox = this.createInitialSbox()
    this.keyHash = this.createKeyHash()
  }

  /** 原地解密一段数据（offset 为密文流内绝对偏移） */
  decrypt(data: Buffer, offset: number): Buffer {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('QMC 解密偏移量无效')
    const buf = Buffer.from(data)
    if (buf.length === 0) return buf
    if (this.keySize <= 300) this.decryptMapMode(buf, offset)
    else this.decryptRc4Mode(buf, offset)
    return buf
  }

  private createInitialSbox(): Buffer {
    const sbox = Buffer.alloc(this.keySize)
    for (let i = 0; i < sbox.length; i += 1) sbox[i] = i & 255
    let j = 0
    for (let i = 0; i < sbox.length; i += 1) {
      j = (sbox[i] + j + this.key[i % this.keySize]) % this.keySize
      const tmp = sbox[i]
      sbox[i] = sbox[j]
      sbox[j] = tmp
    }
    return sbox
  }

  private createKeyHash(): number {
    let hash = 1
    for (const byte of this.key) {
      if (byte === 0) continue
      const next = Math.imul(hash, byte) >>> 0
      if (next === 0 || next <= hash) break
      hash = next
    }
    return hash
  }

  private getSegmentKey(segmentIndex: number, seedByte: number): number {
    const factor = (segmentIndex + 1) * seedByte
    return factor ? Math.trunc(((this.keyHash / factor) * 100) | 0) : 0
  }

  /** keySize ≤ 300：map 模式（平方散列 + 位旋转 XOR） */
  private decryptMapMode(buf: Buffer, offset: number): void {
    for (let i = 0; i < buf.length; i += 1) {
      let pos = offset + i
      if (pos > 32767) pos %= 32767
      const idx = Number(((BigInt(pos) * BigInt(pos) + 71214n) % BigInt(this.keySize)))
      const shift = ((idx & 7) + 4) % 8
      const keyByte = this.key[idx]
      buf[i] ^= ((keyByte << shift) | (keyByte >>> shift)) & 255
    }
  }

  /** keySize > 300：RC4 模式（头部区 + 分段 RC4） */
  private decryptRc4Mode(buf: Buffer, offset: number): void {
    let pos = offset
    let out = 0
    let remaining = buf.length
    if (pos < RC4_HEAD_SIZE) {
      const headLen = Math.min(remaining, RC4_HEAD_SIZE - pos)
      for (let i = 0; i < headLen; i += 1) {
        const keyByte = this.key[pos % this.keySize]
        buf[out + i] ^= this.key[this.getSegmentKey(pos, keyByte) % this.keySize]
        pos += 1
      }
      out += headLen
      remaining -= headLen
    }
    if (remaining > 0 && pos % RC4_SEGMENT_SIZE !== 0) {
      const len = Math.min(RC4_SEGMENT_SIZE - (pos % RC4_SEGMENT_SIZE), remaining)
      this.decryptSegment(pos, buf.subarray(out, out + len))
      out += len
      remaining -= len
      pos += len
    }
    while (remaining > RC4_SEGMENT_SIZE) {
      this.decryptSegment(pos, buf.subarray(out, out + RC4_SEGMENT_SIZE))
      out += RC4_SEGMENT_SIZE
      remaining -= RC4_SEGMENT_SIZE
      pos += RC4_SEGMENT_SIZE
    }
    if (remaining > 0) this.decryptSegment(pos, buf.subarray(out, out + remaining))
  }

  /** 单段 RC4 解密（5120 字节一段，段内共享 S 盒游标） */
  private decryptSegment(offset: number, buf: Buffer): void {
    if (buf.length === 0) return
    const segmentIdx = Math.floor(offset / RC4_SEGMENT_SIZE) & 511
    const sbox = Buffer.from(this.initialSbox)
    const skip = (this.getSegmentKey(Math.floor(offset / RC4_SEGMENT_SIZE), this.key[segmentIdx]) & 511) + (offset % RC4_SEGMENT_SIZE)
    let i = 0
    let j = 0
    for (let n = 0; n < skip; n += 1) {
      i = (i + 1) % this.keySize
      j = (sbox[i] + j) % this.keySize
      const tmp = sbox[i]
      sbox[i] = sbox[j]
      sbox[j] = tmp
    }
    for (let n = 0; n < buf.length; n += 1) {
      i = (i + 1) % this.keySize
      j = (sbox[i] + j) % this.keySize
      const tmp = sbox[i]
      sbox[i] = sbox[j]
      sbox[j] = tmp
      buf[n] ^= sbox[(sbox[i] + sbox[j]) % this.keySize]
    }
  }
}

export function createQmcDecoder(encodedEkey: string): QmcStreamDecoder {
  return new QmcStreamDecoder(encodedEkey)
}
