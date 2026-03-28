import { describe, expect, test } from "bun:test"

import packageManifest from "../package.json"

describe("package manifest", () => {
  test("does not publish workspace protocol runtime dependencies", () => {
    const runtimeDependencies = packageManifest.dependencies ?? {}

    for (const version of Object.values(runtimeDependencies)) {
      expect(typeof version).toBe("string")
      expect(version.startsWith("workspace:")).toBeFalse()
    }
  })
})
