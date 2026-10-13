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
  PDFRef,
} from "pdf-lib";
import mergeCore from "../plugin/pdf-merge-core.cjs";
import incremental from "../plugin/pdf-incremental.cjs";

const { inspect, merge, prepareLocal } = mergeCore;
const encodeText = (value) => PDFHexString.fromText(value);

function numberArray(doc, values) {
  const array = PDFArray.withContext(doc.context);
  for (const value of values) array.push(PDFNumber.of(value));
  return array;
}

function addAnnotation(doc, { subtype, contents, nm, appearance: appearanceLabel = null }) {
  const page = doc.getPages()[0];
  let annotations = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (!annotations) {
    annotations = PDFArray.withContext(doc.context);
    page.node.set(PDFName.of("Annots"), annotations);
  }
  const annotation = PDFDict.withContext(doc.context);
  annotation.set(PDFName.of("Type"), PDFName.of("Annot"));
  annotation.set(PDFName.of("Subtype"), PDFName.of(subtype));
  annotation.set(PDFName.of("Rect"), numberArray(doc, [20, 30, 120, 70]));
  annotation.set(PDFName.of("NM"), encodeText(nm));
  annotation.set(PDFName.of("Contents"), encodeText(contents));
  annotation.set(PDFName.of("T"), encodeText("incremental audit"));
  if (appearanceLabel) {
    const streamDictionary = PDFDict.withContext(doc.context);
    streamDictionary.set(PDFName.of("Type"), PDFName.of("XObject"));
    streamDictionary.set(PDFName.of("Subtype"), PDFName.of("Form"));
    streamDictionary.set(PDFName.of("FormType"), PDFNumber.of(1));
    streamDictionary.set(PDFName.of("BBox"), numberArray(doc, [0, 0, 80, 30]));
    streamDictionary.set(PDFName.of("Resources"), PDFDict.withContext(doc.context));
    const appearanceRef = doc.context.register(PDFRawStream.of(
      streamDictionary,
      new TextEncoder().encode(`q\n% ${appearanceLabel}\nQ\n`),
    ));
    const appearance = PDFDict.withContext(doc.context);
    appearance.set(PDFName.of("N"), appearanceRef);
    annotation.set(PDFName.of("AP"), appearance);
  }
  const ref = doc.context.register(annotation);
  annotations.push(ref);
  return ref;
}

function refFromIdentity(identity) {
  const match = /^(\d+)R(\d*)$/.exec(identity.ref);
  assert.ok(match, `Expected an indirect PDF reference, received ${identity.ref}`);
  return PDFRef.of(Number(match[1]), match[2] ? Number(match[2]) : 0);
}

function operation({ uuid, ref = null, kind, action = "upsert", timestamp, actorId, operationId }) {
  return {
    uuid,
    ref,
    pageIndex: 0,
    kind,
    action,
    deleted: action === "delete",
    timestamp,
    logical: 0,
    actorId,
    operationId,
  };
}

function materializeAppend(sourceBytes, patch, label) {
  assert.ok(patch, `${label}: changed merge should return its incremental suffix`);
  assert.equal(patch.baseLength, sourceBytes.length);
  assert.equal(patch.baseFingerprint, incremental.fingerprint(sourceBytes));
  const output = new Uint8Array(patch.outputLength);
  output.set(sourceBytes, 0);
  output.set(patch.suffix, sourceBytes.length);
  assert.equal(incremental.fingerprint(output), patch.outputFingerprint);
  assert.deepEqual(output.subarray(0, sourceBytes.length), sourceBytes);
  return output;
}

function semanticLedger(result) {
  return result.ledger.entries.map(({ ref: _ref, ...entry }) => entry)
    .sort((left, right) => left.uuid.localeCompare(right.uuid));
}

async function createBase() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([420, 540]);
  page.drawText("Stable page body", { x: 24, y: 500, size: 12 });
  addAnnotation(doc, { subtype: "Square", contents: "base value", nm: "base square" });
  return doc.save({ useObjectStreams: false });
}

