export const normalizePath = (value: string) => value.replaceAll("\\", "/").replace(/^\.\/+/, "")

/** Preserves exact Git filenames, including literal backslashes, before accepting separator aliases. */
export const resolveRepositoryPath = (value: string, knownPaths: { readonly has: (path: string) => boolean }) => {
  if (knownPaths.has(value)) return value

  const relativePath = value.replace(/^\.\/+/, "")

  return knownPaths.has(relativePath) ? relativePath : normalizePath(value)
}
