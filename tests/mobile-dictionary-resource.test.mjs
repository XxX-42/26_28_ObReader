import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url), {read}=require('../plugin/mobile-dictionary-resource.cjs');
const digest=b=>createHash('sha256').update(b).digest('hex');
function tar(items){const chunks=[];for(const [name,value] of items){const data=Buffer.from(value),h=Buffer.alloc(512);h.write(name,0);h.write(data.length.toString(8).padStart(11,'0')+'\0',124);h[156]=48;chunks.push(h,data,Buffer.alloc((512-data.length%512)%512))}chunks.push(Buffer.alloc(1024));return Buffer.concat(chunks)}
test('validates and reads mobile dictionary members without writing',async()=>{
 const body=Buffer.from('{"schemaVersion":3}'),name='payload/resource-v3/manifest.json';const meta=JSON.stringify({resourceId:'ECDICT-v3',files:[{path:name,size:body.length,sha256:digest(body)}]});const packed=gzipSync(tar([['package-manifest.json',meta],[name,body]]));let writes=0;
 const manifest={resources:[{resourceId:'ECDICT-v3',file:'ECDICT-v3.tar.gz',sha256:digest(packed),compressedBytes:packed.length,uncompressedBytes:packed.length+4096}]};const adapter={async read(){return JSON.stringify(manifest)},async readBinary(){return packed},async write(){writes++}};
 assert.equal(await read(adapter,'ECDICT-v3',name),body.toString());assert.equal(writes,0);
 await assert.rejects(read(adapter,'ECDICT-v3','payload/resource-v3/../other'),/路径无效/);
});
test('rejects truncated dictionary archive',async()=>{
 const packed=Buffer.from('broken');const adapter={async read(){return JSON.stringify({resources:[{resourceId:'ECDICT-v3',file:'ECDICT-v3.tar.gz',sha256:'a'.repeat(64),compressedBytes:packed.length+1,uncompressedBytes:100}]})},async readBinary(){return packed}};
 await assert.rejects(read(adapter,'ECDICT-v3','payload/resource-v3/manifest.json'),/不完整/);
});
