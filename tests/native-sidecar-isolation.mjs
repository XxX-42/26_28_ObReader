const ADAPTER_PATH_METHODS = new Set([
  "read", "write", "readBinary", "writeBinary", "append", "appendBinary",
  "remove", "rename", "exists", "mkdir", "list", "process",
]);

export function mapNativeSidecarPath(value, sourceRoot, targetRoot) {
  if (typeof value !== "string") return value;
  const source = sourceRoot.replace(/\/+$/, "");
  const target = targetRoot.replace(/\/+$/, "");
  if (value === source) return target;
  if (value.startsWith(`${source}/`)) return `${target}${value.slice(source.length)}`;
  return value;
}

export function mapNativeSidecarAdapterArgs(method, args, sourceRoot, targetRoot) {
  if (!ADAPTER_PATH_METHODS.has(method)) return [...args];
  const mapped = [...args];
  mapped[0] = mapNativeSidecarPath(mapped[0], sourceRoot, targetRoot);
  if (method === "rename" && typeof mapped[1] === "string") {
    mapped[1] = mapNativeSidecarPath(mapped[1], sourceRoot, targetRoot);
  }
  return mapped;
}
