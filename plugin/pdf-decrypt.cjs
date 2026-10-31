'use strict';
const { PDFDocument } = require('pdf-lib');
async function decryptPdfBytes(plugin, bytes) {
  const [javascript, wasm] = await Promise.all([plugin.readVerifiedAsset('web/decrypt/qpdf.js'), plugin.readVerifiedAsset('web/decrypt/qpdf.wasm')]);
  const handler = `\nonmessage=async e=>{try{const wasmUrl=URL.createObjectURL(new Blob([e.data.wasm],{type:"application/wasm"}));const m=await Module({locateFile:()=>wasmUrl,noInitialRun:true,print:()=>{},printErr:()=>{}});m.FS.writeFile('/input.pdf',e.data.bytes);const result=m.callMain(['--password=','--decrypt','/input.pdf','/output.pdf']);if(result!==0&&result!==3)throw Error('解密失败，可能需要打开密码');const output=m.FS.readFile('/output.pdf');postMessage({output},[output.buffer]);}catch(error){postMessage({error:String(error?.message||error)})}}`;
  const url=URL.createObjectURL(new Blob([javascript,handler],{type:'text/javascript'}));
  const worker=new Worker(url);
  try { return await new Promise((resolve,reject)=>{worker.onmessage=e=>e.data.error?reject(Error(e.data.error)):resolve(e.data.output);worker.onerror=e=>reject(Error(e.message));worker.postMessage({bytes,wasm});}); }
  finally {worker.terminate();URL.revokeObjectURL(url);}
}
async function validateDecrypted(bytes, expectedPages) {
  const pdf=await PDFDocument.load(bytes,{updateMetadata:false});
  if(pdf.isEncrypted||pdf.getPageCount()!==expectedPages)throw Error('解密结果校验失败，原文件未覆盖');
  return bytes;
}
module.exports={decryptPdfBytes,validateDecrypted,readPairId:require('./pdf-pair-id.cjs').readPairId};
