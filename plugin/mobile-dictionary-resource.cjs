'use strict';
const ROOT='00_Archive/5_VocabularyData';
const jobs=new WeakMap();
async function sha256(bytes) {
  if (!globalThis.crypto?.subtle) throw new Error('移动端缺少 SHA-256 校验能力。');
  const hash=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('');
}
async function unpack(adapter,id) {
  let byId=jobs.get(adapter); if(!byId){byId=new Map();jobs.set(adapter,byId)}
  if(byId.has(id))return byId.get(id);
  const pending=(async()=>{
    const manifest=JSON.parse(await adapter.read(ROOT+'/resources.manifest.json'));
    const entry=manifest.resources?.find(x=>x.resourceId===id);
    if(!entry || !/^[\w.-]+\.tar\.gz$/.test(entry.file) || !/^[a-f0-9]{64}$/.test(entry.sha256))throw new Error('词典资源清单无效。');
    const raw=await adapter.readBinary(ROOT+'/'+entry.file);const bytes=new Uint8Array(raw);
    if(bytes.byteLength!==entry.compressedBytes || await sha256(bytes)!==entry.sha256)throw new Error('词典压缩包不完整或校验失败，请等待同步完成。');
    if(typeof DecompressionStream!=='function')throw new Error('当前移动端不支持 gzip 解压。');
    const reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader(),chunks=[];let total=0;
    try {while(true){const {value,done}=await reader.read();if(done)break;total+=value.byteLength;if(total>entry.uncompressedBytes+1048576)throw new Error('词典资源解压超出限制。');chunks.push(value)}}finally{reader.releaseLock()}
    const tar=new Uint8Array(total);let at=0;for(const chunk of chunks){tar.set(chunk,at);at+=chunk.length}
    const decoder=new TextDecoder();const members=new Map();let pos=0,pax=null;
    while(pos+512<=tar.length){const head=tar.subarray(pos,pos+512);pos+=512;if(head.every(x=>x===0))break;
      let name=decoder.decode(head.subarray(0,100)).split('\0')[0];const num=decoder.decode(head.subarray(124,136)).replace(/\0/g,'').trim();const size=parseInt(num,8)||0;const type=head[156];
      if(!Number.isSafeInteger(size)||size<0||pos+size>tar.length)throw new Error('词典包格式错误。');
      if(type===120){let off=pos,end=pos+size;while(off<end){let space=tar.indexOf(32,off),length=Number(decoder.decode(tar.subarray(off,space)));if(space<off||!Number.isSafeInteger(length)||length<=space-off+1||off+length>end)throw new Error('词典包扩展格式错误。');let value=decoder.decode(tar.subarray(space+1,off+length-1));if(!value.startsWith('path='))throw new Error('词典包扩展字段不支持。');pax=value.slice(5);off+=length}pos+=Math.ceil(size/512)*512;continue}
      if(pax){name=pax;pax=null}if(!name||name.includes('\\')||name.startsWith('/')||name.split('/').some(x=>x==='..'||x==='')||![0,48].includes(type)||members.has(name))throw new Error('词典包路径无效。');
      members.set(name,tar.slice(pos,pos+size));pos+=Math.ceil(size/512)*512;
    }
    const meta=JSON.parse(decoder.decode(members.get('package-manifest.json')||new Uint8Array()));
    if(meta?.resourceId!==id||!Array.isArray(meta.files)||members.size!==meta.files.length+1)throw new Error('词典包清单无效。');
    for(const item of meta.files){const data=members.get(item.path);if(!data||data.length!==item.size||await sha256(data)!==item.sha256)throw new Error('词典包内容校验失败。')}
    return members;
  })();byId.set(id,pending);try{return await pending}catch(e){byId.delete(id);throw e}
}
async function read(adapter,id,path,binary=false){
  if(!/^payload\/resource-v[23]\/[\w./-]+$/.test(path)||path.split('/').includes('..'))throw new Error('词典资源路径无效。');
  const members=await unpack(adapter,id),value=members.get(path);if(!value)throw Object.assign(new Error('词典资源不存在。'),{code:'ENOENT'});
  return binary ? value.slice().buffer : new TextDecoder('utf-8',{fatal:true}).decode(value);
}
module.exports={read};
