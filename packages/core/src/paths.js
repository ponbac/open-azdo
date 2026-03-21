export const normalizePath = (value) => value.replaceAll("\\", "/").replace(/^\.\/+/, "")
