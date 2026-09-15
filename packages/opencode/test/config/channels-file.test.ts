import { test, expect, describe } from "bun:test"
import {
  parseChannelsText,
  serializeChannels,
  stripChannelsKey,
  channelsFilePath,
} from "../../src/config/channels-file"
import { Global } from "@opencode-ai/core/global"
import path from "path"

describe("channels-file", () => {
  test("accepts unbound WeChat but rejects unsafe configured provider origins", () => {
    expect(parseChannelsText('{"wx":{"type":"wechat"}}', "test").wx?.type).toBe("wechat")
    expect(
      parseChannelsText('{"wx":{"type":"wechat","baseUrl":"https://ilinkai.weixin.qq.com/"}}', "test").wx?.type,
    ).toBe("wechat")
    for (const baseUrl of [
      "http://ilinkai.weixin.qq.com",
      "https://evil.test",
      "https://u@ilinkai.weixin.qq.com",
      "https://ilinkai.weixin.qq.com/path",
      "not-a-url",
    ])
      expect(() => parseChannelsText(JSON.stringify({ wx: { type: "wechat", baseUrl } }), "test")).toThrow()
  })
  test("channelsFilePath uses config dir", () => {
    expect(channelsFilePath("/tmp/cfg")).toBe(path.join("/tmp/cfg", "channels.json"))
    expect(channelsFilePath()).toBe(path.join(Global.Path.config, "channels.json"))
  })

  test("parseChannelsText reads flat map", () => {
    const text = JSON.stringify({
      "work-feishu": {
        type: "feishu",
        appId: "cli_x",
        appSecret: "s",
        enabled: true,
      },
    })
    const map = parseChannelsText(text, "test")
    expect(map["work-feishu"]?.type).toBe("feishu")
    if (map["work-feishu"]?.type === "feishu") {
      expect(map["work-feishu"].appId).toBe("cli_x")
    }
  })

  test("parseChannelsText unwraps accidental { channels: ... } wrapper", () => {
    const text = JSON.stringify({
      channels: {
        bot: {
          type: "discord",
          botToken: "t",
        },
      },
    })
    const map = parseChannelsText(text, "test")
    expect(map.bot?.type).toBe("discord")
  })

  test("stripChannelsKey removes top-level channels from jsonc", () => {
    const input = `{
  "$schema": "https://opencode.ai/config.json",
  "model": "a/b",
  "channels": {
    "x": { "type": "feishu", "appId": "1", "appSecret": "2" }
  }
}
`
    const out = stripChannelsKey(input)
    expect(out).not.toContain('"channels"')
    expect(out).toContain('"model"')
    expect(out).toContain('"a/b"')
  })

  test("stripChannelsKey is no-op when channels absent", () => {
    const input = `{ "model": "a/b" }`
    expect(stripChannelsKey(input)).toBe(input)
  })

  test("serializeChannels produces stable JSON", () => {
    const body = serializeChannels({
      a: { type: "discord", botToken: "t" },
    })
    expect(body).toContain('"type": "discord"')
    expect(body.endsWith("\n")).toBe(true)
  })
})
