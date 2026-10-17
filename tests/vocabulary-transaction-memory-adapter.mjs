export class MemoryDataAdapter {
  constructor() {
    this.files = new Map();
    this.directories = new Set([""]);
    this.renameHook = null;
  }

  _parent(path) {
    const index = path.lastIndexOf("/");
    return index < 0 ? "" : path.slice(0, index);
  }

  _addParents(path) {
    let current = this._parent(path);
    while (current && !this.directories.has(current)) {
      this.directories.add(current);
      current = this._parent(current);
    }
  }

  async exists(path) {
    return this.files.has(path) || this.directories.has(path);
  }

  async read(path) {
    if (!this.files.has(path)) throw new Error(`missing file: ${path}`);
    return this.files.get(path);
  }

  async write(path, text) {
    this._addParents(path);
    this.files.set(path, text);
  }

  async rename(from, to) {
    if (!this.files.has(from)) throw new Error(`missing rename source: ${from}`);
    if (this.files.has(to)) throw new Error(`rename target exists: ${to}`);
    if (this.renameHook) await this.renameHook(from, to, this);
    this._addParents(to);
    this.files.set(to, this.files.get(from));
    this.files.delete(from);
  }

  async remove(path) {
    this.files.delete(path);
  }

  async mkdir(path) {
    this.directories.add(path);
    let current = this._parent(path);
    while (current && !this.directories.has(current)) {
      this.directories.add(current);
      current = this._parent(current);
    }
  }

  async list(path) {
    const prefix = path ? `${path}/` : "";
    const files = [];
    const folders = [];
    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(prefix)) continue;
      const tail = filePath.slice(prefix.length);
      if (tail && !tail.includes("/")) files.push(filePath);
    }
    for (const folderPath of this.directories) {
      if (!folderPath.startsWith(prefix) || folderPath === path) continue;
      const tail = folderPath.slice(prefix.length);
      if (tail && !tail.includes("/")) folders.push(folderPath);
    }
    return { files: files.sort(), folders: folders.sort() };
  }

  filePaths(prefix = "") {
    return [...this.files.keys()].filter((path) => path.startsWith(prefix)).sort();
  }
}
