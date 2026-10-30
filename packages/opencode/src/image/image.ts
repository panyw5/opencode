import { Config } from "@/config/config"
import type { MessageV2 } from "@/session/message-v2"
import * as Log from "@opencode-ai/core/util/log"
import { Context, Effect, Layer, Schema } from "effect"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { normalize as normalizePhoton } from "./photon-runtime"

const MAX_BASE64_BYTES = 5 * 1024 * 1024
const MAX_WIDTH = 2000
const MAX_HEIGHT = 2000
const AUTO_RESIZE = true
const log = Log.create({ service: "image" })

export class ResizerUnavailableError extends Schema.TaggedErrorClass<ResizerUnavailableError>()(
  "ImageResizerUnavailableError",
  {},
) {
  override get message() {
    return "Image resizer is unavailable"
  }
}

export class InvalidDataUrlError extends Schema.TaggedErrorClass<InvalidDataUrlError>()("ImageInvalidDataUrlError", {
  url: Schema.String,
}) {
  override get message() {
    return "Image URL must be a base64 data URL"
  }
}

export class DecodeError extends Schema.TaggedErrorClass<DecodeError>()("ImageDecodeError", {}) {
  override get message() {
    return "Image could not be decoded"
  }
}

export class SizeError extends Schema.TaggedErrorClass<SizeError>()("ImageSizeError", {
  bytes: Schema.Number,
  max: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  max_width: Schema.Number,
  max_height: Schema.Number,
}) {
  override get message() {
    return `Image ${this.width}x${this.height} with base64 size ${this.bytes} exceeds configured limits and could not be resized below ${this.max_width}x${this.max_height}/${this.max} bytes`
  }
}

export type Error = ResizerUnavailableError | InvalidDataUrlError | DecodeError | SizeError

export interface Interface {
  readonly normalize: (input: MessageV2.FilePart) => Effect.Effect<MessageV2.FilePart, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Image") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const normalize = Effect.fn("Image.normalize")(function* (input: MessageV2.FilePart) {
      const image = (yield* config.get()).attachment?.image
      const info = {
        autoResize: image?.auto_resize ?? AUTO_RESIZE,
        maxWidth: image?.max_width ?? MAX_WIDTH,
        maxHeight: image?.max_height ?? MAX_HEIGHT,
        maxBase64Bytes: image?.max_base64_bytes ?? MAX_BASE64_BYTES,
      }
      // File-backed images (e.g. browser screenshots stored as file://
      // attachments) are read from disk here. When the image already fits the
      // limits the input is returned unchanged so the session keeps storing
      // only the path; the resize fallback below still produces an inline
      // data URL because it must replace the bytes.
      let base64: string
      if (input.url.startsWith("file:")) {
        const bytes = yield* Effect.tryPromise({
          try: () => readFile(fileURLToPath(input.url)),
          catch: () => new InvalidDataUrlError({ url: input.url }),
        })
        base64 = bytes.toString("base64")
      } else {
        if (!input.url.startsWith("data:") || !input.url.includes(";base64,"))
          return yield* new InvalidDataUrlError({ url: input.url })
        base64 = input.url.slice(input.url.indexOf(";base64,") + ";base64,".length)
      }
      log.info("normalizing image", { mime: input.mime, base64Bytes: base64.length })
      const result = yield* normalizePhoton(base64, info).pipe(Effect.mapError(() => new ResizerUnavailableError()))
      switch (result.type) {
        case "unchanged":
          return input
        case "decode-error":
          log.warn("failed to decode image")
          return yield* new DecodeError()
        case "size-error":
          log.warn("image exceeds resize limits", { bytes: result.bytes, width: result.width, height: result.height })
          return yield* new SizeError({
            bytes: result.bytes,
            max: info.maxBase64Bytes,
            width: result.width,
            height: result.height,
            max_width: info.maxWidth,
            max_height: info.maxHeight,
          })
        case "resized":
          log.info("using resized image", {
            from_mime: input.mime,
            to_mime: result.mime,
            from: `${result.originalWidth}x${result.originalHeight}`,
            to: `${result.width}x${result.height}`,
          })
          return { ...input, mime: result.mime, url: `data:${result.mime};base64,${result.data}` }
      }
    })

    return Service.of({ normalize })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer))

export * as Image from "./image"
