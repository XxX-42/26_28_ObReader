import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {PDFDocument,PDFDict,PDFName,PDFArray,PDFString}=require('pdf-lib');
const {ensurePairId}=require('../plugin/pdf-pair-id.cjs');
const {prepareNativeErase}=require('../plugin/pdf-native-erase.cjs');

async function fixture(){
  const pdf=await PDFDocument.create(),page=pdf.addPage([300,400]),ctx=pdf.context;
  const mark=PDFDict.withContext(ctx);mark.set(PDFName.of('Type'),PDFName.of('Annot'));mark.set(PDFName.of('Subtype'),PDFName.of('Highlight'));mark.set(PDFName.of('Contents'),PDFString.of('keep source text'));
  const markRef=ctx.register(mark);
  const link=PDFDict.withContext(ctx);link.set(PDFName.of('Type'),PDFName.of('Annot'));link.set(PDFName.of('Subtype'),PDFName.of('Link'));
  const linkRef=ctx.register(link);
  const annots=PDFArray.withContext(ctx);annots.push(markRef);annots.push(linkRef);page.node.set(PDFName.of('Annots'),annots);
  const original=await pdf.save({useObjectStreams:false,updateFieldAppearances:false});
  const paired=await ensurePairId(new Uint8Array(original),'ab'.repeat(16));
  return {bytes:paired.bytes,ref:markRef.toString(),linkRef:linkRef.toString(),pairId:paired.pairId};
}

test('native erase appends exact Annots deletion and preserves pair, content, and links',async()=>{
  const f=await fixture(),result=await prepareNativeErase({sourceBytes:f.bytes,pairId:f.pairId,ref:f.ref,pageIndex:0,kind:'Highlight'});
  assert.ok(result.bytes.length>f.bytes.length);
  const before=await PDFDocument.load(f.bytes,{updateMetadata:false}),after=await PDFDocument.load(result.bytes,{updateMetadata:false});
  assert.equal(await require('../plugin/pdf-pair-id.cjs').readPairId(result.bytes),f.pairId);
  assert.equal(after.getPages()[0].node.lookupMaybe(PDFName.of('Annots'),PDFArray).size(),1);
  assert.equal(after.getPages()[0].node.lookupMaybe(PDFName.of('Annots'),PDFArray).get(0).toString(),f.linkRef);
  assert.equal(before.getPages()[0].node.lookupMaybe(PDFName.of('Annots'),PDFArray).size(),2);
  assert.equal(after.context.lookup(after.getPages()[0].node.lookupMaybe(PDFName.of('Annots'),PDFArray).get(0)).get(PDFName.of('Subtype')).toString(),'/Link');
  await assert.rejects(prepareNativeErase({sourceBytes:f.bytes,pairId:f.pairId,pageIndex:0,ref:f.linkRef,kind:'Highlight'}),{code:'PDF_NATIVE_ERASE_KIND_MISMATCH'});
});
