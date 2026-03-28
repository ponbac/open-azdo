# sandbox

Local PR replay app for `open-azdo sandbox capture` artifacts.

## Run

From the repo root:

```bash
bun run sandbox:dev
```

The Vite dev server binds to `http://127.0.0.1:4317`.

To preview the production build instead:

```bash
bun run sandbox:preview
```

That serves the built app on `http://127.0.0.1:4318`.

## Usage

- the app boots with a bundled demo capture
- import a real capture JSON with the file picker or drag-and-drop
- use the `before` and `after` toggle to compare imported AZDO threads with projected managed-comment output
- click findings or threads to jump the diff view to the related file

## Validation

The sandbox app is intentionally validated with:

- `bun run --cwd apps/sandbox typecheck`
- `bun run --cwd apps/sandbox build`
- manual browser smoke with the `playwriter` skill against `http://127.0.0.1:4317`

Recommended Playwriter flow:

1. start `bun run sandbox:dev`
2. open `http://127.0.0.1:4317`
3. verify the demo capture renders
4. import a real capture from `open-azdo sandbox capture`
5. verify before/after toggle and thread-to-diff navigation
