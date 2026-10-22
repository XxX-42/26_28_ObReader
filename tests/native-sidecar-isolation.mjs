const ADAPTER_PATH_METHODS = new Set([
  "read", "write", "readBinary", "writeBinary", "append", "appendBinary",
  "remove", "rename", "exists", "mkdir", "list", "process",
  "removeFile", "update", "copy", "copyRecursive",
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
  if (["rename", "copy", "copyRecursive"].includes(method) && typeof mapped[1] === "string") {
    mapped[1] = mapNativeSidecarPath(mapped[1], sourceRoot, targetRoot);
  }
  return mapped;
}

export function mapNativeSidecarListResult(result, physicalRoot, virtualRoot) {
  if (!result || typeof result !== "object") return result;
  const mapEntries = (entries) => Array.isArray(entries)
    ? entries.map((entry) => mapNativeSidecarPath(entry, physicalRoot, virtualRoot))
    : entries;
  return {
    ...result,
    ...(Array.isArray(result.files) ? { files: mapEntries(result.files) } : {}),
    ...(Array.isArray(result.folders) ? { folders: mapEntries(result.folders) } : {}),
  };
}

export function serializeNativeSidecarAdapterMapper() {
  return [
    `const ADAPTER_PATH_METHODS = new Set(${JSON.stringify([...ADAPTER_PATH_METHODS])});`,
    `const mapNativeSidecarPath = (${mapNativeSidecarPath.toString()});`,
    `const mapNativeSidecarAdapterArgs = (${mapNativeSidecarAdapterArgs.toString()});`,
    `const mapNativeSidecarListResult = (${mapNativeSidecarListResult.toString()});`,
  ].join("\n");
}