async function prepareActorBranch({ baseBytes, baseIdentity, actorId, edit, create, deleteBase, timestamp }) {
  const draft = await PDFDocument.load(baseBytes, { updateMetadata: false });
  const existingRef = refFromIdentity(baseIdentity);
  if (edit) {
    draft.context.lookup(existingRef, PDFDict).set(PDFName.of("Contents"), encodeText(edit.contents));
  }
  if (deleteBase) {
    const annotations = draft.getPages()[0].node.lookup(PDFName.of("Annots"), PDFArray);
    for (let index = annotations.size() - 1; index >= 0; index -= 1) {
      const ref = annotations.get(index);
      if (ref instanceof PDFRef && ref.toString() === existingRef.toString()) annotations.remove(index);
    }
  }
  addAnnotation(draft, create);
  const draftBytes = await draft.save({ useObjectStreams: false });
  const createUuid = `${actorId}-created`;
  const prepared = await prepareLocal({
    baseBytes,
    draftBytes,
    actorId,
    newAnnotations: [{ runtimeId: `${actorId}-runtime`, uuid: createUuid, pageIndex: 0, kind: create.subtype.toLowerCase(), order: 0 }],
    operations: [
      ...(edit ? [operation({
        uuid: baseIdentity.uuid,
        ref: baseIdentity.ref,
        kind: baseIdentity.kind,
        timestamp,
        actorId,
        operationId: `${actorId}-edit`,
      })] : []),
      ...(deleteBase ? [operation({
        uuid: baseIdentity.uuid,
        ref: baseIdentity.ref,
        kind: baseIdentity.kind,
        action: "delete",
        timestamp,
        actorId,
        operationId: `${actorId}-delete`,
      })] : []),
      operation({
        uuid: createUuid,
        kind: create.subtype.toLowerCase(),
        timestamp: timestamp - 100,
        actorId,
        operationId: `${actorId}-create`,
      }),
    ],
  });
  return prepared;
}

test("two-device create/edit/delete branches converge after materializing both incremental merge suffixes", async () => {
  const baseBytes = await createBase();
  const baseState = await inspect({ bytes: baseBytes });
  const baseIdentity = baseState.identities.find((identity) => identity.kind === "square");
  assert.ok(baseIdentity);

  // Device A deletes the original while creating a Square. Device B edits the
  // original while creating an Underline. A's later delete wins over B's edit.
  const actorA = await prepareActorBranch({
    baseBytes,
    baseIdentity,
    actorId: "device-a",
    deleteBase: true,
    create: { subtype: "Square", contents: "created on A", nm: "A square", appearance: "A form" },
    timestamp: 300,
  });
  const actorB = await prepareActorBranch({
    baseBytes,
    baseIdentity,
    actorId: "device-b",
    edit: { contents: "edited on B" },
    create: { subtype: "Underline", contents: "created on B", nm: "B underline", appearance: "B form" },
    timestamp: 200,
  });
  const aOntoB = await merge({
    baseBytes,
    localBytes: actorA.bytes,
    remoteBytes: actorB.bytes,
    actorId: "device-a",
    patchOnly: true,
  });
  const bOntoA = await merge({
    baseBytes,
    localBytes: actorB.bytes,
    remoteBytes: actorA.bytes,
    actorId: "device-b",
    patchOnly: true,
  });
  const outputAB = materializeAppend(actorB.bytes, aOntoB.patch, "A onto B");
  const outputBA = materializeAppend(actorA.bytes, bOntoA.patch, "B onto A");

  const [stateAB, stateBA] = await Promise.all([
    inspect({ bytes: outputAB }),
    inspect({ bytes: outputBA }),
  ]);
  assert.deepEqual(semanticLedger(stateAB), semanticLedger(stateBA));
  for (const [state, bytes] of [[stateAB, outputAB], [stateBA, outputBA]]) {
    const deleted = state.identities.find((identity) => identity.uuid === baseIdentity.uuid);
    assert.equal(deleted?.deleted, true, "the newer delete must survive the concurrent edit");
    assert.equal(state.identities.find((identity) => identity.uuid === "device-a-created")?.deleted, false);
    assert.equal(state.identities.find((identity) => identity.uuid === "device-b-created")?.deleted, false);

    const reopened = await PDFDocument.load(bytes, { updateMetadata: false });
    const annotations = reopened.getPages()[0].node.lookup(PDFName.of("Annots"), PDFArray);
    const live = Array.from({ length: annotations.size() }, (_, index) => {
      const ref = annotations.get(index);
      return reopened.context.lookup(ref, PDFDict);
    });
    const contents = live.map((dictionary) => dictionary.lookup(PDFName.of("Contents"), PDFHexString).decodeText());
    assert.deepEqual(contents.sort(), ["created on A", "created on B"].sort());
    for (const dictionary of live) {
      const appearanceRef = dictionary.lookup(PDFName.of("AP"), PDFDict).get(PDFName.of("N"));
      assert.ok(appearanceRef instanceof PDFRef, "merged annotation must retain an indirect appearance reference");
      assert.ok(reopened.context.lookup(appearanceRef, PDFRawStream), "appearance reference must resolve in the materialized xref");
    }
    assert.ok(aOntoB.patch.xrefOffset >= actorB.bytes.length);
    assert.ok(bOntoA.patch.xrefOffset >= actorA.bytes.length);
  }
});
