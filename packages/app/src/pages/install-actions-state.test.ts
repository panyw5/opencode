import { describe, expect, test } from "bun:test"
import {
  installationDownloadHost,
  installationRequest,
  installationSourceLabel,
  type InstallationInput,
  type InstallationIntent,
  type PreparedInstallation,
} from "./install-actions-state"

const input: InstallationInput = {
  sourceType: "release",
  spec: "@example/viewer@2.0.0",
  url: "https://publisher.example/viewer/stable.json",
  sha256: "",
  version: "2.0.0",
  purgeData: false,
  localPath: "",
}
const release: PreparedInstallation["source"] = {
  type: "release",
  descriptor: input.url,
  extensionID: "example.viewer",
  version: "2.0.0",
  artifact: "https://cdn.example/viewer.tgz",
  sha256: "a".repeat(64),
  descriptorSha256: "b".repeat(64),
}
const npm: PreparedInstallation["source"] = {
  type: "npm",
  spec: "@example/viewer@1.0.0",
  registry: "https://registry.npmjs.org/",
  integrity: "sha512-test",
}

describe("extension installation requests", () => {
  test("release needs only a normalized HTTPS descriptor URL, never a user checksum", () => {
    expect(
      installationRequest({ kind: "install" }, { ...input, url: " HTTPS://Publisher.Example:443/viewer/stable.json " }),
    ).toEqual({
      kind: "install",
      source: { type: "release", url: input.url },
    })
    expect(installationRequest({ kind: "install" }, { ...input, sha256: "not-a-checksum" })).toEqual({
      kind: "install",
      source: { type: "release", url: input.url },
    })
  })

  test("release rejects credentials, query, fragment, relative, malformed, and non-HTTPS addresses", () => {
    for (const url of [
      "http://publisher.example/stable.json",
      "https://user:secret@publisher.example/stable.json",
      "https://publisher.example/stable.json?secret=value",
      "https://publisher.example/stable.json#fragment",
      "https://publisher.example/stable.json?",
      "https://publisher.example/stable.json#",
      "/stable.json",
      "file:///tmp/stable.json",
      "https:\\publisher.example/stable.json",
      "https://publisher.example/with space.json",
      "https://publisher.example/\u0000stable.json",
    ])
      expect(installationRequest({ kind: "install" }, { ...input, url })).toBeUndefined()
  })

  test("release updates always use the installed descriptor, ignoring replacement/version inputs", () => {
    const intent: InstallationIntent = { kind: "update", id: "example.viewer", source: release }
    for (const sourceType of ["release", "npm", "archive", "version"] as const) {
      expect(installationRequest(intent, { ...input, sourceType, url: "https://other.example/stable.json" })).toEqual({
        kind: "update",
        id: "example.viewer",
        target: "release-current",
      })
    }
  })

  test("version-only updates require a known npm source and never leak installed source fields", () => {
    const versionInput = { ...input, sourceType: "version" as const }
    expect(installationRequest({ kind: "update", id: "example.viewer", source: npm }, versionInput)).toEqual({
      kind: "update",
      id: "example.viewer",
      version: "2.0.0",
    })
    for (const source of [
      undefined,
      { type: "archive" as const, location: "https://publisher.example/viewer.tgz", sha256: "a".repeat(64) },
      { type: "path" as const, path: "/tmp/viewer" },
    ]) {
      expect(installationRequest({ kind: "update", id: "example.viewer", source }, versionInput)).toBeUndefined()
    }
    expect(installationRequest({ kind: "install" }, versionInput)).toBeUndefined()
  })

  test("archive retains its explicit checksum requirement and npm rejects paths and URLs", () => {
    expect(installationRequest({ kind: "install" }, { ...input, sourceType: "archive" })).toBeUndefined()
    expect(
      installationRequest({ kind: "install" }, { ...input, sourceType: "archive", sha256: "A".repeat(64) }),
    ).toEqual({
      kind: "install",
      source: { type: "archive", url: input.url, sha256: "a".repeat(64) },
    })
    for (const spec of ["https://publisher.example/viewer.tgz", "file:../viewer", "../viewer", "github:owner/repo"]) {
      expect(installationRequest({ kind: "install" }, { ...input, sourceType: "npm", spec })).toBeUndefined()
    }
    expect(
      installationRequest({ kind: "update", id: "example.viewer", source: npm }, { ...input, sourceType: "npm" }),
    ).toEqual({
      kind: "update",
      id: "example.viewer",
      source: { type: "npm", spec: input.spec },
    })
    expect(
      installationRequest(
        { kind: "update", id: "example.viewer", source: { type: "path", path: "/tmp/viewer" } },
        input,
      ),
    ).toBeUndefined()
  })

  test("public labels redact URL secrets and display only the artifact host", () => {
    expect(
      installationSourceLabel({
        ...release,
        descriptor: "https://user:secret@publisher.example/stable.json?token=secret#private",
      }),
    ).toBe("https://publisher.example/stable.json")
    expect(
      installationDownloadHost({
        ...release,
        artifact: "https://user:secret@cdn.example/viewer.tgz?token=secret#private",
      }),
    ).toBe("cdn.example")
    expect(
      installationSourceLabel({
        type: "archive",
        location: "https://user:secret@cdn.example/viewer.tgz?token=secret#private",
        sha256: "a".repeat(64),
      }),
    ).toBe("https://cdn.example/viewer.tgz")
    expect(installationSourceLabel({ ...release, descriptor: "invalid?token=secret" })).toBe("")
    expect(installationDownloadHost({ ...release, artifact: "invalid?token=secret" })).toBe("")
  })
})
