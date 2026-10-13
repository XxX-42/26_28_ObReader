import assert from "node:assert/strict";
import test from "node:test";
import {
  PDFArray,
  PDFDocument,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
} from "pdf-lib";
import incremental from "../plugin/pdf-incremental.cjs";

const { captureIncrementalSnapshot, createIncrementalPatch, readSourceTrailer, fingerprint } = incremental;

async function sourcePdf({ objectStreams = false } = {}) {
  const document = await PDFDocument.create();
  document.addPage([320, 240]);
  const documentId = PDFArray.withContext(document.context);
  documentId.push(PDFHexString.fromText("source-file-id"));
  documentId.push(PDFHexString.fromText("source-revision-id"));
  document.context.trailerInfo.ID = documentId;
  const streamDict = PDFDict.withContext(document.context);
  streamDict.set(PDFName.of("Type"), PDFName.of("XObject"));
  streamDict.set(PDFName.of("Subtype"), PDFName.of("Form"));
  streamDict.set(PDFName.of("BBox"), document.context.obj([0, 0, 16, 16]));
  const payload = new Uint8Array(64 * 1024);
  payload.fill(37);
  const streamRef = document.context.register(PDFRawStream.of(streamDict, payload));
  document.catalog.set(PDFName.of("UnchangedAppearance"), streamRef);
  return document.save({ useObjectStreams: objectStreams });
}

function append(baseBytes, suffix) {
  const output = new Uint8Array(baseBytes.length + suffix.length);
  output.set(baseBytes, 0);
  output.set(suffix, baseBytes.length);
  return output;
}

test("incremental updates keep the exact source prefix and omit untouched streams", async () => {
  for (const objectStreams of [false, true]) {
    const base = await sourcePdf({ objectStreams });
    const document = await PDFDocument.load(base, { updateMetadata: false });
    const untouchedStream = [...document.context.enumerateIndirectObjects()]
      .map(([, object]) => object)
      .find((object) => object instanceof PDFRawStream);
    assert.ok(untouchedStream);
    untouchedStream.copyBytesInto = () => {
      throw new Error("unchanged stream was copied into a scratch buffer");
    };
    const snapshot = captureIncrementalSnapshot({ sourceBytes: base, document });
    document.catalog.set(PDFName.of("RevisionMarker"), PDFHexString.fromText(`revision-${objectStreams}`));
    const patch = createIncrementalPatch({ sourceBytes: base, document, snapshot });
    assert.ok(patch);
    assert.equal(patch.baseLength, base.length);
    assert.equal(patch.changedObjectCount, 1, "only the catalog changed; the large stream remains in the original revision");

    const output = append(base, patch.suffix);
    assert.deepEqual(output.subarray(0, base.length), base);
    assert.equal(patch.baseFingerprint, fingerprint(base));
    assert.equal(patch.outputFingerprint, fingerprint(output));
    const reopened = await PDFDocument.load(output, { updateMetadata: false });
    assert.equal(reopened.catalog.lookup(PDFName.of("RevisionMarker"), PDFHexString).decodeText(), `revision-${objectStreams}`);
    assert.equal(reopened.catalog.get(PDFName.of("UnchangedAppearance")).toString(), document.catalog.get(PDFName.of("UnchangedAppearance")).toString());
    const outputId = readSourceTrailer(output).id;
    assert.equal(outputId.lookup(0, PDFHexString).decodeText(), "source-file-id");
    assert.equal(outputId.lookup(1, PDFHexString).decodeText(), "source-revision-id");
  }
});

test("repeated saves chain /Prev to the previous incremental xref", async () => {
  const source = await sourcePdf();
  const firstDoc = await PDFDocument.load(source, { updateMetadata: false });
  const firstSnapshot = captureIncrementalSnapshot({ sourceBytes: source, document: firstDoc });
  firstDoc.catalog.set(PDFName.of("FirstRevision"), PDFNumber.of(1));
  const firstPatch = createIncrementalPatch({ sourceBytes: source, document: firstDoc, snapshot: firstSnapshot });
  const firstOutput = append(source, firstPatch.suffix);

  const secondDoc = await PDFDocument.load(firstOutput, { updateMetadata: false });
  const secondSnapshot = captureIncrementalSnapshot({ sourceBytes: firstOutput, document: secondDoc });
  secondDoc.catalog.set(PDFName.of("SecondRevision"), PDFNumber.of(2));
  const secondPatch = createIncrementalPatch({ sourceBytes: firstOutput, document: secondDoc, snapshot: secondSnapshot });
  const secondOutput = append(firstOutput, secondPatch.suffix);

  assert.deepEqual(secondOutput.subarray(0, firstOutput.length), firstOutput);
  const firstTrailer = readSourceTrailer(firstOutput);
  const secondTrailer = readSourceTrailer(secondOutput);
  assert.equal(secondTrailer.previous, firstTrailer.xrefOffset);
  const reopened = await PDFDocument.load(secondOutput, { updateMetadata: false });
  assert.equal(reopened.catalog.lookup(PDFName.of("FirstRevision"), PDFNumber).asNumber(), 1);
  assert.equal(reopened.catalog.lookup(PDFName.of("SecondRevision"), PDFNumber).asNumber(), 2);
});

test("invalid startxref pointers are rejected before a patch can be produced", async () => {
  const source = await sourcePdf();
  const trailer = readSourceTrailer(source);
  const output = new Uint8Array(source);
  const marker = new TextEncoder().encode(`startxref\n${trailer.xrefOffset}`);
  let start = -1;
  outer: for (let offset = output.length - marker.length; offset >= 0; offset -= 1) {
    for (let index = 0; index < marker.length; index += 1) {
      if (output[offset + index] !== marker[index]) continue outer;
    }
    start = offset;
    break;
  }
  assert.notEqual(start, -1);
  const digitOffset = start + "startxref\n".length;
  output[digitOffset] = 57;
  await assert.rejects(
    async () => readSourceTrailer(output),
    (error) => error.code === "PDF_INCREMENTAL_INVALID_STARTXREF",
  );
});

test("trailers with unusable size values are rejected", async () => {
  const source = await sourcePdf();
  const output = new Uint8Array(source);
  const sourceText = new TextDecoder().decode(source);
  const sizeMarker = sourceText.lastIndexOf("/Size ");
  assert.notEqual(sizeMarker, -1);
  const sizeDigit = sizeMarker + "/Size ".length;
  output[sizeDigit] = 48;
  assert.throws(
    () => readSourceTrailer(output),
    (error) => error.code === "PDF_INCREMENTAL_INVALID_TRAILER",
  );
});

test("encrypted trailers are refused by the incremental snapshotter", async () => {
  const document = await PDFDocument.create();
  document.addPage([100, 100]);
  const fakeEncryptionDictionary = PDFDict.withContext(document.context);
  const encryptionRef = document.context.register(fakeEncryptionDictionary);
  document.context.trailerInfo.Encrypt = encryptionRef;
  const source = await document.save({ useObjectStreams: false });
  await assert.rejects(
    async () => captureIncrementalSnapshot({ sourceBytes: source, document }),
    (error) => error.code === "PDF_INCREMENTAL_ENCRYPTED_DOCUMENT",
  );
});
