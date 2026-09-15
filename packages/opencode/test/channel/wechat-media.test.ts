import { describe, expect, test } from "bun:test"
import { createCipheriv, createDecipheriv, createHash } from "node:crypto"
import {
  DEFAULT_CDN_BASE_URL,
  MAX_MEDIA_BYTES,
  MediaError,
  downloadMedia,
  sanitizeFilename,
  uploadMedia,
  validateCdnUrl,
} from "../../src/channel/wechat-media"
import { TransportError, WechatApi, type MessageItem, type UploadUrlRequest } from "../../src/channel/wechat-api"

function encrypt(data: Uint8Array, key: Buffer) {
  const cipher = createCipheriv("aes-128-ecb", key, null)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

describe("WeChat media transport", () => {
  test("allocates upload URLs through the authenticated provider API without widening response types", async () => {
    let request: Record<string, unknown> | undefined
    const api = new WechatApi({
      token: "private-token",
      fetch: (async (_url, init) => {
        request = JSON.parse(String(init?.body))
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-token")
        return Response.json({ upload_param: "private-allocation" })
      }) as typeof fetch,
    })
    const allocation: UploadUrlRequest = {
      filekey: "a".repeat(32),
      media_type: 1,
      to_user_id: "user",
      rawsize: 1,
      rawfilemd5: "b".repeat(32),
      filesize: 16,
      no_need_thumb: true,
      aeskey: "c".repeat(32),
    }
    expect(await api.getUploadUrl(allocation)).toEqual({ upload_param: "private-allocation" })
    expect(request).toMatchObject({ ...allocation, base_info: { channel_version: "2.4.8" } })
    const invalid = new WechatApi({
      token: "private-token",
      fetch: (async () => Response.json({ upload_param: { secret: true } })) as typeof fetch,
    })
    await expect(invalid.getUploadUrl(allocation)).rejects.toBeInstanceOf(TransportError)
  })

  test("downloads and decrypts every official media item shape from trusted full URLs", async () => {
    const aes = Buffer.from("00112233445566778899aabbccddeeff", "hex")
    const encodedHex = Buffer.from(aes.toString("hex")).toString("base64")
    const fixtures: Array<{ plaintext: Buffer; item: MessageItem; contentType: string }> = [
      {
        plaintext: Buffer.from("89504e470d0a1a0a00010203", "hex"),
        contentType: "image/png",
        item: {
          type: 2,
          image_item: {
            aeskey: aes.toString("hex"),
            media: { full_url: "https://novac2c.cdn.weixin.qq.com/image?private=1" },
            mid_size: 16,
          },
        },
      },
      {
        plaintext: Buffer.from("private voice"),
        contentType: "audio/silk",
        item: {
          type: 3,
          voice_item: {
            encode_type: 6,
            media: { full_url: "https://novac2c.cdn.weixin.qq.com/voice", aes_key: aes.toString("base64") },
          },
        },
      },
      {
        plaintext: Buffer.from("%PDF-1.7\ntest"),
        contentType: "application/pdf",
        item: {
          type: 4,
          file_item: {
            file_name: "../unsafe\\report?.pdf",
            len: "13",
            media: { full_url: "https://novac2c.cdn.weixin.qq.com/file", aes_key: encodedHex },
          },
        },
      },
      {
        plaintext: Buffer.from("000000186674797069736f6d00000000", "hex"),
        contentType: "video/mp4",
        item: {
          type: 5,
          video_item: {
            video_size: 32,
            media: { full_url: "https://novac2c.cdn.weixin.qq.com/video", aes_key: encodedHex },
          },
        },
      },
    ]
    const urls: string[] = []
    for (const fixture of fixtures) {
      const ciphertext = encrypt(fixture.plaintext, aes)
      const result = await downloadMedia({
        item: fixture.item,
        fetch: (async (url, init) => {
          urls.push(String(url))
          expect(init?.redirect).toBe("error")
          return new Response(ciphertext, { status: 200, headers: { "content-length": String(ciphertext.length) } })
        }) as typeof fetch,
      })
      expect(result.status).toBe("available")
      expect(result.contentType).toBe(fixture.contentType)
      expect(Buffer.from(result.data!)).toEqual(fixture.plaintext)
    }
    expect(urls).toHaveLength(4)
    const fileCiphertext = encrypt(fixtures[2]!.plaintext, aes)
    expect(
      (
        await downloadMedia({
          item: fixtures[2]!.item,
          fetch: (async () => new Response(fileCiphertext)) as typeof fetch,
        })
      ).filename,
    ).toBe("report_.pdf")
  })

  test("uses encoded trusted fallback and allows the official plain-image form", async () => {
    let requested: URL | undefined
    const result = await downloadMedia({
      item: { type: 2, image_item: { media: { encrypt_query_param: "private &=value" } } },
      fetch: (async (url) => {
        requested = new URL(String(url))
        return new Response(Buffer.from("ffd8ff001122", "hex"))
      }) as typeof fetch,
    })
    expect(result.status).toBe("available")
    expect(result.contentType).toBe("image/jpeg")
    expect(requested?.origin + requested?.pathname).toBe(`${DEFAULT_CDN_BASE_URL}/download`)
    expect(requested?.searchParams.get("encrypted_query_param")).toBe("private &=value")
  })

  test("sniffs safe content types and rejects active or malformed image/video payloads", async () => {
    const imageCases = [
      [Buffer.from("89504e470d0a1a0a", "hex"), "image/png"],
      [Buffer.from("ffd8ff00", "hex"), "image/jpeg"],
      [Buffer.from("GIF89a", "ascii"), "image/gif"],
      [Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WEBP", "ascii")]), "image/webp"],
    ] as const
    for (const [data, contentType] of imageCases) {
      const result = await downloadMedia({
        item: { type: 2, image_item: { media: { full_url: "https://novac2c.cdn.weixin.qq.com/image" } } },
        fetch: (async () => new Response(data)) as typeof fetch,
      })
      expect(result).toMatchObject({ status: "available", contentType })
    }
    for (const data of [
      Buffer.from("<svg><script>alert(1)</script></svg>"),
      Buffer.from("<!doctype html>"),
      Buffer.from("unknown"),
    ]) {
      const result = await downloadMedia({
        item: { type: 2, image_item: { media: { full_url: "https://novac2c.cdn.weixin.qq.com/image" } } },
        fetch: (async () => new Response(data)) as typeof fetch,
      })
      expect(result).toMatchObject({ status: "unavailable", reason: "invalid" })
    }
    const invalidVideo = await downloadMedia({
      item: {
        type: 5,
        video_item: {
          media: { full_url: "https://novac2c.cdn.weixin.qq.com/video", aes_key: Buffer.alloc(16).toString("base64") },
        },
      },
      fetch: (async () => new Response(encrypt(Buffer.from("not an mp4"), Buffer.alloc(16)))) as typeof fetch,
    })
    expect(invalidVideo).toMatchObject({ status: "unavailable", reason: "invalid" })
  })

  test("sniffs file bytes and verifies declared protocol sizes", async () => {
    const aes = Buffer.alloc(16)
    const downloadFile = (data: Buffer, len = String(data.length)) =>
      downloadMedia({
        item: {
          type: 4,
          file_item: {
            len,
            media: {
              full_url: "https://novac2c.cdn.weixin.qq.com/file",
              aes_key: aes.toString("base64"),
            },
          },
        },
        fetch: (async () => new Response(encrypt(data, aes))) as typeof fetch,
      })
    expect(await downloadFile(Buffer.from("%PDF-1.7\n"))).toMatchObject({ contentType: "application/pdf" })
    expect(await downloadFile(Buffer.from("safe UTF-8 文本\n"))).toMatchObject({
      contentType: "text/plain",
    })
    expect(await downloadFile(Buffer.from([0, 159, 255]))).toMatchObject({ contentType: "application/octet-stream" })
    expect(await downloadFile(Buffer.from("length mismatch"), "999")).toMatchObject({
      status: "unavailable",
      reason: "invalid",
    })
    const video = Buffer.from("000000186674797069736f6d00000000", "hex")
    const cipher = encrypt(video, aes)
    const sizeMismatch = await downloadMedia({
      item: {
        type: 5,
        video_item: {
          video_size: cipher.length + 16,
          media: { full_url: "https://novac2c.cdn.weixin.qq.com/video", aes_key: aes.toString("base64") },
        },
      },
      fetch: (async () => new Response(cipher)) as typeof fetch,
    })
    expect(sizeMismatch).toMatchObject({ status: "unavailable", reason: "invalid" })
  })

  test("rejects untrusted URLs before fetch and returns checkpoint-safe unavailable descriptors", async () => {
    let calls = 0
    for (const url of [
      "http://novac2c.cdn.weixin.qq.com/file",
      "https://weixin.qq.com.evil.test/file",
      "https://user@weixin.qq.com/file",
      "https://weixin.qq.com:444/file",
      "https://weixin.qq.com/file#fragment",
    ]) {
      const result = await downloadMedia({
        item: {
          type: 4,
          file_item: { file_name: "x", media: { full_url: url, aes_key: Buffer.alloc(16).toString("base64") } },
        },
        fetch: (async () => {
          calls++
          throw new Error("must not fetch")
        }) as typeof fetch,
      })
      expect(result).toMatchObject({ kind: "file", status: "unavailable", reason: "invalid" })
      expect(result.data).toBeUndefined()
    }
    expect(calls).toBe(0)
    expect(() => validateCdnUrl("https://sub.weixin.qq.com/download?q=ok")).not.toThrow()
  })

  test("enforces the byte cap while streaming instead of buffering the response", async () => {
    let produced = 0
    const chunk = new Uint8Array(1024 * 1024)
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced++
        controller.enqueue(chunk)
      },
      cancel() {},
    })
    const result = await downloadMedia({
      item: { type: 2, image_item: { media: { full_url: "https://novac2c.cdn.weixin.qq.com/large" } } },
      fetch: (async () => new Response(stream)) as typeof fetch,
    })
    expect(result).toMatchObject({ status: "unavailable", reason: "size" })
    expect(produced).toBeLessThanOrEqual(22)
  })

  test("reports timeout, HTTP rejection and invalid AES without leaking provider details", async () => {
    const media = (key: string) => ({
      type: 3,
      voice_item: { media: { full_url: "https://novac2c.cdn.weixin.qq.com/private?token=SECRET", aes_key: key } },
    })
    const timeout = await downloadMedia({
      item: media(Buffer.alloc(16).toString("base64")),
      timeoutMs: 1,
      fetch: (async (_url, init) =>
        new Promise((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("SECRET")), { once: true }),
        )) as typeof fetch,
    })
    expect(timeout).toMatchObject({ status: "unavailable", reason: "timeout" })
    const rejected = await downloadMedia({
      item: media(Buffer.alloc(16).toString("base64")),
      fetch: (async () => new Response("SECRET", { status: 403 })) as typeof fetch,
    })
    expect(rejected).toMatchObject({ status: "unavailable", reason: "provider" })
    const invalid = await downloadMedia({
      item: media("not base64 SECRET"),
      fetch: (async () => new Response(Buffer.alloc(16))) as typeof fetch,
    })
    expect(invalid).toMatchObject({ status: "unavailable", reason: "invalid" })
    expect(JSON.stringify([timeout, rejected, invalid])).not.toContain("SECRET")
  })

  test("uploads encrypted bytes with exact allocation fields and returns safe items", async () => {
    const plaintext = Buffer.from("outbound bytes")
    const requests: UploadUrlRequest[] = []
    const posts: Array<{ url: URL; encrypted: Buffer; init: RequestInit }> = []
    const api = {
      getUploadUrl: async (request: UploadUrlRequest) => {
        requests.push(request)
        return { upload_param: "private-upload-param" }
      },
    }
    const kinds = ["image", "video", "file", "voice"] as const
    const results: MessageItem[] = []
    for (const kind of kinds) {
      results.push(
        await uploadMedia({
          kind,
          data: plaintext,
          toUserId: "private-user",
          api,
          filename: "../unsafe?.zip",
          voice: { encodeType: 6, sampleRate: 24_000, playtime: 900 },
          fetch: (async (url, init) => {
            posts.push({ url: new URL(String(url)), encrypted: Buffer.from(init?.body as Uint8Array), init: init! })
            return new Response(null, { status: 200, headers: { "x-encrypted-param": `download-${kind}` } })
          }) as typeof fetch,
        }),
      )
    }
    expect(requests.map((request) => request.media_type)).toEqual([1, 2, 3, 4])
    for (let index = 0; index < requests.length; index++) {
      const request = requests[index]!
      expect(request).toMatchObject({
        to_user_id: "private-user",
        rawsize: plaintext.length,
        rawfilemd5: createHash("md5").update(plaintext).digest("hex"),
        filesize: 16,
        no_need_thumb: true,
      })
      expect(request.filekey).toMatch(/^[0-9a-f]{32}$/)
      expect(request.aeskey).toMatch(/^[0-9a-f]{32}$/)
      const decipher = createDecipheriv("aes-128-ecb", Buffer.from(request.aeskey, "hex"), null)
      expect(Buffer.concat([decipher.update(posts[index]!.encrypted), decipher.final()])).toEqual(plaintext)
      expect(posts[index]!.url.searchParams.get("encrypted_query_param")).toBe("private-upload-param")
      expect(posts[index]!.url.searchParams.get("filekey")).toBe(request.filekey)
      expect(posts[index]!.init.redirect).toBe("error")
    }
    expect(results[0]).toMatchObject({ type: 2, image_item: { mid_size: 16, media: { encrypt_type: 1 } } })
    expect(results[1]).toMatchObject({ type: 5, video_item: { video_size: 16 } })
    expect(results[2]).toMatchObject({
      type: 4,
      file_item: { file_name: "unsafe_.zip", len: String(plaintext.length) },
    })
    expect(results[3]).toMatchObject({ type: 3, voice_item: { encode_type: 6, sample_rate: 24_000, playtime: 900 } })
    expect(JSON.stringify(results)).not.toContain("private-user")
    expect(JSON.stringify(results)).not.toContain("private-upload-param")
  })

  test("fails closed on oversized upload, unsafe allocation URL and missing CDN acknowledgement", async () => {
    const api = { getUploadUrl: async () => ({ upload_full_url: "https://evil.test/upload" }) }
    await expect(
      uploadMedia({ kind: "file", data: new Uint8Array(MAX_MEDIA_BYTES + 1), toUserId: "user", api }),
    ).rejects.toBeInstanceOf(MediaError)
    await expect(uploadMedia({ kind: "file", data: new Uint8Array([1]), toUserId: "user", api })).rejects.toMatchObject(
      { reason: "invalid" },
    )
    let tries = 0
    await expect(
      uploadMedia({
        kind: "image",
        data: new Uint8Array([1]),
        toUserId: "user",
        api: { getUploadUrl: async () => ({ upload_full_url: "https://novac2c.cdn.weixin.qq.com/upload" }) },
        fetch: (async () => {
          tries++
          return new Response(null, { status: 200 })
        }) as typeof fetch,
      }),
    ).rejects.toMatchObject({ reason: "network" })
    expect(tries).toBe(3)
  })

  test("sanitizes platform-independent filenames and limits UTF-8 bytes", () => {
    expect(sanitizeFilename("../../.hidden\\bad:name?.txt")).toBe("bad_name_.txt")
    expect(sanitizeFilename("...")).toBe("attachment.bin")
    expect(sanitizeFilename("CON.txt")).toBe("_CON.txt")
    expect(Buffer.byteLength(sanitizeFilename("测".repeat(200)))).toBeLessThanOrEqual(255)
    expect([...sanitizeFilename("😀".repeat(100))].every((character) => character === "😀")).toBe(true)
  })
})
