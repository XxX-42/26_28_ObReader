"use strict";
const {PDFDocument,PDFArray,PDFDict,PDFName,PDFRef}=require('pdf-lib');
const {captureIncrementalSnapshot,createIncrementalPatch,materializeIncrementalResult}=require('./pdf-incremental.cjs');
const {validatePairId,readPairId}=require('./pdf-pair-id.cjs');
const SUPPORTED=new Set(['Highlight','Underline','Square','Ink','InkHighlight','FreeText']);
const fail=(code,message)=>Object.assign(new Error(message),{code});
// PDF.js can expose a native Ink annotation through its freehand highlight
// editor. The exact page/ref remains authoritative; do not allow Link or other
// subtypes through this compatibility mapping.
function matchesSubtype(target,kind){
  if(!(target instanceof PDFDict))return false;
  const subtype=target.get(PDFName.of('Subtype'));
  return subtype===PDFName.of(kind==='InkHighlight'?'Highlight':kind)||
    ((kind==='Highlight'||kind==='InkHighlight')&&subtype===PDFName.of('Ink'));
}

// Produces an append-only patch that removes one exact supported annotation
// reference from one page. It never rewrites the annotation object or links.
async function prepareNativeErase({sourceBytes,pairId,pageIndex,ref,kind,allowUnpairedPreview=false}){
  const bytes=sourceBytes instanceof Uint8Array?sourceBytes:new Uint8Array(sourceBytes);
  const normalizedRef=typeof ref==='string'&&/^\d+R$/.test(ref)?ref.replace(/R$/,' 0 R'):ref;
  if(!Number.isSafeInteger(pageIndex)||pageIndex<0||typeof normalizedRef!=='string'||!/^\d+\s+\d+\s+R$/.test(normalizedRef)||!SUPPORTED.has(kind))
    throw fail('PDF_NATIVE_ERASE_TARGET_INVALID','The native erase target is invalid.');
  const pdf=await PDFDocument.load(bytes,{updateMetadata:false,throwOnInvalidObject:true});
  const actualPairId=await readPairId(bytes);
  if(pairId==null&&allowUnpairedPreview){
    if(actualPairId!==null)throw fail('PDF_NATIVE_ERASE_PAIR_MISMATCH','The PDF already belongs to a different annotation pair.');
  }else{
    validatePairId(pairId);
    if(actualPairId!==pairId)throw fail('PDF_NATIVE_ERASE_PAIR_MISMATCH','The PDF pair identity changed.');
  }
  if(pdf.catalog.has(PDFName.of('Perms')))throw fail('PDF_NATIVE_ERASE_UNSUPPORTED','A permission signature prevents PDF modification.');
  for(const [,object] of pdf.context.enumerateIndirectObjects())if(object instanceof PDFDict&&
    (object.get(PDFName.of('Type'))===PDFName.of('Sig')||object.get(PDFName.of('FT'))===PDFName.of('Sig')))
    throw fail('PDF_NATIVE_ERASE_UNSUPPORTED','Signed PDFs are not modified.');
  const page=pdf.getPages()[pageIndex];if(!page)throw fail('PDF_NATIVE_ERASE_PAGE_INVALID','The target page is outside the PDF.');
  const key=PDFName.of('Annots'),rawAnnots=page.node.get(key),annots=page.node.lookupMaybe(key,PDFArray);
  if(!annots)throw fail('PDF_NATIVE_ERASE_REFERENCE_MISSING','The target annotation is no longer on this page.');
  if(rawAnnots instanceof PDFRef&&pdf.getPages().some((other,index)=>index!==pageIndex&&other.node.get(key)?.toString()===rawAnnots.toString()))
    throw fail('PDF_NATIVE_ERASE_SHARED_ANNOTS','The target page shares its annotation array with another page.');
  const matches=[];
  for(let i=0;i<annots.size();i++){const item=annots.get(i);if(item instanceof PDFRef&&item.toString()===normalizedRef)matches.push(i);}
  if(matches.length!==1)throw fail('PDF_NATIVE_ERASE_REFERENCE_AMBIGUOUS','The target reference is missing or duplicated on this page.');
  const targetRef=annots.get(matches[0]),target=pdf.context.lookup(targetRef);
  if(!matchesSubtype(target,kind))
    throw fail('PDF_NATIVE_ERASE_KIND_MISMATCH',`无法擦除 PDF 内嵌批注：第 ${pageIndex+1} 页引用 ${normalizedRef} 的实际类型为 ${target instanceof PDFDict ? String(target.get(PDFName.of('Subtype'))||'未知') : '非批注对象'}，与编辑器类型 ${kind} 不匹配。原 PDF 未修改。`);
  const snapshot=captureIncrementalSnapshot({sourceBytes:bytes,document:pdf});
  annots.remove(matches[0]);
  const patch=createIncrementalPatch({sourceBytes:bytes,document:pdf,snapshot});
  if(!patch||patch.changedObjectCount!==1)throw fail('PDF_NATIVE_ERASE_PATCH_UNSAFE','The erase patch changed unexpected PDF objects.');
  const result=materializeIncrementalResult({sourceBytes:bytes,patch}).bytes;
  if(await readPairId(result)!==pairId)throw fail('PDF_NATIVE_ERASE_VERIFY_FAILED','The PDF pair identity was not preserved.');
  const verified=await PDFDocument.load(result,{updateMetadata:false,throwOnInvalidObject:true});
  const remaining=verified.getPages()[pageIndex].node.lookupMaybe(key,PDFArray);
  if(!remaining||Array.from({length:remaining.size()},(_,i)=>remaining.get(i)).some(item=>item instanceof PDFRef&&item.toString()===normalizedRef))
    throw fail('PDF_NATIVE_ERASE_VERIFY_FAILED','The erased reference remains on its page.');
  return {bytes:result,pairId,ref:normalizedRef,pageIndex,kind,baseLength:bytes.length,outputLength:result.length,
    beforeHash:patch.baseFingerprint,afterHash:patch.outputFingerprint,changedObjectCount:patch.changedObjectCount};
}

