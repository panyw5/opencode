import { describe, expect, test } from "bun:test"
import { isPublicEmbeddedUIAsset } from "../../src/server/shared/public-ui"

const manifest = {
  "index.html": "/$bunfs/index.html",
  "assets/app.js": "/$bunfs/app.js",
  "assets/app.css": "/$bunfs/app.css",
  "assets/font.woff2": "/$bunfs/font.woff2",
  "assets/icon.svg": "/$bunfs/icon.svg",
  "assets/sound.aac": "/$bunfs/sound.aac",
  "assets/parser.wasm": "/$bunfs/parser.wasm",
  "assets/app.js.map": "/$bunfs/app.js.map",
  "config.json": "/$bunfs/config.json",
  _headers: "/$bunfs/_headers",
  "assets/disguised.js": "/$bunfs/index.html",
}

describe("public embedded UI assets", () => {
  test("allows only exact build assets needed by the browser", () => {
    for (const file of ["app.js", "app.css", "font.woff2", "icon.svg", "sound.aac", "parser.wasm"]) {
      expect(isPublicEmbeddedUIAsset("GET", `/assets/${file}`, manifest)).toBe(true)
    }
  })

  test("keeps HTML, metadata, unknown and noncanonical paths private", () => {
    for (const pathname of [
      "/",
      "/index.html",
      "/assets/missing.js",
      "/config.json",
      "/_headers",
      "/assets/app.js.map",
      "/assets/disguised.js",
      "/constructor",
      "/assets/../assets/app.js",
      "//assets/app.js",
      "/assets/%61pp.js",
      "/assets\\app.js",
    ]) {
      expect(isPublicEmbeddedUIAsset("GET", pathname, manifest)).toBe(false)
    }
  })

  test("requires GET and an available embedded manifest", () => {
    for (const method of ["HEAD", "POST", "PUT", "DELETE", "OPTIONS"]) {
      expect(isPublicEmbeddedUIAsset(method, "/assets/app.js", manifest)).toBe(false)
    }
    expect(isPublicEmbeddedUIAsset("GET", "/assets/app.js", null)).toBe(false)
  })

  test("does not accept inherited manifest keys", () => {
    const inherited = Object.create({ "assets/app.js": "/$bunfs/app.js" })
    expect(isPublicEmbeddedUIAsset("GET", "/assets/app.js", inherited)).toBe(false)
  })
})
