export const normalizePath = (value: string) => value.replaceAll("\\", "/").replace(/^\.\/+/, "")
