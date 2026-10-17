// DataAdapter contract fixture shared by cross-platform/fault/stress tests.
// It models APIs available on desktop and Capacitor, with no fs/process API.
export class VocabularyMemoryAdapter {
  constructor({ append = true, hook = null } = {}) {
    this.files = new Map();
    this.directories = new Set([""]);
    this.hook = hook;
    this.resetMetrics();
    if (!append) this.append = undefined;
  }
  resetMetrics() {
    this.metrics = { readBytes: 0, writtenBytes: 0, reads: 0, writes: 0, appends: 0, renames: 0, removes: 0, filesTouched: new Set() };
  }
  measured() {
    return { ...this.metrics, filesTouched: [...this.metrics.filesTouched].sort(), fileCount: this.files.size, directoryCount: this.directories.size };
  }
  async event(phase, operation, details) { await this.hook?.({ phase, operation, ...details, adapter: this }); }
  async exists(path) { return this.files.has(path) || this.directories.has(path); }
  async mkdir(path) {
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (path.includes("/") && !this.directories.has(parent)) throw Error(`Missing parent: ${parent}`);
    this.directories.add(path);
  }
  async read(path) {
    await this.event("before", "read", { path });
    if (!this.files.has(path)) throw Error(`Missing file: ${path}`);
    const text = this.files.get(path);
    this.metrics.reads++;
    this.metrics.readBytes += new TextEncoder().encode(text).byteLength;
    await this.event("after", "read", { path, text });
    return text;
  }
  async write(path, text) {
    if (typeof text !== "string") throw TypeError("DataAdapter.write requires text");
    await this.event("before", "write", { path, text });
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (path.includes("/") && !this.directories.has(parent)) throw Error(`Missing parent: ${parent}`);
    this.files.set(path, text);
    this.metrics.writes++;
    this.metrics.writtenBytes += new TextEncoder().encode(text).byteLength;
    this.metrics.filesTouched.add(path);
    await this.event("after", "write", { path, text });
  }
  async append(path, text) {
    await this.event("before", "append", { path, text });
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (path.includes("/") && !this.directories.has(parent)) throw Error(`Missing parent: ${parent}`);
    this.files.set(path, (this.files.get(path) || "") + text);
    this.metrics.appends++;
    this.metrics.writtenBytes += new TextEncoder().encode(text).byteLength;
    this.metrics.filesTouched.add(path);
    await this.event("after", "append", { path, text });
  }
  async rename(from, to) {
    await this.event("before", "rename", { from, to });
    if (!this.files.has(from) || this.files.has(to)) throw Error(`Invalid rename: ${from} -> ${to}`);
    this.files.set(to, this.files.get(from));
    this.files.delete(from);
    this.metrics.renames++;
    this.metrics.filesTouched.add(from);
    this.metrics.filesTouched.add(to);
    await this.event("after", "rename", { from, to });
  }
  async remove(path) {
    await this.event("before", "remove", { path });
    this.files.delete(path);
    this.metrics.removes++;
    this.metrics.filesTouched.add(path);
    await this.event("after", "remove", { path });
  }
  async list(path) {
    const prefix = `${path}/`;
    const direct = (name) => name.startsWith(prefix) && !name.slice(prefix.length).includes("/");
    return { files: [...this.files.keys()].filter(direct).sort(), folders: [...this.directories].filter(direct).sort() };
  }
}
