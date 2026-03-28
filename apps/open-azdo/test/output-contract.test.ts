import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"

const runOutputContract = (jsonLogs: boolean) => {
  const script = `
    import { Effect } from "effect"
    import { makeBaseRuntimeLayer } from "./packages/core/src/BaseRuntimeLayer.ts"
    import { logInfo } from "./packages/core/src/Logging.ts"

    const json = process.env.OPEN_AZDO_TEST_JSON === "true"

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* logInfo("contract log", {
          mode: json ? "json" : "pretty",
        })

        process.stdout.write(json ? '{"result":"ok"}\\n' : "result ok\\n")
      }).pipe(
        Effect.provide(
          makeBaseRuntimeLayer({
            jsonLogs: json,
          }),
        ),
      ),
    )
  `

  return spawnSync("bun", ["-e", script], {
    cwd: "/home/ponbac/dev/open-azdo",
    env: {
      ...process.env,
      OPEN_AZDO_TEST_JSON: jsonLogs ? "true" : "false",
    },
    encoding: "utf8",
  })
}

describe("output contract", () => {
  test("default mode keeps the human result on stdout and pretty logs on stderr", () => {
    const result = runOutputContract(false)

    expect(result.status).toBe(0)
    expect(result.stdout).toBe("result ok\n")
    expect(result.stderr).toContain("contract log")
    expect(result.stderr).toContain("\u001b[")
  })

  test("json mode keeps final JSON on stdout and JSON logs on stderr", () => {
    const result = runOutputContract(true)

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('{"result":"ok"}\n')

    const stderrLine = result.stderr.trim()
    expect(() => JSON.parse(stderrLine)).not.toThrow()
    expect(JSON.parse(stderrLine)).toEqual(
      expect.objectContaining({
        message: "contract log",
        annotations: {
          mode: "json",
        },
      }),
    )
  })
})