async function getNativeAnnotationIndex({sourceBytes,pairId,pageIndex,ref,kind}){
  const bytes=sourceBytes instanceof Uint8Array?sourceBytes:new Uint8Array(sourceBytes);
  const normalizedRef=typeof ref==='string'&&/^\d+R$/.test(ref)?ref.replace(/R$/,' 0 R'):ref;
  const pdf=await PDFDocument.load(bytes,{updateMetadata:false,throwOnInvalidObject:true});
  if(await readPairId(bytes)!==pairId)throw fail('PDF_NATIVE_ERASE_PAIR_MISMATCH','The PDF pair identity changed.');
  const page=pdf.getPages()[pageIndex],annots=page?.node.lookupMaybe(PDFName.of('Annots'),PDFArray);
  if(!annots)throw fail('PDF_NATIVE_ERASE_REFERENCE_MISSING','The target annotation is no longer on this page.');
  const matches=[];
  for(let i=0;i<annots.size();i++)if(annots.get(i) instanceof PDFRef&&annots.get(i).toString()===normalizedRef)matches.push(i);
  const target=matches.length===1?pdf.context.lookup(annots.get(matches[0])):null;
  if(!matchesSubtype(target,kind))
    throw fail('PDF_NATIVE_ERASE_KIND_MISMATCH',`无法擦除 PDF 内嵌批注：第 ${pageIndex+1} 页引用 ${normalizedRef} 的实际类型为 ${target instanceof PDFDict ? String(target.get(PDFName.of('Subtype'))||'未知') : '非批注对象'}，与编辑器类型 ${kind} 不匹配。原 PDF 未修改。`);
  return {index:matches[0],ref:normalizedRef,pageIndex,kind};
}

