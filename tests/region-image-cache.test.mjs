import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createRegionImageCache}=require('../plugin/region-image-cache.cjs');
function storage(){const rows=new Map();return {rows,async open(){return {
  async match(req){return rows.get(req.url)?.clone();},async put(req,res){rows.set(req.url,res.clone());},
  async delete(req){return rows.delete(req.url);},async keys(){return [...rows.keys()].map(x=>new Request(x));},
};}};}
const image=()=>({blob:new Blob(['png-fixture'],{type:'image/png'}),width:10,height:10,cssWidth:10});
test('cropped image cache survives runtime disposal and isolates Vault/source/geometry keys',async()=>{
  const backing=storage(),a=createRegionImageCache('A',backing);await a.put('source1:rect1',image());a.dispose();
  const reopened=createRegionImageCache('A',backing);assert.equal((await reopened.get('source1:rect1')).blob.size,11);
  assert.equal(await reopened.get('source2:rect1'),null);assert.equal(await reopened.get('source1:rect2'),null);
  assert.equal(await createRegionImageCache('B',backing).get('source1:rect1'),null);
});
test('cropped image cache evicts old entries and fails softly when storage is unavailable',async()=>{
  const backing=storage(),cache=createRegionImageCache('A',backing);
  await Promise.all(Array.from({length:18},(_,i)=>cache.put(String(i),image())));
  assert.equal(backing.rows.size,16);assert.equal(await cache.get('0'),null);assert.ok(await cache.get('17'));
  assert.equal(await createRegionImageCache('A',{open(){throw Error('disk full')}}).get('x'),null);
  await createRegionImageCache('A',{open(){throw Error('disk full')}}).put('x',image());
});
