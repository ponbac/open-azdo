#!/usr/bin/env bun

import { main } from "../src/main"

process.exitCode = await main(process.argv.slice(2), process.env)