async function prepareNativeRestore({sourceBytes,pairId,pageIndex,ref,kind,index}){
  validatePairId(pairId);
  const bytes=sourceBytes instanceof Uint8Array?sourceBytes:new Uint8Array(sourceBytes);
  const normalizedRef=typeof ref==='string'&&/^\d+R$/.test(ref)?ref.replace(/R$/,' 0 R'):ref;
  if(!Number.isSafeInteger(pageIndex)||pageIndex<0||!Number.isSafeInteger(index)||index<0||
      typeof normalizedRef!=='string'||!/^\d+\s+\d+\s+R$/.test(normalizedRef)||!SUPPORTED.has(kind))
    throw fail('PDF_NATIVE_RESTORE_TARGET_INVALID','The native restore proof is invalid.');
  const pdf=await PDFDocument.load(bytes,{updateMetadata:false,throwOnInvalidObject:true});
  if(await readPairId(bytes)!==pairId)throw fail('PDF_NATIVE_RESTORE_PAIR_MISMATCH','The PDF pair identity changed.');
  if(pdf.catalog.has(PDFName.of('Perms')))throw fail('PDF_NATIVE_RESTORE_UNSUPPORTED','A permission signature prevents PDF modification.');
  for(const [,object] of pdf.context.enumerateIndirectObjects())if(object instanceof PDFDict&&
    (object.get(PDFName.of('Type'))===PDFName.of('Sig')||object.get(PDFName.of('FT'))===PDFName.of('Sig')))
    throw fail('PDF_NATIVE_RESTORE_UNSUPPORTED','Signed PDFs are not modified.');
  const page=pdf.getPages()[pageIndex];if(!page)throw fail('PDF_NATIVE_RESTORE_PAGE_INVALID','The target page is outside the PDF.');
  const key=PDFName.of('Annots'),rawAnnots=page.node.get(key),annots=page.node.lookupMaybe(key,PDFArray);
  if(rawAnnots instanceof PDFRef&&pdf.getPages().some((other,i)=>i!==pageIndex&&other.node.get(key)?.toString()===rawAnnots.toString()))
    throw fail('PDF_NATIVE_RESTORE_SHARED_ANNOTS','The target page shares its annotation array with another page.');
  if(!annots)throw fail('PDF_NATIVE_RESTORE_REFERENCE_MISSING','The page annotation array is missing.');
  if(Array.from({length:annots.size()},(_,i)=>annots.get(i)).some(item=>item instanceof PDFRef&&item.toString()===normalizedRef))
    throw fail('PDF_NATIVE_RESTORE_REFERENCE_PRESENT','The native annotation is already present on this page.');
  const target=pdf.context.lookup(PDFRef.of(...normalizedRef.match(/^(\d+)\s+(\d+)\s+R$/).slice(1,3).map(Number)));
  if(!matchesSubtype(target,kind))
    throw fail('PDF_NATIVE_RESTORE_PROOF_INVALID','The referenced source annotation cannot be verified.');
  if(index>annots.size())throw fail('PDF_NATIVE_RESTORE_INDEX_INVALID','The original annotation position is no longer available.');
  const snapshot=captureIncrementalSnapshot({sourceBytes:bytes,document:pdf});
  annots.insert(index,PDFRef.of(...normalizedRef.match(/^(\d+)\s+(\d+)\s+R$/).slice(1,3).map(Number)));
  const patch=createIncrementalPatch({sourceBytes:bytes,document:pdf,snapshot});
  if(!patch||patch.changedObjectCount!==1)throw fail('PDF_NATIVE_RESTORE_PATCH_UNSAFE','The restore patch changed unexpected PDF objects.');
  const result=materializeIncrementalResult({sourceBytes:bytes,patch}).bytes;
  if(await readPairId(result)!==pairId)throw fail('PDF_NATIVE_RESTORE_VERIFY_FAILED','The PDF pair identity was not preserved.');
  const verified=await PDFDocument.load(result,{updateMetadata:false,throwOnInvalidObject:true});
  const restored=verified.getPages()[pageIndex].node.lookupMaybe(key,PDFArray);
  if(!restored||restored.get(index)?.toString()!==normalizedRef)throw fail('PDF_NATIVE_RESTORE_VERIFY_FAILED','The original annotation was not restored at its saved position.');
  return {bytes:result,pairId,ref:normalizedRef,pageIndex,kind,index,baseLength:bytes.length,outputLength:result.length,
    beforeHash:patch.baseFingerprint,afterHash:patch.outputFingerprint,changedObjectCount:patch.changedObjectCount};
}

module.exports={prepareNativeErase,prepareNativeRestore,getNativeAnnotationIndex};
