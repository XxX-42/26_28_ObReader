'use strict';
// Read-only adapter for the desktop compressed learning store. Never creates
// missing stores or changes synced user data on an unsupported platform.
const ROOT = '00_Archive/7_LeitnerData';
const PREFIX = '00_Archive/5_VocabularyData/';
function category(p) {
  if (typeof p !== 'string') return null;
  for (const kind of ['history', 'review']) {
    const prefix = PREFIX + kind;
    if (p === prefix || p.startsWith(prefix + '/')) return kind;
  }
  return null;
}
async function decompress(bytes) {
  if (typeof DecompressionStream !== 'function') throw new Error('移动端不支持 gzip 解压，无法读取学习记录。');
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}
function wrapApp(app) {
  const original = app.vault.adapter;
  const cache = new Map();
  async function load(kind) {
    const file = `${ROOT}/${kind}.jsonl.gz`;
    const info = await original.stat(file);
    if (!info || info.type !== 'file') throw new Error(`学习记录文件缺失：${file}；不会创建空记录。`);
    const prior = cache.get(kind);
    if (prior && prior.size === info.size && prior.mtime === info.mtime) return prior.rows;
    const txt = await decompress(await original.readBinary(file));
    const rows = new Map();
    for (const line of txt.split('\n')) {
      if (!line) continue;
      const item = JSON.parse(line);
      if (category(item.path) !== kind || typeof item.text !== 'string' || rows.has(item.path)) throw new Error(`学习记录格式无效：${file}`);
      rows.set(item.path, item.text);
    }
    cache.set(kind, {size: info.size, mtime: info.mtime, rows});
    return rows;
  }
  const adapter = new Proxy(original, { get(target, key) {
    if (['read','write','exists','list','mkdir','remove','rename','stat','append'].includes(key)) return async (...args) => {
      const p = args[0], kind = category(p), destKind = key === 'rename' && category(args[1]);
      if (!kind && !destKind) return target[key](...args);
      if (['write','append','mkdir','remove','rename'].includes(key)) throw new Error('移动端学习记录当前为只读：等待安全写入适配，不会修改已有数据。');
      const rows = await load(kind);
      const isDir = [...rows.keys()].some(x => x.startsWith(p + '/'));
      if (key === 'read') { if (!rows.has(p)) throw Object.assign(new Error('学习记录不存在：' + p), {code:'ENOENT'}); return rows.get(p); }
      if (key === 'exists') return rows.has(p) || isDir;
      if (key === 'stat') return rows.has(p) ? {type:'file',size:new TextEncoder().encode(rows.get(p)).length,mtime:0,ctime:0} : isDir ? {type:'folder',size:0,mtime:0,ctime:0} : null;
      if (key === 'list') { const files=[], folders=new Set(); for (const name of rows.keys()) { if (!name.startsWith(p+'/')) continue; const sub=name.slice(p.length+1); if (sub.includes('/')) folders.add(p+'/'+sub.split('/')[0]); else files.push(name); } return {files,folders:[...folders]}; }
    };
    const value=Reflect.get(target,key); return typeof value === 'function' ? value.bind(target) : value;
  }});
  const vault = new Proxy(app.vault,{get(target,key){if(key==='adapter')return adapter;const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  return new Proxy(app,{get(target,key){if(key==='vault')return vault;const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
}
module.exports={wrapApp};
