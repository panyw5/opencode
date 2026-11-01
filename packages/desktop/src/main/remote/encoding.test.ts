import { expect, test } from "bun:test"
import { acceptsGzip } from "./encoding"

test("gzip negotiation honors explicit denials, wildcard and invalid quality values", () => {
  for (const header of [undefined, "br", "gzip;q=0", "gzip;q=0, *;q=1", "gzip;q=no", "gzip;q=2"]) {
    expect(acceptsGzip(header)).toBe(false)
  }
  for (const header of ["gzip", "br, gzip;q=0.5", "*;q=0.5", "GZIP; Q=1"]) {
    expect(acceptsGzip(header)).toBe(true)
  }
})
