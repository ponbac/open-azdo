Clone all mentioned repositories under ./.reference and create an AGENTS.md file where you mention which repositories live there, and their roles. There should also be a ./scripts/pull-ref-repos.sh which does a shallow clone of these repos, removing existing repo clones before grabbing a new one.

https://github.com/trojanmartin/opencode-azdo-extension I want to create something similar to this, this is the inspiration. My version should not be a Marketplace Extension, it should be a Bun CLI which can easily be used in an Azure DevOps pipeline, and the repo should contain a reference implementation of such a pipeline-file.

I want to care about security, the inspiration repo has these issues:
PAT logged in plaintext — git.ts logs the full git clone URL including the PAT token to stdout, meaning credentials appear in pipeline logs
No test suite — Zero tests for a security-sensitive tool that handles credentials
Medium priority:
Shell injection surface — exec() in git.ts uses string interpolation for branch names/paths rather than argument arrays. A crafted branch name could potentially inject shell commands
Command mode risk — AI agent gets full repo write access and can push commits. Prompt injection via PR descriptions/comments could be exploited
Hardcoded port — OpenCode server always binds to 127.0.0.1:4096, so concurrent runs on the same agent would conflict
Silent failures — Review comment script catches errors and exit(0), so the AI never knows a comment failed to post

The CLI should be built with Effect v4 beta, here is a great inspiration for coding style: https://github.com/kitlangton/tailcode. Also copy the linting and formatting with ox from there, along with other great dependencies and patterns. Make sure that the newest versions of these packages are used.

Also grab the entire Effect v4 beta: https://effect.website/blog/releases/effect/40-beta/ and put it under .reference

Rememeber that Effect has a ton of great modules for practically everything, which can make this implementation secure, concise, and easy to read.

Grab the repos, create the AGENTS.md and start planning the implementation. Ask me about any uncertainties.
