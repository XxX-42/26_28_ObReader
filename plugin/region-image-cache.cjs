/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
'use strict';

// Disposable cropped PNGs only. Keys include Vault, source version and geometry;
// authoritative annotation/source lookup must succeed before consulting this cache.
function createRegionImageCache(namespace, storage = globalThis.caches) {
  let disposed = false;
  let writes = Promise.resolve();
  async function request(key) {
    const bytes = new TextEncoder().encode(JSON.stringify([namespace,key]));
    const hash = await globalThis.crypto.subtle.digest('SHA-256',bytes);
    const id = [...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('');
    return new Request(`https://obreader.invalid/region-cache/${id}`);
  }
  return {
    async get(key) {
      if (disposed || !storage) return null;
      try {
        const response = await (await storage.open('obreader-cropped-regions-v1')).match(await request(key));
        if (!response || disposed) return null;
        const width=Number(response.headers.get('x-width')),height=Number(response.headers.get('x-height')),cssWidth=Number(response.headers.get('x-css-width'));
        const blob=await response.blob();
        if (!blob.size || blob.size>32*1024*1024 || ![width,height,cssWidth].every(x=>Number.isFinite(x)&&x>0) || width*height>4_005_000) return null;
        return {blob,width,height,cssWidth};
      } catch { return null; }
    },
    async put(key,result) {
      if(disposed || !storage || result.blob.size>32*1024*1024)return;
      const next = writes.then(async () => {
      try {
        const cache=await storage.open('obreader-cropped-regions-v1'),req=await request(key);
        if(disposed)return;
        await cache.delete(req);
        await cache.put(req,new Response(result.blob,{headers:{'content-type':'image/png','x-bytes':String(result.blob.size),'x-width':String(result.width),'x-height':String(result.height),'x-css-width':String(result.cssWidth)}}));
        const keys=await cache.keys();let bytes=0;
        for(let i=keys.length-1;i>=0;i--){const response=await cache.match(keys[i]);bytes+=Number(response?.headers.get('x-bytes')) || 32*1024*1024;
          if(keys.length-i>16 || bytes>32*1024*1024)await cache.delete(keys[i]);}
      } catch { /* Cache failure never changes annotation durability. */ }
      });
      writes = next.catch(()=>{});
      return next;
    },
    dispose(){disposed=true;},
  };
}
module.exports={createRegionImageCache};
