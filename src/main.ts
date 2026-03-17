import { runCliWithExitHandling } from "./cli"

export const main = async (argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv) => {
  const exitCode = await runCliWithExitHandling(argv, env)
  process.exit(exitCode)
}
