import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
} from "pdf-lib";
import mergeCore from "../plugin/pdf-merge-core.cjs";

const { prepareLocal, merge, inspect } = mergeCore;
const { decodePdfString, getFastPageIdentities, getPageFingerprint, getDocumentRevisionToken, refMaps } = mergeCore._internals;
const text = (value) => PDFHexString.fromText(value);

function numberArray(doc, values) {
  const array = PDFArray.withContext(doc.context);
  for (const value of values) array.push(PDFNumber.of(value));
  return array;
}

function annotsFor(doc, page) {
  let annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (!annots) {
    annots = PDFArray.withContext(doc.context);
    page.node.set(PDFName.of("Annots"), annots);
  }
  return annots;
}

function addAppearance(doc, annotation, label) {
  const streamDictionary = PDFDict.withContext(doc.context);
  streamDictionary.set(PDFName.of("Type"), PDFName.of("XObject"));
  streamDictionary.set(PDFName.of("Subtype"), PDFName.of("Form"));
  streamDictionary.set(PDFName.of("FormType"), PDFNumber.of(1));
  streamDictionary.set(PDFName.of("BBox"), numberArray(doc, [0, 0, 80, 30]));
  streamDictionary.set(PDFName.of("Resources"), PDFDict.withContext(doc.context));
  const streamRef = doc.context.register(
    PDFRawStream.of(streamDictionary, new TextEncoder().encode(`q\n% ${label}\nQ\n`)),
  );
  const appearance = PDFDict.withContext(doc.context);
  appearance.set(PDFName.of("N"), streamRef);
  annotation.set(PDFName.of("AP"), appearance);
  return streamRef;
}

function addPopup(doc, page, parentRef, label = "popup") {
  const popup = PDFDict.withContext(doc.context);
  popup.set(PDFName.of("Type"), PDFName.of("Annot"));
  popup.set(PDFName.of("Subtype"), PDFName.of("Popup"));
  popup.set(PDFName.of("Rect"), numberArray(doc, [180, 180, 290, 260]));
  popup.set(PDFName.of("Parent"), parentRef);
  popup.set(PDFName.of("P"), page.ref);
  popup.set(PDFName.of("Contents"), text(label));
  const ref = doc.context.register(popup);
  page.node.lookup(PDFName.of("Annots"), PDFArray).push(ref);
  return ref;
}

function addAnnotation(doc, pageIndex, { subtype = "FreeText", nm = `NM-${subtype}`, contents = "initial", rect = [20, 30, 120, 70], popup = false, irt = null, appearance = null, structParent = null, it = null, inkList = null, quadPoints = null } = {}) {
  const page = doc.getPages()[pageIndex];
  const annotation = PDFDict.withContext(doc.context);
  annotation.set(PDFName.of("Type"), PDFName.of("Annot"));
  annotation.set(PDFName.of("Subtype"), PDFName.of(subtype));
  annotation.set(PDFName.of("Rect"), numberArray(doc, rect));
  annotation.set(PDFName.of("NM"), text(nm));
  annotation.set(PDFName.of("Contents"), text(contents));
  annotation.set(PDFName.of("T"), text("fixture author"));
  if (structParent !== null) annotation.set(PDFName.of("StructParent"), PDFNumber.of(structParent));
  if (it) annotation.set(PDFName.of("IT"), PDFName.of(it));
  if (inkList) {
    const inkLists = PDFArray.withContext(doc.context);
    inkLists.push(numberArray(doc, inkList));
    annotation.set(PDFName.of("InkList"), inkLists);
  }
  if (quadPoints) annotation.set(PDFName.of("QuadPoints"), numberArray(doc, quadPoints));
  if (appearance) addAppearance(doc, annotation, appearance);
  const ref = doc.context.register(annotation);
  annotsFor(doc, page).push(ref);
  if (popup) {
    const popupRef = addPopup(doc, page, ref, `${contents} popup`);
    annotation.set(PDFName.of("Popup"), popupRef);
  }
  if (irt) annotation.set(PDFName.of("IRT"), irt);
  return ref;
}

async function makeBase({ annotations = [], taggedRoot = false, pageCount = 1 } = {}) {
  const doc = await PDFDocument.create();
  const pages = [];
  for (let index = 0; index < pageCount; index += 1) {
    const page = doc.addPage([420, 540]);
    page.drawText("Stable page body for merge tests", { x: 24, y: 500, size: 12 });
    pages.push(page);
  }
  if (taggedRoot) {
    const root = PDFDict.withContext(doc.context);
    root.set(PDFName.of("Type"), PDFName.of("StructTreeRoot"));
    root.set(PDFName.of("K"), PDFArray.withContext(doc.context));
    doc.catalog.set(PDFName.of("StructTreeRoot"), doc.context.register(root));
  }
  const refs = [];
  for (const annotation of annotations) {
    refs.push(addAnnotation(doc, annotation.pageIndex || 0, annotation));
  }
  return { bytes: await doc.save({ useObjectStreams: false }), refs };
}

async function editBranch(baseBytes, ref, changes = {}, extraAnnotations = []) {
  const doc = await PDFDocument.load(baseBytes, { updateMetadata: false });
  const page = ref
    ? doc.getPages().find((candidate) => candidate.node.lookupMaybe(PDFName.of("Annots"), PDFArray)
      ?.asArray().some((item) => item instanceof PDFRef && item.toString() === ref.toString()))
    : doc.getPages()[0];
  const targetPage = page || doc.getPages()[0];
  if (ref) {
    const dict = doc.context.lookup(ref, PDFDict);
    if (changes.contents !== undefined) dict.set(PDFName.of("Contents"), text(changes.contents));
    if (changes.appearance !== undefined) addAppearance(doc, dict, changes.appearance);
    if (changes.remove) {
      const annots = targetPage.node.lookup(PDFName.of("Annots"), PDFArray);
      for (let index = annots.size() - 1; index >= 0; index -= 1) {
        const item = annots.get(index);
        if (item instanceof PDFRef && item.toString() === ref.toString()) annots.remove(index);
      }
    }
  }
  const extraRefs = extraAnnotations.map((annotation) => addAnnotation(doc, annotation.pageIndex || 0, annotation));
  return { bytes: await doc.save({ useObjectStreams: false }), extraRefs };
}

function operation({ uuid, ref = null, kind = "freetext", timestamp, actorId = "actor-device-01", operationId, action = "upsert", pageIndex = 0 }) {
  return { uuid, ref, pageIndex, kind, deleted: action === "delete", action, timestamp, logical: 0, actorId, operationId };
}

function findIdentity(result, uuid) {
  const identity = result.identities.find((item) => item.uuid === uuid);
  assert.ok(identity, `Expected identity ${uuid}`);
  return identity;
}

function refFromPdfJs(value) {
  const match = /^(\d+)R(\d*)$/.exec(value);
  assert.ok(match, `Expected a PDF.js indirect reference, got ${value}`);
  return PDFRef.of(Number(match[1]), match[2] ? Number(match[2]) : 0);
}

async function getAnnotation(bytes, uuid) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const inspected = await inspect({ bytes });
  const identity = findIdentity(inspected, uuid);
  const ref = refFromPdfJs(identity.ref);
  return { doc, identity, ref, dict: doc.context.lookup(ref, PDFDict), page: doc.getPages()[identity.pageIndex] };
}

test("preparation binds all five editor kinds by storage order and preserves NM plus AP", async () => {
  const base = await makeBase({ annotations: [{ subtype: "Square", nm: "Original Square NM", contents: "before" }] });
  const baseInfo = await inspect({ bytes: base.bytes });
  const existing = baseInfo.identities.find((item) => item.kind === "square");
  const draft = await PDFDocument.load(base.bytes, { updateMetadata: false });
  const page = draft.getPages()[0];
  const square = draft.context.lookup(refFromPdfJs(existing.ref), PDFDict);
  square.set(PDFName.of("Contents"), text("edited existing square"));
  const kinds = ["Underline", "Square", "Highlight", "Ink", "FreeText"];
  const newAnnotations = [];
  const operations = [operation({ uuid: existing.uuid, ref: existing.ref, kind: "square", timestamp: 50, operationId: "square-edit" })];
  kinds.forEach((subtype, order) => {
    const uuid = `new-${subtype.toLowerCase()}`;
    addAnnotation(draft, 0, { subtype, nm: `Original NM ${subtype}`, contents: `new ${subtype}`, appearance: `appearance ${subtype}` });
    newAnnotations.push({ runtimeId: `runtime-${order}`, uuid, pageIndex: 0, kind: subtype.toLowerCase(), order });
    operations.push(operation({ uuid, kind: subtype.toLowerCase(), timestamp: 100 + order, operationId: `create-${order}` }));
  });
  const draftBytes = await draft.save({ useObjectStreams: false });
  const prepared = await prepareLocal({ baseBytes: base.bytes, draftBytes, operations, newAnnotations, actorId: "actor-device-01" });
  const loaded = await PDFDocument.load(prepared.bytes, { updateMetadata: false });
  const identityData = await inspect({ bytes: prepared.bytes });
  assert.equal(identityData.identities.filter((item) => ["underline", "square", "highlight", "ink", "freetext"].includes(item.kind)).length, 6);
  assert.match(findIdentity(prepared, "new-underline").ref, /^\d+R(?:\d+)?$/);
  assert.equal(findIdentity(prepared, "new-underline").runtimeId, "runtime-0");
  for (const subtype of kinds) {
    const identity = findIdentity(prepared, `new-${subtype.toLowerCase()}`);
    const annotationRef = refFromPdfJs(identity.ref);
    const dict = loaded.context.lookup(annotationRef, PDFDict);
    assert.equal(dict.lookup(PDFName.of("NM"), PDFHexString).decodeText(), `Original NM ${subtype}`);
    assert.equal(dict.lookup(PDFName.of("ObReaderId"), PDFHexString).decodeText(), identity.uuid);
    const ap = dict.lookup(PDFName.of("AP"), PDFDict);
    assert.ok(ap.get(PDFName.of("N")) instanceof PDFRef, `${subtype} appearance should remain attached`);
  }
  const existingRef = refFromPdfJs(existing.ref);
  assert.equal(loaded.context.lookup(existingRef, PDFDict).lookup(PDFName.of("NM"), PDFHexString).decodeText(), "Original Square NM");
  assert.equal(prepared.stateDigest, identityData.stateDigest);
  assert.equal(loaded.getPages().length, 1);
});

test("prepared saves expose a verified append patch while preserving their exact source prefix", async () => {
  const base = await makeBase({ annotations: [{ subtype: "FreeText", nm: "incremental source", contents: "before" }] });
  const baseInfo = await inspect({ bytes: base.bytes });
  const existing = baseInfo.identities.find((item) => item.kind === "freetext");
  const draft = await PDFDocument.load(base.bytes, { updateMetadata: false });
  draft.context.lookup(refFromPdfJs(existing.ref), PDFDict).set(PDFName.of("Contents"), text("after"));
  const draftBytes = await draft.save({ useObjectStreams: false });
  const prepared = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes,
    operations: [operation({ uuid: existing.uuid, ref: existing.ref, kind: "freetext", timestamp: 12, operationId: "incremental-edit" })],
    newAnnotations: [],
    actorId: "actor-device-01",
    patchOnly: true,
  });

  assert.equal("bytes" in prepared, false);
  assert.equal(prepared.patch.baseLength, draftBytes.length);
  assert.ok(prepared.patch.suffix.length > 0);
  const output = new Uint8Array(prepared.patch.outputLength);
  output.set(draftBytes, 0);
  output.set(prepared.patch.suffix, draftBytes.length);
  assert.deepEqual(output.subarray(0, draftBytes.length), draftBytes);
  const loaded = await PDFDocument.load(output, { updateMetadata: false });
  assert.equal(loaded.context.lookup(refFromPdfJs(existing.ref), PDFDict).lookup(PDFName.of("Contents"), PDFHexString).decodeText(), "after");
  assert.equal((await inspect({ bytes: output })).stateDigest, prepared.stateDigest);
});

test("merge rebases prepared local state into the exact remote source and returns an append patch", async () => {
  const base = await makeBase({ annotations: [{ subtype: "FreeText", nm: "merge incremental", contents: "before" }] });
  const baseInfo = await inspect({ bytes: base.bytes });
  const existing = baseInfo.identities.find((item) => item.kind === "freetext");
  const draft = await PDFDocument.load(base.bytes, { updateMetadata: false });
  draft.context.lookup(refFromPdfJs(existing.ref), PDFDict).set(PDFName.of("Contents"), text("local winner"));
  const draftBytes = await draft.save({ useObjectStreams: false });
  const prepared = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes,
    operations: [operation({ uuid: existing.uuid, ref: existing.ref, kind: "freetext", timestamp: 20, operationId: "merge-local-edit" })],
    newAnnotations: [],
    actorId: "actor-device-01",
  });
  const merged = await merge({
    baseBytes: base.bytes,
    localBytes: prepared.bytes,
    remoteBytes: base.bytes,
    actorId: "actor-device-01",
    patchOnly: true,
  });

  assert.equal("bytes" in merged, false);
  assert.equal(merged.patch.baseLength, base.bytes.length);
  const output = new Uint8Array(merged.patch.outputLength);
  output.set(base.bytes, 0);
  output.set(merged.patch.suffix, base.bytes.length);
  assert.deepEqual(output.subarray(0, base.bytes.length), base.bytes);
  const updated = await PDFDocument.load(output, { updateMetadata: false });
  assert.equal(updated.context.lookup(refFromPdfJs(existing.ref), PDFDict).lookup(PDFName.of("Contents"), PDFHexString).decodeText(), "local winner");
  assert.equal((await inspect({ bytes: output })).stateDigest, merged.stateDigest);
});

test("text and freehand HighlightEditor output bind exact refs and retain semantic highlight identity", async () => {
  const base = await makeBase({ pageCount: 2 });
  const draft = await PDFDocument.load(base.bytes, { updateMetadata: false });
  // This matches PDF.js's frozen writer contract: text selections become a
  // /Highlight, while a freehand HighlightEditor becomes /Ink with
  // /IT /InkHighlight. Storage order is grouped per page by the writer.
  const freehandPage0Ref = addAnnotation(draft, 0, {
    subtype: "Ink",
    it: "InkHighlight",
    inkList: [24, 40, 60, 44, 92, 42],
    nm: "freehand page 1 NM",
    contents: "freehand page 1",
  });
  const textPage1Ref = addAnnotation(draft, 1, {
    subtype: "Highlight",
    quadPoints: [20, 82, 150, 82, 20, 66, 150, 66],
    nm: "text page 2 NM",
    contents: "text page 2",
  });
  const freehandPage1Ref = addAnnotation(draft, 1, {
    subtype: "Ink",
    it: "InkHighlight",
    inkList: [180, 40, 210, 45, 245, 43],
    nm: "freehand page 2 NM",
    contents: "freehand page 2",
  });
  const draftBytes = await draft.save({ useObjectStreams: false });
  const uuidByRuntimeId = new Map([
    ["freehand-page-0", "freehand-highlight-page-1"],
    ["text-page-1", "text-highlight-page-2"],
    ["freehand-page-1", "freehand-highlight-page-2"],
  ]);
  const newAnnotations = [
    { runtimeId: "freehand-page-0", uuid: uuidByRuntimeId.get("freehand-page-0"), pageIndex: 0, kind: "highlight", order: 0 },
    { runtimeId: "text-page-1", uuid: uuidByRuntimeId.get("text-page-1"), pageIndex: 1, kind: "highlight", order: 0 },
    { runtimeId: "freehand-page-1", uuid: uuidByRuntimeId.get("freehand-page-1"), pageIndex: 1, kind: "highlight", order: 1 },
  ];
  const prepared = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes,
    actorId: "actor-device-01",
    newAnnotations,
    operations: newAnnotations.map((annotation, index) => operation({
      uuid: annotation.uuid,
      kind: "highlight",
      timestamp: 100 + index,
      operationId: `highlight-create-${index}`,
      pageIndex: annotation.pageIndex,
    })),
  });
  const expectedRef = (ref) => `${ref.objectNumber}R${ref.generationNumber || ""}`;
  const savedDoc = await PDFDocument.load(prepared.bytes, { updateMetadata: false });
  for (const [annotation, ref, subtype, nm, it] of [
    [newAnnotations[0], freehandPage0Ref, "Ink", "freehand page 1 NM", "InkHighlight"],
    [newAnnotations[1], textPage1Ref, "Highlight", "text page 2 NM", null],
    [newAnnotations[2], freehandPage1Ref, "Ink", "freehand page 2 NM", "InkHighlight"],
  ]) {
    const identity = findIdentity(prepared, annotation.uuid);
    assert.equal(identity.kind, "highlight");
    assert.equal(identity.pageIndex, annotation.pageIndex);
    assert.equal(identity.ref, expectedRef(ref), "UUID must bind to the exact writer reference");
    const dict = savedDoc.context.lookup(ref, PDFDict);
    assert.equal(dict.get(PDFName.of("Subtype")).toString(), `/${subtype}`);
    assert.equal(dict.lookup(PDFName.of("NM"), PDFHexString).decodeText(), nm);
    assert.equal(dict.lookup(PDFName.of("ObReaderId"), PDFHexString).decodeText(), annotation.uuid);
    assert.equal(it ? dict.get(PDFName.of("IT")).toString() : null, it ? `/${it}` : null);
    assert.ok(
      dict.lookupMaybe(PDFName.of(subtype === "Highlight" ? "QuadPoints" : "InkList"), PDFArray)?.size() > 0,
      "The bound PDF dictionary must retain the writer's text quads or freehand ink path",
    );
  }
  const reopened = await inspect({ bytes: prepared.bytes });
  for (const annotation of newAnnotations) {
    assert.equal(findIdentity(reopened, annotation.uuid).kind, "highlight");
    assert.equal(findIdentity(reopened, annotation.uuid).ref, findIdentity(prepared, annotation.uuid).ref);
  }

  // Schema-1 ledgers created before freehand HighlightEditor output received
  // its semantic kind called this physical /Ink entry simply "ink". Reopen
  // it, preserve its exact ref/UUID, and validate an edit that still carries
  // that legacy operation kind only because /IT proves InkHighlight.
  const legacyDoc = await PDFDocument.load(prepared.bytes, { updateMetadata: false });
  const legacyLedger = JSON.parse(
    legacyDoc.catalog.get(PDFName.of("ObReaderMerge")).decodeText(),
  );
  legacyLedger.entries.find((entry) => entry.uuid === newAnnotations[0].uuid).kind = "ink";
  legacyDoc.catalog.set(
    PDFName.of("ObReaderMerge"),
    PDFHexString.fromText(JSON.stringify(legacyLedger)),
  );
  const legacyBytes = await legacyDoc.save({ useObjectStreams: false });
  const legacyIdentity = findIdentity(await inspect({ bytes: legacyBytes }), newAnnotations[0].uuid);
  assert.equal(legacyIdentity.kind, "highlight");
  assert.equal(legacyIdentity.ref, findIdentity(prepared, newAnnotations[0].uuid).ref);
  const editedLegacyDoc = await PDFDocument.load(legacyBytes, { updateMetadata: false });
  const legacyRef = refFromPdfJs(legacyIdentity.ref);
  editedLegacyDoc.context
    .lookup(legacyRef, PDFDict)
    .set(PDFName.of("Contents"), text("edited legacy freehand highlight"));
  const secondEdit = await prepareLocal({
    baseBytes: legacyBytes,
    draftBytes: await editedLegacyDoc.save({ useObjectStreams: false }),
    operations: [operation({
      uuid: newAnnotations[0].uuid,
      ref: legacyIdentity.ref,
      kind: "ink",
      timestamp: 900,
      operationId: "legacy-freehand-edit",
      pageIndex: 0,
    })],
    newAnnotations: [],
    actorId: "actor-device-01",
  });
  const secondIdentity = findIdentity(await inspect({ bytes: secondEdit.bytes }), newAnnotations[0].uuid);
  assert.equal(secondIdentity.kind, "highlight");
  assert.equal(secondIdentity.ref, legacyIdentity.ref);
});

test("checkpoint UUIDs survive repeat-save, delete, tombstone carry-forward, and undo with null-ref upserts", async () => {
  const base = await makeBase();
  const uuid = "session-created-square";
  const newAnnotation = [{ runtimeId: "runtime-square", uuid, pageIndex: 0, kind: "square", order: 0 }];
  const firstDraft = await editBranch(base.bytes, null, {}, [{ subtype: "Square", nm: "stable NM", contents: "first save" }]);
  const first = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: firstDraft.bytes,
    checkpointBytes: base.bytes,
    operations: [operation({ uuid, kind: "square", timestamp: 100, operationId: "create-square" })],
    newAnnotations: newAnnotation,
    actorId: "actor-device-01",
  });
  const firstIdentity = findIdentity(first, uuid);
  assert.equal(firstIdentity.deleted, false);

  // PDF.js continues to serialize this session-created editor against its
  // original loaded base, so the id-null upsert remains ref:null on later saves.
  const secondDraftDoc = await PDFDocument.load(base.bytes, { updateMetadata: false });
  // Force the draft's indirect object number to differ from the prior saved
  // checkpoint, as can happen when PDF.js reserializes from its loaded base.
  secondDraftDoc.context.register(PDFDict.withContext(secondDraftDoc.context));
  addAnnotation(secondDraftDoc, 0, { subtype: "Square", nm: "stable NM", contents: "second save" });
  const secondDraftBytes = await secondDraftDoc.save({ useObjectStreams: false });
  const second = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: secondDraftBytes,
    checkpointBytes: first.bytes,
    operations: [operation({ uuid, kind: "square", timestamp: 200, operationId: "edit-square" })],
    newAnnotations: newAnnotation,
    actorId: "actor-device-01",
  });
  const secondIdentity = findIdentity(second, uuid);
  assert.equal(secondIdentity.uuid, firstIdentity.uuid);
  assert.notEqual(secondIdentity.ref, firstIdentity.ref, "the checkpoint binding must not depend on a previously saved indirect ref");
  assert.equal(secondIdentity.deleted, false);
  assert.equal(secondIdentity.timestamp, 200);
  assert.equal((await getAnnotation(second.bytes, uuid)).dict.lookup(PDFName.of("Contents"), PDFHexString).decodeText(), "second save");

  const deleteDraft = await editBranch(base.bytes, null, {}, []);
  const deleted = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: deleteDraft.bytes,
    checkpointBytes: second.bytes,
    operations: [operation({ uuid, ref: secondIdentity.ref, kind: "square", timestamp: 300, operationId: "delete-square", action: "delete" })],
    actorId: "actor-device-01",
  });
  const tombstone = findIdentity(deleted, uuid);
  assert.equal(tombstone.deleted, true);
  assert.equal(tombstone.ref, secondIdentity.ref);

  const unrelatedUuid = "session-created-underline";
  const laterDraft = await editBranch(base.bytes, null, {}, [{ subtype: "Underline", contents: "later annotation" }]);
  const later = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: laterDraft.bytes,
    checkpointBytes: deleted.bytes,
    operations: [operation({ uuid: unrelatedUuid, kind: "underline", timestamp: 400, operationId: "create-underline" })],
    newAnnotations: [{ runtimeId: "runtime-underline", uuid: unrelatedUuid, pageIndex: 0, kind: "underline", order: 0 }],
    actorId: "actor-device-01",
  });
  assert.equal(findIdentity(later, uuid).deleted, true);
  assert.equal(findIdentity(later, unrelatedUuid).deleted, false);

  const undoDraft = await editBranch(base.bytes, null, {}, [{ subtype: "Square", nm: "stable NM", contents: "restored after undo" }]);
  const undone = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: undoDraft.bytes,
    checkpointBytes: deleted.bytes,
    operations: [operation({ uuid, kind: "square", timestamp: 500, operationId: "undo-square" })],
    newAnnotations: [{ ...newAnnotation[0], order: 0 }],
    actorId: "actor-device-01",
  });
  const restored = findIdentity(undone, uuid);
  assert.equal(restored.deleted, false);
  assert.equal(restored.timestamp, 500);
  assert.equal((await getAnnotation(undone.bytes, uuid)).dict.lookup(PDFName.of("Contents"), PDFHexString).decodeText(), "restored after undo");

  const redoDraft = await editBranch(base.bytes, null, {}, []);
  const redone = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: redoDraft.bytes,
    checkpointBytes: undone.bytes,
    operations: [operation({ uuid, ref: restored.ref, kind: "square", timestamp: 600, operationId: "redo-square", action: "delete" })],
    actorId: "actor-device-01",
  });
  assert.equal(findIdentity(redone, uuid).deleted, true);
  assert.equal(findIdentity(redone, uuid).ref, restored.ref);
});

test("prepareLocal accepts only an exact delete operation for an absent annotation in a stale draft ledger", async () => {
  const base = await makeBase({ annotations: [{ subtype: "Square", contents: "saved before deletion" }] });
  const firstSave = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: base.bytes,
    actorId: "actor-device-01",
  });
  const identity = findIdentity(firstSave, (await inspect({ bytes: base.bytes })).identities[0].uuid);

  // This models a PDF.js draft that inherits the last saved catalog ledger,
  // while the editor has already removed the annotation from /Annots.
  const draft = await PDFDocument.load(firstSave.bytes, { updateMetadata: false });
  const annots = draft.getPages()[identity.pageIndex].node.lookup(PDFName.of("Annots"), PDFArray);
  const savedRef = refFromPdfJs(identity.ref);
  for (let index = annots.size() - 1; index >= 0; index -= 1) {
    const item = annots.get(index);
    if (item instanceof PDFRef && item.toString() === savedRef.toString()) annots.remove(index);
  }
  const deletedDraftBytes = await draft.save({ useObjectStreams: false });

  await assert.rejects(
    inspect({ bytes: deletedDraftBytes }),
    (error) => error.code === "PDF_MERGE_MISSING_TOMBSTONE",
    "ordinary inspection must still reject a live ledger identity with no annotation or tombstone",
  );

  const deleted = await prepareLocal({
    baseBytes: firstSave.bytes,
    draftBytes: deletedDraftBytes,
    checkpointBytes: firstSave.bytes,
    operations: [operation({
      uuid: identity.uuid,
      ref: identity.ref,
      kind: identity.kind,
      timestamp: 200,
      operationId: "delete-saved-square",
      action: "delete",
      pageIndex: identity.pageIndex,
    })],
    actorId: "actor-device-01",
  });
  assert.equal(findIdentity(deleted, identity.uuid).deleted, true);

  const wrongRefOperation = operation({
    uuid: identity.uuid,
    ref: "999R",
    kind: identity.kind,
    timestamp: 201,
    operationId: "delete-wrong-reference",
    action: "delete",
    pageIndex: identity.pageIndex,
  });
  await assert.rejects(
    prepareLocal({
      baseBytes: firstSave.bytes,
      draftBytes: deletedDraftBytes,
      checkpointBytes: firstSave.bytes,
      operations: [wrongRefOperation],
      actorId: "actor-device-01",
    }),
    (error) => error.code === "PDF_MERGE_MISSING_TOMBSTONE",
    "an unrelated reference must not explain the missing live annotation",
  );

  for (const [label, invalidOperation] of [
    ["wrong page", operation({
      uuid: identity.uuid,
      ref: identity.ref,
      kind: identity.kind,
      timestamp: 202,
      operationId: "delete-wrong-page",
      action: "delete",
      pageIndex: identity.pageIndex + 1,
    })],
    ["missing page", operation({
      uuid: identity.uuid,
      ref: identity.ref,
      kind: identity.kind,
      timestamp: 202,
      operationId: "delete-missing-page",
      action: "delete",
      pageIndex: null,
    })],
    ["wrong kind", operation({
      uuid: identity.uuid,
      ref: identity.ref,
      kind: "highlight",
      timestamp: 203,
      operationId: "delete-wrong-kind",
      action: "delete",
      pageIndex: identity.pageIndex,
    })],
    ["missing kind", operation({
      uuid: identity.uuid,
      ref: identity.ref,
      kind: null,
      timestamp: 203,
      operationId: "delete-missing-kind",
      action: "delete",
      pageIndex: identity.pageIndex,
    })],
    ["unknown UUID", operation({
      uuid: "not-a-saved-annotation",
      ref: identity.ref,
      kind: identity.kind,
      timestamp: 205,
      operationId: "delete-unknown-uuid",
      action: "delete",
      pageIndex: identity.pageIndex,
    })],
  ]) {
    await assert.rejects(
      prepareLocal({
        baseBytes: firstSave.bytes,
        draftBytes: deletedDraftBytes,
        checkpointBytes: firstSave.bytes,
        operations: [invalidOperation],
        actorId: "actor-device-01",
      }),
      (error) => error.code === "PDF_MERGE_MISSING_TOMBSTONE",
      `${label} delete evidence must not explain the missing live annotation`,
    );
  }
});

test("an older delete cannot explain an absent annotation after a newer saved upsert", async () => {
  const base = await makeBase({ annotations: [{ subtype: "Square", contents: "before newer edit" }] });
  const baseIdentity = (await inspect({ bytes: base.bytes })).identities[0];
  const firstSave = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: base.bytes,
    actorId: "actor-device-01",
  });
  const identity = findIdentity(firstSave, baseIdentity.uuid);

  const edit = await PDFDocument.load(firstSave.bytes, { updateMetadata: false });
  edit.context.lookup(refFromPdfJs(identity.ref), PDFDict).set(PDFName.of("Contents"), text("newer saved edit"));
  const newerSave = await prepareLocal({
    baseBytes: firstSave.bytes,
    draftBytes: await edit.save({ useObjectStreams: false }),
    checkpointBytes: firstSave.bytes,
    operations: [operation({
      uuid: identity.uuid,
      ref: identity.ref,
      kind: identity.kind,
      timestamp: 500,
      operationId: "newer-square-edit",
    })],
    actorId: "actor-device-01",
  });

  const draft = await PDFDocument.load(newerSave.bytes, { updateMetadata: false });
  const annots = draft.getPages()[identity.pageIndex].node.lookup(PDFName.of("Annots"), PDFArray);
  const savedRef = refFromPdfJs(identity.ref);
  for (let index = annots.size() - 1; index >= 0; index -= 1) {
    const item = annots.get(index);
    if (item instanceof PDFRef && item.toString() === savedRef.toString()) annots.remove(index);
  }
  await assert.rejects(
    prepareLocal({
      baseBytes: newerSave.bytes,
      draftBytes: await draft.save({ useObjectStreams: false }),
      checkpointBytes: newerSave.bytes,
      operations: [operation({
        uuid: identity.uuid,
        ref: identity.ref,
        kind: identity.kind,
        timestamp: 400,
        operationId: "stale-square-delete",
        action: "delete",
        pageIndex: identity.pageIndex,
      })],
      actorId: "actor-device-01",
    }),
    (error) => error.code === "PDF_MERGE_MISSING_TOMBSTONE",
    "a delete older than the saved live state cannot account for missing bytes",
  );
});

test("a confirmed checkpoint tombstone can carry forward through a stale live draft ledger", async () => {
  const base = await makeBase({ annotations: [{ subtype: "Square", contents: "saved square" }] });
  const baseIdentity = (await inspect({ bytes: base.bytes })).identities[0];
  const firstSave = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: base.bytes,
    actorId: "actor-device-01",
  });
  const identity = findIdentity(firstSave, baseIdentity.uuid);

  const removeAnnotation = async () => {
    const draft = await PDFDocument.load(firstSave.bytes, { updateMetadata: false });
    const annots = draft.getPages()[identity.pageIndex].node.lookup(PDFName.of("Annots"), PDFArray);
    const ref = refFromPdfJs(identity.ref);
    for (let index = annots.size() - 1; index >= 0; index -= 1) {
      const item = annots.get(index);
      if (item instanceof PDFRef && item.toString() === ref.toString()) annots.remove(index);
    }
    return draft.save({ useObjectStreams: false });
  };
  const staleDraftBytes = await removeAnnotation();
  const confirmedDelete = await prepareLocal({
    baseBytes: firstSave.bytes,
    draftBytes: staleDraftBytes,
    checkpointBytes: firstSave.bytes,
    operations: [operation({
      uuid: identity.uuid,
      ref: identity.ref,
      kind: identity.kind,
      timestamp: 200,
      operationId: "confirmed-square-delete",
      action: "delete",
      pageIndex: identity.pageIndex,
    })],
    actorId: "actor-device-01",
  });

  const carried = await prepareLocal({
    baseBytes: firstSave.bytes,
    draftBytes: staleDraftBytes,
    checkpointBytes: confirmedDelete.bytes,
    operations: [operation({
      uuid: identity.uuid,
      ref: identity.ref,
      kind: identity.kind,
      timestamp: 100,
      operationId: "older-idempotent-square-delete",
      action: "delete",
      pageIndex: identity.pageIndex,
    })],
    actorId: "actor-device-01",
  });
  const tombstone = findIdentity(carried, identity.uuid);
  assert.equal(tombstone.deleted, true);
  assert.equal(tombstone.timestamp, 200, "the older retry must preserve the confirmed tombstone clock");
});

test("an older checkpoint tombstone cannot eclipse a newer live base for the missing-draft exception", async () => {
  const base = await makeBase({ annotations: [{ subtype: "Square", contents: "initial square" }] });
  const baseIdentity = (await inspect({ bytes: base.bytes })).identities[0];
  const firstSave = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: base.bytes,
    actorId: "actor-device-01",
  });
  const identity = findIdentity(firstSave, baseIdentity.uuid);

  const newerEdit = await PDFDocument.load(firstSave.bytes, { updateMetadata: false });
  newerEdit.context.lookup(refFromPdfJs(identity.ref), PDFDict).set(PDFName.of("Contents"), text("newer live base"));
  const newerLiveBase = await prepareLocal({
    baseBytes: firstSave.bytes,
    draftBytes: await newerEdit.save({ useObjectStreams: false }),
    checkpointBytes: firstSave.bytes,
    operations: [operation({
      uuid: identity.uuid,
      ref: identity.ref,
      kind: identity.kind,
      timestamp: 500,
      operationId: "newer-live-square-upsert",
    })],
    actorId: "actor-device-01",
  });

  const oldDeleteDraft = await PDFDocument.load(firstSave.bytes, { updateMetadata: false });
  const oldDeleteAnnots = oldDeleteDraft.getPages()[identity.pageIndex].node.lookup(PDFName.of("Annots"), PDFArray);
  const savedRef = refFromPdfJs(identity.ref);
  for (let index = oldDeleteAnnots.size() - 1; index >= 0; index -= 1) {
    const item = oldDeleteAnnots.get(index);
    if (item instanceof PDFRef && item.toString() === savedRef.toString()) oldDeleteAnnots.remove(index);
  }
  const olderCheckpointTombstone = await prepareLocal({
    baseBytes: firstSave.bytes,
    draftBytes: await oldDeleteDraft.save({ useObjectStreams: false }),
    checkpointBytes: firstSave.bytes,
    operations: [operation({
      uuid: identity.uuid,
      ref: identity.ref,
      kind: identity.kind,
      timestamp: 200,
      operationId: "older-confirmed-square-delete",
      action: "delete",
      pageIndex: identity.pageIndex,
    })],
    actorId: "actor-device-01",
  });
  assert.equal(findIdentity(olderCheckpointTombstone, identity.uuid).deleted, true);

  const missingDraft = await PDFDocument.load(newerLiveBase.bytes, { updateMetadata: false });
  const liveAnnots = missingDraft.getPages()[identity.pageIndex].node.lookup(PDFName.of("Annots"), PDFArray);
  for (let index = liveAnnots.size() - 1; index >= 0; index -= 1) {
    const item = liveAnnots.get(index);
    if (item instanceof PDFRef && item.toString() === savedRef.toString()) liveAnnots.remove(index);
  }

  await assert.rejects(
    prepareLocal({
      baseBytes: newerLiveBase.bytes,
      draftBytes: await missingDraft.save({ useObjectStreams: false }),
      checkpointBytes: olderCheckpointTombstone.bytes,
      operations: [operation({
        uuid: identity.uuid,
        ref: identity.ref,
        kind: identity.kind,
        timestamp: 400,
        operationId: "stale-square-delete-after-checkpoint-tombstone",
        action: "delete",
        pageIndex: identity.pageIndex,
      })],
      actorId: "actor-device-01",
    }),
    (error) => error.code === "PDF_MERGE_MISSING_TOMBSTONE",
    "a stale checkpoint tombstone cannot hide the newer live base clock",
  );
});

test("a delete bound to a checkpoint's reallocated ref remains verifiable", async () => {
  const base = await makeBase({ annotations: [{ subtype: "Square", contents: "saved square" }] });
  const baseIdentity = (await inspect({ bytes: base.bytes })).identities[0];
  const firstSave = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: base.bytes,
    actorId: "actor-device-01",
  });
  const identity = findIdentity(firstSave, baseIdentity.uuid);

  const checkpoint = await PDFDocument.load(firstSave.bytes, { updateMetadata: false });
  const oldRef = refFromPdfJs(identity.ref);
  const original = checkpoint.context.lookup(oldRef, PDFDict);
  const copy = PDFDict.withContext(checkpoint.context);
  for (const [key, value] of original.entries()) copy.set(key, value);
  const newRef = checkpoint.context.register(copy);
  const checkpointAnnots = checkpoint.getPages()[identity.pageIndex].node.lookup(PDFName.of("Annots"), PDFArray);
  for (let index = 0; index < checkpointAnnots.size(); index += 1) {
    const item = checkpointAnnots.get(index);
    if (item instanceof PDFRef && item.toString() === oldRef.toString()) checkpointAnnots.set(index, newRef);
  }
  const checkpointBytes = await checkpoint.save({ useObjectStreams: false });
  const checkpointIdentity = findIdentity(await inspect({ bytes: checkpointBytes }), identity.uuid);
  assert.notEqual(checkpointIdentity.ref, identity.ref);

  const deletedDraft = await PDFDocument.load(checkpointBytes, { updateMetadata: false });
  const deletedAnnots = deletedDraft.getPages()[identity.pageIndex].node.lookup(PDFName.of("Annots"), PDFArray);
  for (let index = deletedAnnots.size() - 1; index >= 0; index -= 1) {
    const item = deletedAnnots.get(index);
    if (item instanceof PDFRef && item.toString() === newRef.toString()) deletedAnnots.remove(index);
  }
  const prepared = await prepareLocal({
    baseBytes: firstSave.bytes,
    draftBytes: await deletedDraft.save({ useObjectStreams: false }),
    checkpointBytes,
    operations: [operation({
      uuid: identity.uuid,
      ref: checkpointIdentity.ref,
      kind: identity.kind,
      timestamp: 200,
      operationId: "delete-reallocated-square",
      action: "delete",
      pageIndex: identity.pageIndex,
    })],
    actorId: "actor-device-01",
  });
  const tombstone = findIdentity(prepared, identity.uuid);
  assert.equal(tombstone.deleted, true);
  assert.equal(tombstone.timestamp, 200);
});

test("lossless checkpoint rewrite normalizes indirect stream lengths without weakening page-content lineage", async () => {
  const baseBytes = new Uint8Array(await readFile(new URL("./fixtures/tracemonkey.pdf", import.meta.url)));
  const firstDraft = await PDFDocument.load(baseBytes, { updateMetadata: false });
  addAnnotation(firstDraft, 0, { subtype: "Square", contents: "checkpoint stream regression" });
  const first = await prepareLocal({
    baseBytes,
    draftBytes: await firstDraft.save({ useObjectStreams: false }),
    operations: [operation({ uuid: "stream-checkpoint-square", kind: "square", timestamp: 100, operationId: "stream-create" })],
    newAnnotations: [{ runtimeId: "stream-runtime", uuid: "stream-checkpoint-square", pageIndex: 0, kind: "square", order: 0 }],
    actorId: "actor-device-01",
  });
  const identity = findIdentity(first, "stream-checkpoint-square");

  const deleted = await prepareLocal({
    baseBytes,
    // The Viewer draft is still based on the originally loaded PDF. The host's
    // prepared checkpoint is the only input rewritten by pdf-lib here.
    draftBytes: baseBytes,
    checkpointBytes: first.bytes,
    operations: [operation({ uuid: identity.uuid, ref: identity.ref, kind: "square", timestamp: 200, operationId: "stream-delete", action: "delete" })],
    actorId: "actor-device-01",
  });
  assert.equal(findIdentity(deleted, identity.uuid).deleted, true);

  const changedPage = await PDFDocument.load(baseBytes, { updateMetadata: false });
  changedPage.getPages()[10].drawText("real page edit", { x: 20, y: 20, size: 11 });
  await assert.rejects(
    prepareLocal({
      baseBytes,
      draftBytes: await changedPage.save({ useObjectStreams: false }),
      checkpointBytes: first.bytes,
      operations: [operation({ uuid: identity.uuid, ref: identity.ref, kind: "square", timestamp: 201, operationId: "stream-delete-with-page-edit", action: "delete" })],
      actorId: "actor-device-01",
    }),
    (error) => error.code === "PDF_MERGE_DOCUMENT_STRUCTURE_CHANGED",
  );
});

test("new annotation binding rejects a type/order mismatch instead of guessing a sole type match", async () => {
  const base = await makeBase();
  const draft = await editBranch(base.bytes, null, {}, [
    { subtype: "Square", contents: "first in writer order" },
    { subtype: "Ink", contents: "second in writer order" },
  ]);
  await assert.rejects(
    prepareLocal({
      baseBytes: base.bytes,
      draftBytes: draft.bytes,
      actorId: "actor-device-01",
      newAnnotations: [
        { runtimeId: "runtime-ink", uuid: "order-mismatch-ink", pageIndex: 0, kind: "ink", order: 0 },
        { runtimeId: "runtime-square", uuid: "order-mismatch-square", pageIndex: 0, kind: "square", order: 1 },
      ],
      operations: [
        operation({ uuid: "order-mismatch-ink", kind: "ink", timestamp: 100, operationId: "ink-create" }),
        operation({ uuid: "order-mismatch-square", kind: "square", timestamp: 101, operationId: "square-create" }),
      ],
    }),
    (error) => error.code === "PDF_MERGE_NEW_ANNOTATION_BINDING_FAILED",
  );
});

test("new annotations of the same type bind by exact per-page writer order", async () => {
  const base = await makeBase();
  const draft = await editBranch(base.bytes, null, {}, [
    { subtype: "Square", contents: "first writer entry" },
    { subtype: "Square", contents: "second writer entry" },
  ]);
  const prepared = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: draft.bytes,
    actorId: "actor-device-01",
    newAnnotations: [
      { runtimeId: "runtime-second", uuid: "square-second", pageIndex: 0, kind: "square", order: 1 },
      { runtimeId: "runtime-first", uuid: "square-first", pageIndex: 0, kind: "square", order: 0 },
    ],
    operations: [
      operation({ uuid: "square-first", kind: "square", timestamp: 100, operationId: "square-first-create" }),
      operation({ uuid: "square-second", kind: "square", timestamp: 101, operationId: "square-second-create" }),
    ],
  });
  assert.equal((await getAnnotation(prepared.bytes, "square-first")).dict.lookup(PDFName.of("Contents"), PDFHexString).decodeText(), "first writer entry");
  assert.equal((await getAnnotation(prepared.bytes, "square-second")).dict.lookup(PDFName.of("Contents"), PDFHexString).decodeText(), "second writer entry");
});

test("an unsaved create-delete can leave a null-ref tombstone, but unknown saved refs are rejected", async () => {
  const base = await makeBase();
  const unsaved = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: base.bytes,
    actorId: "actor-device-01",
    operations: [operation({ uuid: "never-saved", kind: "freetext", timestamp: 100, operationId: "create-delete", action: "delete" })],
  });
  const tombstone = findIdentity(unsaved, "never-saved");
  assert.equal(tombstone.deleted, true);
  assert.equal(tombstone.ref, null);
  await assert.rejects(
    prepareLocal({
      baseBytes: base.bytes,
      draftBytes: base.bytes,
      actorId: "actor-device-01",
      operations: [operation({ uuid: "unknown-saved", ref: "99R", kind: "freetext", timestamp: 101, operationId: "unknown-delete", action: "delete" })],
    }),
    (error) => error.code === "PDF_MERGE_UNKNOWN_ANNOTATION_ID",
  );
});

test("a clean PDF.js draft cannot hide a retained id-null editor behind checkpoint metadata", async () => {
  const base = await makeBase();
  const uuid = "clean-checkpoint-retained-square";
  const newAnnotations = [{
    runtimeId: "pdfjs_internal_editor_0",
    uuid,
    pageIndex: 0,
    kind: "square",
    order: 0,
  }];
  const operations = [operation({
    uuid,
    kind: "square",
    timestamp: 100,
    operationId: "clean-checkpoint-square-create",
  })];
  const firstSave = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: await editBranch(base.bytes, null, {}, [{ subtype: "Square", contents: "retained editor" }]).then(({ bytes }) => bytes),
    operations,
    newAnnotations,
    actorId: "actor-device-01",
  });
  assert.equal(findIdentity(firstSave, uuid).kind, "square");

  // PDF.js getData() can return the original loaded bytes after a successful
  // save even though the editor remains live with annotationStorage id:null.
  // The checkpoint records the saved ref, but it cannot manufacture the
  // missing Square object in that stale draft. Fail closed so the bridge
  // requests saveDocument() and supplies a fresh draft containing the editor.
  await assert.rejects(
    prepareLocal({
      baseBytes: base.bytes,
      draftBytes: base.bytes,
      checkpointBytes: firstSave.bytes,
      operations,
      newAnnotations,
      actorId: "actor-device-01",
    }),
    (error) => error.code === "PDF_MERGE_NEW_ANNOTATION_BINDING_FAILED" &&
      /pdfjs_internal_editor_0/.test(error.message),
  );
});

test("concurrent annotation creates converge on canonical page order and retain untracked refs", async () => {
  const base = await makeBase({ annotations: [
    { subtype: "Square", contents: "base square" },
    { subtype: "Line", contents: "untracked line", popup: true },
  ] });
  const baseInfo = await inspect({ bytes: base.bytes });
  const original = baseInfo.identities.find((item) => item.kind === "square");
  const prepareBranch = async ({ actorId, deleteBase, edit, create, timestamp }) => {
    const draft = await editBranch(base.bytes, refFromPdfJs(original.ref), {
      ...(edit ? { contents: edit } : {}),
      ...(deleteBase ? { remove: true } : {}),
    }, [create]);
    const uuid = `${actorId}-created`;
    return prepareLocal({
      baseBytes: base.bytes,
      draftBytes: draft.bytes,
      actorId,
      newAnnotations: [{ runtimeId: `${actorId}-runtime`, uuid, pageIndex: 0, kind: create.subtype.toLowerCase(), order: 0 }],
      operations: [
        ...(edit ? [operation({ uuid: original.uuid, ref: original.ref, kind: original.kind, timestamp, actorId, operationId: `${actorId}-edit` })] : []),
        ...(deleteBase ? [operation({ uuid: original.uuid, ref: original.ref, kind: original.kind, action: "delete", timestamp, actorId, operationId: `${actorId}-delete` })] : []),
        operation({ uuid, kind: create.subtype.toLowerCase(), timestamp: timestamp - 100, actorId, operationId: `${actorId}-create` }),
      ],
    });
  };
  const branchA = await prepareBranch({
    actorId: "device-a",
    deleteBase: true,
    create: { subtype: "Square", contents: "A square", appearance: "A appearance" },
    timestamp: 300,
  });
  const branchB = await prepareBranch({
    actorId: "device-b",
    edit: "edited on B",
    create: { subtype: "Underline", contents: "B underline", appearance: "B appearance" },
    timestamp: 200,
  });
  const [aOntoB, bOntoA] = await Promise.all([
    merge({ baseBytes: base.bytes, localBytes: branchA.bytes, remoteBytes: branchB.bytes, actorId: "device-a" }),
    merge({ baseBytes: base.bytes, localBytes: branchB.bytes, remoteBytes: branchA.bytes, actorId: "device-b" }),
  ]);
  const [stateAB, stateBA] = await Promise.all([
    inspect({ bytes: aOntoB.bytes }),
    inspect({ bytes: bOntoA.bytes }),
  ]);
  const semanticEntries = (state) => state.ledger.entries
    .map(({ ref: _ref, ...entry }) => entry)
    .sort((left, right) => left.uuid.localeCompare(right.uuid));
  assert.deepEqual(semanticEntries(stateAB), semanticEntries(stateBA));
  assert.equal(stateAB.stateDigest, stateBA.stateDigest);
  const liveOrder = (state) => state.identities
    .filter((item) => !item.deleted && ["device-a-created", "device-b-created"].includes(item.uuid))
    .map(({ uuid, order }) => ({ uuid, order }))
    .sort((left, right) => left.uuid.localeCompare(right.uuid));
  assert.deepEqual(liveOrder(stateAB), liveOrder(stateBA));

  for (const bytes of [aOntoB.bytes, bOntoA.bytes]) {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const annots = doc.getPages()[0].node.lookup(PDFName.of("Annots"), PDFArray);
    const entries = Array.from({ length: annots.size() }, (_, index) => {
      const ref = annots.get(index);
      return { ref, dict: doc.context.lookup(ref, PDFDict) };
    });
    const types = entries.map(({ dict }) => dict.lookup(PDFName.of("Subtype"), PDFName).decodeText());
    assert.deepEqual(types.slice(0, 2), ["Line", "Popup"], "untracked annotation refs keep their order and position");
    const line = entries.find(({ dict }) => dict.lookup(PDFName.of("Subtype"), PDFName).decodeText() === "Line");
    const popupRef = line.dict.get(PDFName.of("Popup"));
    assert.ok(popupRef instanceof PDFRef);
    assert.equal(doc.context.lookup(popupRef, PDFDict).get(PDFName.of("Parent")).toString(), line.ref.toString());
  }
});

test("independent new annotations union, same-UUID LWW is deterministic, and merge is byte-idempotent", async () => {
  const base = await makeBase({ annotations: [{ subtype: "FreeText", contents: "base" }] });
  const baseInspection = await inspect({ bytes: base.bytes });
  const existing = baseInspection.identities.find((item) => item.kind === "freetext");

  const localDraft = await editBranch(base.bytes, refFromPdfJs(existing.ref), { contents: "local winner" });
  const local = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: localDraft.bytes,
    actorId: "actor-a",
    operations: [operation({ uuid: existing.uuid, ref: existing.ref, timestamp: 300, actorId: "actor-a", operationId: "edit-local" })],
  });

  const remoteDraft = await editBranch(base.bytes, null, {}, [{ subtype: "Square", nm: "Remote NM", contents: "remote addition" }]);
  const remote = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: remoteDraft.bytes,
    actorId: "actor-b",
    newAnnotations: [{ runtimeId: "new-square-runtime", uuid: "remote-new-square", pageIndex: 0, kind: "square", order: 0 }],
    operations: [
      operation({ uuid: "remote-new-square", ref: null, kind: "square", timestamp: 250, actorId: "actor-b", operationId: "create-square" }),
    ],
  });

  const localOnlyPatch = await merge({
    baseBytes: base.bytes,
    localBytes: remote.bytes,
    remoteBytes: base.bytes,
    actorId: "actor-b",
    patchOnly: true,
  });
  assert.ok(localOnlyPatch.patch, "a local-only annotation should produce an incremental patch against the base PDF");
  assert.equal(localOnlyPatch.incremental, true);
  assert.equal(localOnlyPatch.patch.baseLength, base.bytes.length);
  const patchedBytes = new Uint8Array(localOnlyPatch.patch.outputLength);
  patchedBytes.set(base.bytes, 0);
  patchedBytes.set(localOnlyPatch.patch.suffix, base.bytes.length);
  assert.ok(findIdentity(await inspect({ bytes: patchedBytes }), "remote-new-square"));

  const merged = await merge({ baseBytes: base.bytes, localBytes: local.bytes, remoteBytes: remote.bytes });
  const mergedInfo = await inspect({ bytes: merged.bytes });
  assert.equal(merged.changed, true);
  assert.equal(findIdentity(mergedInfo, existing.uuid).timestamp, 300);
  assert.ok(findIdentity(mergedInfo, "remote-new-square"));
  const winning = await getAnnotation(merged.bytes, existing.uuid);
  assert.equal(winning.dict.lookup(PDFName.of("Contents"), PDFHexString).decodeText(), "local winner");
  const repeat = await merge({ baseBytes: base.bytes, localBytes: local.bytes, remoteBytes: merged.bytes });
  assert.equal(repeat.changed, false);
  assert.deepEqual(repeat.bytes, merged.bytes);
  assert.equal(repeat.stateDigest, merged.stateDigest);
});

test("newer delete wins over edit and remains as a durable tombstone", async () => {
  const base = await makeBase({ annotations: [{ subtype: "FreeText", contents: "base" }] });
  const identity = (await inspect({ bytes: base.bytes })).identities.find((item) => item.kind === "freetext");
  const deletedDraft = await editBranch(base.bytes, refFromPdfJs(identity.ref), { remove: true });
  const localDelete = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: deletedDraft.bytes,
    actorId: "actor-delete",
    operations: [operation({ uuid: identity.uuid, ref: identity.ref, timestamp: 500, actorId: "actor-delete", operationId: "delete-newer", action: "delete" })],
  });
  const editedDraft = await editBranch(base.bytes, refFromPdfJs(identity.ref), { contents: "older concurrent edit" });
  const remoteEdit = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: editedDraft.bytes,
    actorId: "actor-edit",
    operations: [operation({ uuid: identity.uuid, ref: identity.ref, timestamp: 400, actorId: "actor-edit", operationId: "edit-older" })],
  });
  const merged = await merge({ baseBytes: base.bytes, localBytes: localDelete.bytes, remoteBytes: remoteEdit.bytes });
  const info = await inspect({ bytes: merged.bytes });
  const tombstone = findIdentity(info, identity.uuid);
  assert.equal(tombstone.deleted, true);
  assert.equal(tombstone.timestamp, 500);
  const doc = await PDFDocument.load(merged.bytes, { updateMetadata: false });
  const annots = doc.getPages()[0].node.lookup(PDFName.of("Annots"), PDFArray);
  const remaining = Array.from({ length: annots.size() }, (_, index) => annots.get(index));
  assert.equal(remaining.some((ref) => ref instanceof PDFRef && ref.toString() === "7 0 R"), false);
  const repeat = await merge({ baseBytes: base.bytes, localBytes: localDelete.bytes, remoteBytes: merged.bytes });
  assert.equal(repeat.changed, false);
  assert.deepEqual(repeat.bytes, merged.bytes);
});

test("newer edit wins over an older delete and reports the losing concurrent branch", async () => {
  const base = await makeBase({ annotations: [{ subtype: "FreeText", contents: "base" }] });
  const identity = (await inspect({ bytes: base.bytes })).identities.find((item) => item.kind === "freetext");
  const deletedDraft = await editBranch(base.bytes, refFromPdfJs(identity.ref), { remove: true });
  const localDelete = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: deletedDraft.bytes,
    actorId: "actor-delete",
    operations: [operation({ uuid: identity.uuid, ref: identity.ref, timestamp: 100, actorId: "actor-delete", operationId: "delete-older", action: "delete" })],
  });
  const editDraft = await editBranch(base.bytes, refFromPdfJs(identity.ref), { contents: "newer edit" });
  const remoteEdit = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: editDraft.bytes,
    actorId: "actor-edit",
    operations: [operation({ uuid: identity.uuid, ref: identity.ref, timestamp: 200, actorId: "actor-edit", operationId: "edit-newer" })],
  });
  const merged = await merge({ baseBytes: base.bytes, localBytes: localDelete.bytes, remoteBytes: remoteEdit.bytes });
  const winner = await getAnnotation(merged.bytes, identity.uuid);
  assert.equal(winner.dict.lookup(PDFName.of("Contents"), PDFHexString).decodeText(), "newer edit");
  assert.equal(findIdentity(await inspect({ bytes: merged.bytes }), identity.uuid).deleted, false);
  assert.deepEqual(merged.conflicts, [{ uuid: identity.uuid, winner: "remote" }]);
});

test("a newer same-content undo upsert defeats an older concurrent delete", async () => {
  const base = await makeBase({ annotations: [{ subtype: "Square", contents: "unchanged saved editor" }] });
  const identity = (await inspect({ bytes: base.bytes })).identities.find((item) => item.kind === "square");

  // Undo after saving a deletion can restore the editor without changing its
  // PDF bytes. The operation clock still advances and must win over an older
  // tombstone when the two saved branches are merged.
  const restored = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: base.bytes,
    actorId: "actor-undo",
    operations: [operation({
      uuid: identity.uuid,
      ref: identity.ref,
      kind: identity.kind,
      timestamp: 300,
      actorId: "actor-undo",
      operationId: "undo-same-content",
      pageIndex: identity.pageIndex,
    })],
  });
  const deletedDraft = await editBranch(base.bytes, refFromPdfJs(identity.ref), { remove: true });
  const deleted = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: deletedDraft.bytes,
    actorId: "actor-delete",
    operations: [operation({
      uuid: identity.uuid,
      ref: identity.ref,
      kind: identity.kind,
      timestamp: 200,
      actorId: "actor-delete",
      operationId: "older-delete",
      action: "delete",
      pageIndex: identity.pageIndex,
    })],
  });

  for (const [localBytes, remoteBytes, expectedWinner] of [
    [restored.bytes, deleted.bytes, "local"],
    [deleted.bytes, restored.bytes, "remote"],
  ]) {
    const merged = await merge({ baseBytes: base.bytes, localBytes, remoteBytes });
    const result = findIdentity(await inspect({ bytes: merged.bytes }), identity.uuid);
    assert.equal(result.deleted, false);
    assert.equal(result.timestamp, 300);
    assert.deepEqual(merged.conflicts, [{ uuid: identity.uuid, winner: expectedWinner }]);
  }
});

test("semantic remote equality does not discard remote non-annotation metadata", async () => {
  const base = await makeBase({ annotations: [{ subtype: "Square", contents: "base square" }] });
  const identity = (await inspect({ bytes: base.bytes })).identities.find((item) => item.kind === "square");
  const remoteDoc = await PDFDocument.load(base.bytes, { updateMetadata: false });
  remoteDoc.setTitle("Remote title that must survive annotation sync");
  const remoteBytes = await remoteDoc.save({ useObjectStreams: false });
  const localDraft = await editBranch(base.bytes, refFromPdfJs(identity.ref), { contents: "local square edit" });
  const local = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: localDraft.bytes,
    actorId: "actor-local",
    operations: [operation({ uuid: identity.uuid, ref: identity.ref, kind: "square", timestamp: 100, actorId: "actor-local", operationId: "square-edit" })],
  });
  const merged = await merge({ baseBytes: base.bytes, localBytes: local.bytes, remoteBytes });
  const mergedDoc = await PDFDocument.load(merged.bytes, { updateMetadata: false });
  assert.equal(mergedDoc.getTitle(), "Remote title that must survive annotation sync");
  const annotation = await getAnnotation(merged.bytes, identity.uuid);
  assert.equal(annotation.dict.lookup(PDFName.of("Contents"), PDFHexString).decodeText(), "local square edit");
});

test("copied winner preserves AP and NM while /P, popup /Parent and /IRT target destination refs", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([420, 540]);
  page.drawText("Stable page body for relationship test", { x: 24, y: 500, size: 12 });
  const parentRef = addAnnotation(doc, 0, { subtype: "FreeText", nm: "Parent NM", contents: "parent", popup: true, appearance: "parent AP" });
  const replyRef = addAnnotation(doc, 0, { subtype: "FreeText", nm: "Reply NM", contents: "reply base", irt: parentRef, appearance: "reply old AP" });
  const baseBytes = await doc.save({ useObjectStreams: false });
  const ids = await inspect({ bytes: baseBytes });
  const replyIdentity = ids.identities.find((item) => item.ref === `${replyRef.objectNumber}R`);
  assert.ok(replyIdentity);
  const localDraft = await editBranch(baseBytes, replyRef, { contents: "reply local", appearance: "reply new AP" });
  const local = await prepareLocal({
    baseBytes,
    draftBytes: localDraft.bytes,
    actorId: "actor-local",
    operations: [operation({ uuid: replyIdentity.uuid, ref: replyIdentity.ref, timestamp: 300, actorId: "actor-local", operationId: "reply-update" })],
  });
  const remoteDraft = await editBranch(baseBytes, null, {}, [{ subtype: "Highlight", nm: "Remote highlight", contents: "remote branch" }]);
  const remote = await prepareLocal({
    baseBytes,
    draftBytes: remoteDraft.bytes,
    actorId: "actor-remote",
    newAnnotations: [{ runtimeId: "h1", uuid: "remote-highlight", pageIndex: 0, kind: "highlight", order: 0 }],
    operations: [operation({ uuid: "remote-highlight", ref: null, kind: "highlight", timestamp: 250, actorId: "actor-remote", operationId: "create-highlight" })],
  });
  const merged = await merge({ baseBytes, localBytes: local.bytes, remoteBytes: remote.bytes });
  const result = await PDFDocument.load(merged.bytes, { updateMetadata: false });
  const pageRefInResult = result.getPages()[0].ref.toString();
  const reply = await getAnnotation(merged.bytes, replyIdentity.uuid);
  assert.equal(reply.dict.lookup(PDFName.of("NM"), PDFHexString).decodeText(), "Reply NM");
  assert.equal(reply.dict.get(PDFName.of("P")).toString(), pageRefInResult);
  const targetId = ids.identities.find((item) => item.ref === `${parentRef.objectNumber}R`).uuid;
  const target = await getAnnotation(merged.bytes, targetId);
  const popupRef = target.dict.get(PDFName.of("Popup"));
  const popup = result.context.lookup(popupRef, PDFDict);
  assert.equal(popup.get(PDFName.of("Parent")).toString(), target.ref.toString());
  assert.equal(popup.get(PDFName.of("P")).toString(), pageRefInResult);
  assert.equal(reply.dict.get(PDFName.of("IRT")).toString(), target.ref.toString());
  const appearanceRef = reply.dict.lookup(PDFName.of("AP"), PDFDict).get(PDFName.of("N"));
  const appearance = result.context.lookup(appearanceRef, PDFRawStream);
  assert.match(new TextDecoder().decode(appearance.getContents()), /reply new AP/);
});

test("annotation merge remaps GoTo and AP page refs to existing pages without copying the page tree", async () => {
  const doc = await PDFDocument.create();
  const pages = [doc.addPage([420, 540]), doc.addPage([420, 540]), doc.addPage([420, 540])];
  for (const [index, page] of pages.entries()) {
    page.drawText(`Stable body ${index + 1}`, { x: 24, y: 500, size: 12 });
  }
  const link = PDFDict.withContext(doc.context);
  link.set(PDFName.of("Type"), PDFName.of("Annot"));
  link.set(PDFName.of("Subtype"), PDFName.of("Link"));
  link.set(PDFName.of("Rect"), numberArray(doc, [20, 30, 120, 70]));
  const destination = PDFArray.withContext(doc.context);
  destination.push(pages[2].ref);
  destination.push(PDFName.of("Fit"));
  const action = PDFDict.withContext(doc.context);
  action.set(PDFName.of("S"), PDFName.of("GoTo"));
  action.set(PDFName.of("D"), destination);
  link.set(PDFName.of("A"), action);

  const appearanceStreamDictionary = PDFDict.withContext(doc.context);
  appearanceStreamDictionary.set(PDFName.of("Type"), PDFName.of("XObject"));
  appearanceStreamDictionary.set(PDFName.of("Subtype"), PDFName.of("Form"));
  appearanceStreamDictionary.set(PDFName.of("FormType"), PDFNumber.of(1));
  appearanceStreamDictionary.set(PDFName.of("BBox"), numberArray(doc, [0, 0, 80, 30]));
  const properties = PDFDict.withContext(doc.context);
  properties.set(PDFName.of("Pg"), pages[1].ref);
  const propertiesRef = doc.context.register(properties);
  const resources = PDFDict.withContext(doc.context);
  resources.set(PDFName.of("Properties"), propertiesRef);
  appearanceStreamDictionary.set(PDFName.of("Resources"), doc.context.register(resources));
  const appearanceRef = doc.context.register(PDFRawStream.of(
    appearanceStreamDictionary,
    new TextEncoder().encode("q\n% page-linked appearance resource\nQ\n"),
  ));
  const appearance = PDFDict.withContext(doc.context);
  appearance.set(PDFName.of("N"), appearanceRef);
  link.set(PDFName.of("AP"), appearance);
  const linkRef = doc.context.register(link);
  annotsFor(doc, pages[0]).push(linkRef);
  addAnnotation(doc, 0, { subtype: "Square", contents: "before" });
  const baseBytes = await doc.save({ useObjectStreams: false });
  const baseFingerprintDoc = await PDFDocument.load(baseBytes, { updateMetadata: false });
  const sourcePageRefs = baseFingerprintDoc.getPages().map((page) => page.ref);
  const basePageFingerprints = getPageFingerprint(baseFingerprintDoc, refMaps(baseFingerprintDoc));
  const baseInfo = await inspect({ bytes: baseBytes });
  const editedIdentity = baseInfo.identities.find((item) => item.kind === "square");
  const linkIdentity = baseInfo.identities.find((item) => item.ref === `${linkRef.objectNumber}R`);
  assert.ok(editedIdentity);
  assert.ok(linkIdentity);

  const draft = await editBranch(baseBytes, refFromPdfJs(editedIdentity.ref), { contents: "after" });
  const local = await prepareLocal({
    baseBytes,
    draftBytes: draft.bytes,
    actorId: "actor-local",
    operations: [operation({ uuid: editedIdentity.uuid, ref: editedIdentity.ref, kind: "square", timestamp: 100, operationId: "edit-square" })],
  });
  const remoteDoc = await PDFDocument.load(baseBytes, { updateMetadata: false });
  const remotePages = remoteDoc.getPages();
  const pageTree = remoteDoc.catalog.lookup(PDFName.of("Pages"), PDFDict);
  const pageKids = pageTree.lookup(PDFName.of("Kids"), PDFArray);
  const remotePageRefs = remotePages.map(() => remoteDoc.context.nextRef());
  for (let index = 0; index < remotePages.length; index += 1) {
    const oldRef = remotePages[index].ref;
    remoteDoc.context.assign(remotePageRefs[index], remotePages[index].node);
    remoteDoc.context.delete(oldRef);
    pageKids.set(index, remotePageRefs[index]);
  }
  const remoteLink = remoteDoc.context.lookup(linkRef, PDFDict);
  const remoteAction = remoteLink.lookup(PDFName.of("A"), PDFDict);
  remoteAction.lookup(PDFName.of("D"), PDFArray).set(0, remotePageRefs[2]);
  const remoteAppearanceRef = remoteLink.lookup(PDFName.of("AP"), PDFDict).get(PDFName.of("N"));
  const remoteAppearanceStream = remoteDoc.context.lookup(remoteAppearanceRef, PDFRawStream);
  const remoteResourcesRef = remoteAppearanceStream.dict.get(PDFName.of("Resources"));
  const remoteResources = remoteDoc.context.lookup(remoteResourcesRef, PDFDict);
  const remotePropertiesRef = remoteResources.get(PDFName.of("Properties"));
  remoteDoc.context.lookup(remotePropertiesRef, PDFDict).set(PDFName.of("Pg"), remotePageRefs[1]);
  assert.notEqual(remotePageRefs[1].toString(), sourcePageRefs[1].toString(), "the AP page ref must differ across branches");
  assert.notEqual(remotePageRefs[2].toString(), sourcePageRefs[2].toString(), "the GoTo page ref must differ across branches");
  remoteDoc.setTitle("Remote metadata update");
  const remoteBytes = await remoteDoc.save({ useObjectStreams: false });
  const remoteSavedDoc = await PDFDocument.load(remoteBytes, { updateMetadata: false });
  const remoteSavedPageRefs = remoteSavedDoc.getPages().map((page) => page.ref.toString());
  assert.notEqual(remoteSavedPageRefs[1], sourcePageRefs[1].toString());
  assert.notEqual(remoteSavedPageRefs[2], sourcePageRefs[2].toString());
  assert.deepEqual(getPageFingerprint(remoteSavedDoc, refMaps(remoteSavedDoc)), basePageFingerprints, "reassigning page refs must preserve page lineage");
  const merged = await merge({ baseBytes, localBytes: local.bytes, remoteBytes });

  const mergedDoc = await PDFDocument.load(merged.bytes, { updateMetadata: false });
  assert.equal(mergedDoc.getPageCount(), 3, "merging annotations must not add copied page objects to the page tree");
  const pageObjectCount = mergedDoc.context.enumerateIndirectObjects().filter(([, value]) =>
    value instanceof PDFDict && value.get(PDFName.of("Type"))?.toString() === "/Page",
  ).length;
  assert.equal(pageObjectCount, 3, "merging must not leave detached copies of page objects in the context");
  const mergedLink = await getAnnotation(merged.bytes, linkIdentity.uuid);
  const mergedAction = mergedLink.dict.lookup(PDFName.of("A"), PDFDict);
  assert.equal(mergedAction.lookup(PDFName.of("S"), PDFName).toString(), "/GoTo");
  const mergedDestination = mergedAction.lookup(PDFName.of("D"), PDFArray);
  assert.equal(mergedDestination.get(0).toString(), mergedDoc.getPages()[2].ref.toString(), "the cross-page target must point at the existing destination page");
  assert.equal(mergedDestination.get(1).toString(), "/Fit");
  const mergedAppearanceRef = mergedLink.dict.lookup(PDFName.of("AP"), PDFDict).get(PDFName.of("N"));
  const mergedAppearanceStream = mergedDoc.context.lookup(mergedAppearanceRef, PDFRawStream);
  const mergedResourcesRef = mergedAppearanceStream.dict.get(PDFName.of("Resources"));
  const mergedResources = mergedDoc.context.lookup(mergedResourcesRef, PDFDict);
  const mergedPropertiesRef = mergedResources.get(PDFName.of("Properties"));
  const mergedProperties = mergedDoc.context.lookup(mergedPropertiesRef, PDFDict);
  assert.equal(mergedProperties.get(PDFName.of("Pg")).toString(), mergedDoc.getPages()[1].ref.toString(), "AP page references must target the matching existing page");
  assert.equal(findIdentity(await inspect({ bytes: merged.bytes }), linkIdentity.uuid).uuid, linkIdentity.uuid);
  assert.equal(findIdentity(await inspect({ bytes: merged.bytes }), editedIdentity.uuid).uuid, editedIdentity.uuid);
  const mergedFingerprints = getPageFingerprint(mergedDoc, refMaps(mergedDoc));
  assert.deepEqual(mergedFingerprints, basePageFingerprints, "page content and order must remain unchanged");
});

test("annotation merge still rejects a reference to the page-tree root", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([420, 540]);
  const targetPage = doc.addPage([420, 540]);
  page.drawText("Stable source page", { x: 24, y: 500, size: 12 });
  targetPage.drawText("Stable target page", { x: 24, y: 500, size: 12 });
  const link = PDFDict.withContext(doc.context);
  link.set(PDFName.of("Type"), PDFName.of("Annot"));
  link.set(PDFName.of("Subtype"), PDFName.of("Link"));
  link.set(PDFName.of("Rect"), numberArray(doc, [20, 30, 120, 70]));
  const destination = PDFArray.withContext(doc.context);
  destination.push(doc.catalog.get(PDFName.of("Pages")));
  destination.push(PDFName.of("Fit"));
  link.set(PDFName.of("Dest"), destination);
  annotsFor(doc, page).push(doc.context.register(link));
  addAnnotation(doc, 0, { subtype: "Square", contents: "before" });
  const baseBytes = await doc.save({ useObjectStreams: false });
  const baseInfo = await inspect({ bytes: baseBytes });
  const squareIdentity = baseInfo.identities.find((item) => item.kind === "square");
  assert.ok(squareIdentity);

  const draft = await editBranch(baseBytes, refFromPdfJs(squareIdentity.ref), { contents: "after" });
  const local = await prepareLocal({
    baseBytes,
    draftBytes: draft.bytes,
    actorId: "actor-local",
    operations: [operation({ uuid: squareIdentity.uuid, ref: squareIdentity.ref, kind: "square", timestamp: 100, operationId: "edit-square" })],
  });
  const remoteDoc = await PDFDocument.load(baseBytes, { updateMetadata: false });
  remoteDoc.setTitle("Remote metadata update");
  const remoteBytes = await remoteDoc.save({ useObjectStreams: false });

  await assert.rejects(
    merge({ baseBytes, localBytes: local.bytes, remoteBytes }),
    (error) => error.code === "PDF_MERGE_ANNOTATION_REFERENCES_PAGE",
  );
});

test("tagged annotation update is copied only when the structure-tree association is unchanged", async () => {
  const base = await makeBase({
    taggedRoot: true,
    annotations: [
      { subtype: "FreeText", contents: "tagged base", structParent: 4 },
      { subtype: "Square", contents: "untagged peer" },
    ],
  });
  const baseInfo = await inspect({ bytes: base.bytes });
  const tagged = baseInfo.identities.find((item) => item.kind === "freetext");
  const peer = baseInfo.identities.find((item) => item.kind === "square");
  const localDraft = await editBranch(base.bytes, refFromPdfJs(tagged.ref), { contents: "tagged changed safely" });
  const local = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: localDraft.bytes,
    actorId: "actor-tagged",
    operations: [operation({ uuid: tagged.uuid, ref: tagged.ref, timestamp: 300, actorId: "actor-tagged", operationId: "tagged-update" })],
  });
  const remoteDraft = await editBranch(base.bytes, refFromPdfJs(peer.ref), { contents: "peer remote change" });
  const remote = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: remoteDraft.bytes,
    actorId: "actor-peer",
    operations: [operation({ uuid: peer.uuid, ref: peer.ref, kind: "square", timestamp: 250, actorId: "actor-peer", operationId: "peer-update" })],
  });
  const merged = await merge({ baseBytes: base.bytes, localBytes: local.bytes, remoteBytes: remote.bytes });
  const mergedTagged = await getAnnotation(merged.bytes, tagged.uuid);
  assert.equal(mergedTagged.dict.lookup(PDFName.of("StructParent"), PDFNumber).asNumber(), 4);
  assert.equal(mergedTagged.dict.lookup(PDFName.of("Contents"), PDFHexString).decodeText(), "tagged changed safely");

  const changedTreeDoc = await PDFDocument.load(local.bytes, { updateMetadata: false });
  changedTreeDoc.catalog.lookup(PDFName.of("StructTreeRoot"), PDFDict).set(PDFName.of("K"), numberArray(changedTreeDoc, [99]));
  const changedTreeBytes = await changedTreeDoc.save({ useObjectStreams: false });
  await assert.rejects(
    merge({ baseBytes: base.bytes, localBytes: changedTreeBytes, remoteBytes: remote.bytes }),
    (error) => error.code === "PDF_MERGE_TAGGED_STRUCTURE_TREE_UNSAFE",
  );
});

test("new tagged annotation merge fails closed only when branches require a structure-tree merge", async () => {
  const base = await makeBase();
  const localDraftDoc = await PDFDocument.load(base.bytes, { updateMetadata: false });
  localDraftDoc.catalog.set(PDFName.of("StructTreeRoot"), localDraftDoc.context.register(PDFDict.withContext(localDraftDoc.context)));
  const taggedRef = addAnnotation(localDraftDoc, 0, { subtype: "FreeText", contents: "tagged new", structParent: 0 });
  const localDraft = await localDraftDoc.save({ useObjectStreams: false });
  const local = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: localDraft,
    actorId: "actor-local",
    newAnnotations: [{ runtimeId: "tagged-runtime", uuid: "tagged-new", pageIndex: 0, kind: "freetext", order: 0 }],
    operations: [operation({ uuid: "tagged-new", ref: null, kind: "freetext", timestamp: 100, actorId: "actor-local", operationId: "tagged-create" })],
  });
  const remoteDraft = await editBranch(base.bytes, null, {}, [{ subtype: "Square", contents: "remote square" }]);
  const remote = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: remoteDraft.bytes,
    actorId: "actor-remote",
    newAnnotations: [{ runtimeId: "square-runtime", uuid: "remote-square", pageIndex: 0, kind: "square", order: 0 }],
    operations: [operation({ uuid: "remote-square", ref: null, kind: "square", timestamp: 101, actorId: "actor-remote", operationId: "square-create" })],
  });
  await assert.rejects(
    merge({ baseBytes: base.bytes, localBytes: local.bytes, remoteBytes: remote.bytes }),
    (error) => error.code === "PDF_MERGE_TAGGED_STRUCTURE_TREE_UNSAFE",
  );
  assert.ok(taggedRef instanceof PDFRef);
});

test("a concurrent tagged-annotation delete fails closed instead of leaving a dangling structure-tree item", async () => {
  const base = await makeBase({
    taggedRoot: true,
    annotations: [
      { subtype: "FreeText", contents: "tagged target", structParent: 4 },
      { subtype: "Square", contents: "independent peer" },
    ],
  });
  const identities = (await inspect({ bytes: base.bytes })).identities;
  const tagged = identities.find((item) => item.kind === "freetext");
  const peer = identities.find((item) => item.kind === "square");
  const deleteDraft = await editBranch(base.bytes, refFromPdfJs(tagged.ref), { remove: true });
  const localDelete = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: deleteDraft.bytes,
    actorId: "actor-delete",
    operations: [operation({ uuid: tagged.uuid, ref: tagged.ref, timestamp: 100, actorId: "actor-delete", operationId: "tagged-delete", action: "delete" })],
  });
  const remoteDraft = await editBranch(base.bytes, refFromPdfJs(peer.ref), { contents: "remote peer change" });
  const remote = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: remoteDraft.bytes,
    actorId: "actor-remote",
    operations: [operation({ uuid: peer.uuid, ref: peer.ref, kind: "square", timestamp: 100, actorId: "actor-remote", operationId: "peer-update" })],
  });
  await assert.rejects(
    merge({ baseBytes: base.bytes, localBytes: localDelete.bytes, remoteBytes: remote.bytes }),
    (error) => error.code === "PDF_MERGE_TAGGED_STRUCTURE_TREE_UNSAFE" && /Keep the local checkpoint/.test(error.message),
  );
});

test("delete operations must identify the loaded annotation reference, page, and kind", async () => {
  const base = await makeBase({ annotations: [{ subtype: "FreeText", contents: "target" }] });
  const identity = (await inspect({ bytes: base.bytes })).identities.find((item) => item.kind === "freetext");
  const draft = await editBranch(base.bytes, refFromPdfJs(identity.ref), { remove: true });
  for (const changes of [
    { ref: "999R" },
    { pageIndex: 1 },
    { kind: "square" },
  ]) {
    await assert.rejects(
      prepareLocal({
        baseBytes: base.bytes,
        draftBytes: draft.bytes,
        actorId: "actor-delete",
        operations: [operation({ uuid: identity.uuid, ref: identity.ref, timestamp: 100, actorId: "actor-delete", operationId: "delete-exact", action: "delete", ...changes })],
      }),
      (error) => ["PDF_MERGE_OPERATION_IDENTITY_MISMATCH", "PDF_MERGE_PAGE_MOVE_UNSUPPORTED"].includes(error.code),
    );
  }
});

test("legacy inspect is deterministic and page-content changes fail closed", async () => {
  const base = await makeBase({ annotations: [{ subtype: "Underline", contents: "legacy" }] });
  const first = await inspect({ bytes: base.bytes });
  const second = await inspect({ bytes: base.bytes });
  assert.equal(first.documentId, second.documentId);
  assert.deepEqual(first.identities, second.identities);
  assert.match(first.identities[0].uuid, /^legacy-[a-f0-9]{32}$/);

  const changed = await PDFDocument.load(base.bytes, { updateMetadata: false });
  changed.getPages()[0].drawText("body changed", { x: 10, y: 10 });
  await assert.rejects(
    prepareLocal({ baseBytes: base.bytes, draftBytes: await changed.save({ useObjectStreams: false }), actorId: "actor" }),
    (error) => error.code === "PDF_MERGE_DOCUMENT_STRUCTURE_CHANGED",
  );
});

test("page count changes pause preparation before page fingerprinting", async () => {
  const base = await makeBase({ pageCount: 1 });
  const changed = await PDFDocument.load(base.bytes, { updateMetadata: false });
  changed.addPage([420, 540]);
  await assert.rejects(
    prepareLocal({
      baseBytes: base.bytes,
      draftBytes: await changed.save({ useObjectStreams: false }),
      actorId: "actor",
      __collectTimings: true,
    }),
    (error) => error.code === "PDF_MERGE_DOCUMENT_STRUCTURE_CHANGED" && /page count changed/.test(error.message),
  );
});

test("same-count page reordering fails after ordered identity fallback", async () => {
  const source = await PDFDocument.create();
  source.addPage([420, 540]).drawText("First page identity", { x: 20, y: 500, size: 12 });
  source.addPage([420, 540]).drawText("Second page identity", { x: 20, y: 500, size: 12 });
  const baseBytes = await source.save({ useObjectStreams: false });
  const reordered = await PDFDocument.load(baseBytes, { updateMetadata: false });
  const kids = reordered.catalog.Pages().Kids();
  const first = kids.get(0);
  kids.set(0, kids.get(1));
  kids.set(1, first);
  const reorderedBytes = await reordered.save({ useObjectStreams: false });
  const baseDoc = await PDFDocument.load(baseBytes, { updateMetadata: false });
  const reorderedDoc = await PDFDocument.load(reorderedBytes, { updateMetadata: false });
  assert.equal(baseDoc.getPages().length, reorderedDoc.getPages().length);
  assert.notDeepEqual(getFastPageIdentities(baseDoc), getFastPageIdentities(reorderedDoc));
  await assert.rejects(
    prepareLocal({ baseBytes, draftBytes: reorderedBytes, actorId: "actor" }),
    (error) => error.code === "PDF_MERGE_DOCUMENT_STRUCTURE_CHANGED",
  );
});

test("PDF rewrite with new object refs triggers full fallback and remains safe", async () => {
  const source = await makeBase({ pageCount: 3 });
  const taggedBaseline = await prepareLocal({
    baseBytes: source.bytes,
    draftBytes: source.bytes,
    actorId: "actor-device-01",
  });
  const original = await PDFDocument.load(taggedBaseline.bytes, { updateMetadata: false });
  const rewritten = await PDFDocument.create();
  for (const page of await rewritten.copyPages(original, [0, 1, 2])) rewritten.addPage(page);
  const rewrittenBytes = await rewritten.save({ useObjectStreams: false });
  const baselineDoc = await PDFDocument.load(taggedBaseline.bytes, { updateMetadata: false });
  const rewrittenDoc = await PDFDocument.load(rewrittenBytes, { updateMetadata: false });
  assert.notDeepEqual(getFastPageIdentities(baselineDoc), getFastPageIdentities(rewrittenDoc),
    "Save As style page copying should replace object references");

  const prepared = await prepareLocal({
    baseBytes: taggedBaseline.bytes,
    draftBytes: rewrittenBytes,
    checkpointBytes: taggedBaseline.bytes,
    actorId: "actor-device-01",
    baselineState: taggedBaseline.baselineState,
    documentRevisionMatch: true,
    dirtyState: { dirtyPageIndices: [], dirtyAnnotationIds: [] },
    __collectTimings: true,
  });
  assert.equal(prepared.__pdfReaderTiming.fallbackTriggered, true);
  assert.equal(prepared.__pdfReaderTiming.fallbackReason, "ORDERED_PAGE_IDENTITY_MISMATCH");
  assert.equal(prepared.__pdfReaderTiming.draftFingerprintPages, 3);
  assert.equal(prepared.ledger.pageFingerprints.length, 3);
});

test("verified ordered page identities reuse persisted fingerprints for annotation-only saves", async () => {
  const base = await makeBase({ pageCount: 186, annotations: [{ subtype: "FreeText", contents: "before", pageIndex: 16 }] });
  const baseInfo = await inspect({ bytes: base.bytes });
  const identity = baseInfo.identities.find((item) => item.kind === "freetext");
  const firstDraft = await editBranch(base.bytes, refFromPdfJs(identity.ref), { contents: "first edit" });
  const first = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: firstDraft.bytes,
    operations: [operation({ uuid: identity.uuid, ref: identity.ref, timestamp: 100, operationId: "first-edit", pageIndex: 16 })],
    dirtyState: { dirtyPageIndices: [16], dirtyAnnotationIds: [identity.uuid] },
    actorId: "actor-device-01",
    __collectTimings: true,
  });
  assert.ok(Array.isArray(first.ledger.pageIdentities));
  assert.equal(first.ledger.pageIdentities.length, 186);

  const savedIdentity = findIdentity(first, identity.uuid);
  const secondDraft = await editBranch(first.bytes, refFromPdfJs(savedIdentity.ref), { contents: "second edit" });
  const second = await prepareLocal({
    baseBytes: first.bytes,
    draftBytes: secondDraft.bytes,
    operations: [operation({ uuid: identity.uuid, ref: savedIdentity.ref, timestamp: 200, operationId: "second-edit", pageIndex: 16 })],
    dirtyState: { dirtyPageIndices: [16], dirtyAnnotationIds: [identity.uuid] },
    actorId: "actor-device-01",
    __collectTimings: true,
  });
  assert.equal(second.__pdfReaderTiming.pageFingerprintBaseCacheHit, true);
  assert.equal(second.__pdfReaderTiming.pageIdentityBaseDraftMatch, true);
  assert.equal(second.__pdfReaderTiming.pageFingerprintDraftCacheHit, true);
  assert.equal(first.__pdfReaderTiming.baselineFingerprintPages, 186,
    "an untagged legacy PDF migrates its baseline once on the first real save");
  assert.equal(second.__pdfReaderTiming.baselineFingerprintPages, 0,
    "the confirmed ledger/cache removes baseline content scans from subsequent saves");
  assert.equal(second.__pdfReaderTiming.draftFingerprintPages, 1,
    "a trusted annotation-only save fingerprints only its dirty page");
  assert.equal(second.__pdfReaderTiming.draftDirtyPagesVerified, 1);
  assert.equal(second.__pdfReaderTiming.fingerprint.mode, "PARTIAL");
});

test("an immutable Viewer source can save a second new annotation against its confirmed checkpoint", async () => {
  const base = await makeBase({ pageCount: 3 });
  const actorId = "actor-device-01";
  const firstUuid = "b6e4a6f7-a71e-4c71-b772-6bde6be6a281";
  const secondUuid = "f08dfc8b-c7a1-4c1a-a5e9-d5e64788515a";
  const firstDraft = await editBranch(base.bytes, null, {}, [
    { subtype: "Square", contents: "first", rect: [20, 30, 80, 70] },
  ]);
  const first = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: firstDraft.bytes,
    actorId,
    newAnnotations: [{ runtimeId: "pdfjs_internal_editor_0", uuid: firstUuid, pageIndex: 0, kind: "Square", order: 0 }],
    operations: [operation({ uuid: firstUuid, kind: "Square", timestamp: 100, operationId: "create-first" })],
    dirtyState: { dirtyPageIndices: [0], dirtyAnnotationIds: [firstUuid], newAnnotationIds: [firstUuid] },
    __collectTimings: true,
  });

  // The PDF.js document is still loaded from the original unannotated bytes.
  // Its second save serializes both id:null editors, while the Vault checkpoint
  // already contains the first annotation and its durable UUID ledger entry.
  const secondDraft = await editBranch(base.bytes, null, {}, [
    { subtype: "Square", contents: "first", rect: [20, 30, 80, 70] },
    { subtype: "Square", contents: "second", rect: [100, 130, 170, 200] },
  ]);
  const second = await prepareLocal({
    baseBytes: base.bytes,
    checkpointBytes: first.bytes,
    draftBytes: secondDraft.bytes,
    actorId,
    baselineState: first.sourceBaselineState,
    documentRevisionMatch: true,
    newAnnotations: [
      { runtimeId: "pdfjs_internal_editor_0", uuid: firstUuid, pageIndex: 0, kind: "Square", order: 0 },
      { runtimeId: "pdfjs_internal_editor_1", uuid: secondUuid, pageIndex: 0, kind: "Square", order: 1 },
    ],
    operations: [
      operation({ uuid: firstUuid, kind: "Square", timestamp: 200, operationId: "retain-first" }),
      operation({ uuid: secondUuid, kind: "Square", timestamp: 200, operationId: "create-second" }),
    ],
    dirtyState: { dirtyPageIndices: [0], dirtyAnnotationIds: [secondUuid], newAnnotationIds: [secondUuid] },
    __collectTimings: true,
  });

  assert.equal(second.__pdfReaderTiming.baselineFingerprintPages, 0);
  assert.equal(second.__pdfReaderTiming.draftFingerprintPages, 1);
  assert.equal(second.__pdfReaderTiming.fallbackTriggered, false);
  assert.deepEqual(new Set(second.ledger.entries.map((entry) => entry.uuid)), new Set([firstUuid, secondUuid]));
  assert.equal(second.ledger.entries.length, 2);
});

test("fast open records legacy annotations without computing page-content fingerprints", async () => {
  const base = await makeBase({ pageCount: 5, annotations: [{ subtype: "Underline", contents: "legacy" }] });
  const opened = await inspect({ bytes: base.bytes, fastOpen: true });
  assert.equal(opened.documentId, null);
  assert.equal(opened.ledger, null);
  assert.equal(opened.baselineState.pageFingerprints, null);
  assert.match(opened.identities[0].uuid, /^session-[a-f0-9]{32}$/);
  const doc = await PDFDocument.load(base.bytes, { updateMetadata: false });
  const identity = opened.identities[0];
  const ref = refFromPdfJs(identity.ref);
  doc.context.lookup(ref, PDFDict).set(PDFName.of("Contents"), text("first edit"));
  const draftBytes = await doc.save({ useObjectStreams: false });
  const prepared = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes,
    operations: [operation({ uuid: identity.uuid, ref: identity.ref, kind: identity.kind, timestamp: 10, operationId: "legacy-session-edit" })],
    dirtyState: { dirtyPageIndices: [0], dirtyAnnotationIds: [identity.uuid] },
    actorId: "actor-device-01",
    __collectTimings: true,
  });
  assert.equal(prepared.__pdfReaderTiming.legacySessionIdsRemapped, 1,
    "the first save maps a session UUID by exact reference, page and type");
  assert.ok(prepared.identities.some((entry) => entry.uuid.startsWith("legacy-")));
  assert.equal(prepared.__pdfReaderTiming.baselineFingerprintPages, 5);
  assert.equal(prepared.__pdfReaderTiming.fingerprint.mode, "FULL");
});

test("large embedded merge ledgers decode without overflowing the iOS argument stack", async () => {
  const base = await makeBase();
  const initial = await inspect({ bytes: base.bytes });
  const doc = await PDFDocument.load(base.bytes, { updateMetadata: false });
  const ledger = { ...initial.ledger, diagnosticPadding: "x".repeat(180_000) };
  doc.catalog.set(PDFName.of("ObReaderMerge"), PDFHexString.fromText(JSON.stringify(ledger)));
  const bytes = await doc.save({ useObjectStreams: false });

  const reopened = await inspect({ bytes });
  assert.equal(reopened.documentId, initial.documentId);
  assert.equal(reopened.stateDigest, initial.stateDigest);
  assert.equal(reopened.identities.length, initial.identities.length);

  const pdfDocEncoded = PDFHexString.of("4142".repeat(100_000));
  assert.equal(decodePdfString(pdfDocEncoded), "AB".repeat(100_000));

  // A UTF-16 BOM byte pair occurring at a chunk boundary is ordinary data in
  // PDFDocEncoding and must not be reinterpreted as a second string BOM.
  const boundaryBytes = new Uint8Array(8195).fill(0x41);
  boundaryBytes[8192] = 0xfe;
  boundaryBytes[8193] = 0xff;
  boundaryBytes[8194] = 0x42;
  const boundaryHex = Array.from(boundaryBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  assert.equal(
    decodePdfString(PDFHexString.of(boundaryHex)),
    `${"A".repeat(8192)}\u00fe\u00ffB`,
  );
});

test("source revision mismatch forces the full fingerprint fallback and records transaction metrics", async () => {
  const base = await makeBase({ pageCount: 3 });
  const doc = await PDFDocument.load(base.bytes, { updateMetadata: false });
  addAnnotation(doc, 1, { subtype: "FreeText", contents: "fast-path candidate" });
  const draftBytes = await doc.save({ useObjectStreams: false });
  const baseInfo = await inspect({ bytes: base.bytes });
  const first = await prepareLocal({
    baseBytes: base.bytes, draftBytes, actorId: "actor-device-01",
    newAnnotations: [{ runtimeId: "new-editor", uuid: "new-annotation", pageIndex: 1, kind: "freetext", order: 0 }],
    operations: [operation({ uuid: "new-annotation", ref: null, timestamp: 20, operationId: "new-annotation-create", pageIndex: 1 })],
    __collectTimings: true,
  });
  const second = await prepareLocal({
    baseBytes: first.bytes, draftBytes: first.bytes, checkpointBytes: first.bytes,
    actorId: "actor-device-01", baselineState: first.baselineState,
    documentRevisionMatch: false, forceFullFingerprints: true,
    saveTransactionId: "save-tx-external-revision", dirtyState: { dirtyPageIndices: [1], dirtyAnnotationIds: ["new-annotation"] },
    __collectTimings: true,
  });
  assert.equal(second.__pdfReaderTiming.saveTransactionId, "save-tx-external-revision");
  assert.equal(second.__pdfReaderTiming.documentRevisionMatch, false);
  assert.equal(second.__pdfReaderTiming.fallbackTriggered, true);
  assert.equal(second.__pdfReaderTiming.fallbackReason, "SOURCE_REVISION_MISMATCH");
  assert.equal(second.__pdfReaderTiming.baselineFingerprintPages, 3);
  assert.equal(second.__pdfReaderTiming.dirtyPageCount, 1);
  const token = getDocumentRevisionToken(await PDFDocument.load(base.bytes), base.bytes);
  assert.equal(token.byteLength, base.bytes.length);
  assert.equal(token.pageCount, 3);
  assert.ok(baseInfo.documentId);
});

test("creation stamps are mandatory and equal-clock ties use actor/op identity", async () => {
  const base = await makeBase();
  const draft = await editBranch(base.bytes, null, {}, [{ subtype: "Ink", contents: "new ink" }]);
  await assert.rejects(
    prepareLocal({
      baseBytes: base.bytes,
      draftBytes: draft.bytes,
      actorId: "actor-a",
      newAnnotations: [{ runtimeId: "ink-runtime", uuid: "ink-uuid", pageIndex: 0, kind: "ink", order: 0 }],
      operations: [],
    }),
    (error) => error.code === "PDF_MERGE_MISSING_CREATION_OPERATION",
  );

  const original = await makeBase({ annotations: [{ subtype: "FreeText", contents: "base" }] });
  const identity = (await inspect({ bytes: original.bytes })).identities.find((item) => item.kind === "freetext");
  async function branch(content, actorId) {
    const changed = await editBranch(original.bytes, refFromPdfJs(identity.ref), { contents: content });
    return prepareLocal({
      baseBytes: original.bytes,
      draftBytes: changed.bytes,
      actorId,
      operations: [operation({ uuid: identity.uuid, ref: identity.ref, timestamp: 200, actorId, operationId: "same-wall-op", })],
    });
  }
  const local = await branch("actor a", "actor-a");
  const remote = await branch("actor z", "actor-z");
  const merged = await merge({ baseBytes: original.bytes, localBytes: local.bytes, remoteBytes: remote.bytes });
  const winner = await getAnnotation(merged.bytes, identity.uuid);
  assert.equal(winner.dict.lookup(PDFName.of("Contents"), PDFHexString).decodeText(), "actor z");
});

test("three-way annotation reconciliation reuses verified ordered page fingerprints", async () => {
  const base = await makeBase({ pageCount: 12, annotations: [{ subtype: "FreeText", contents: "before" }] });
  const baseline = await inspect({ bytes: base.bytes });
  const identity = baseline.identities.find((item) => item.kind === "freetext");
  const changed = await editBranch(base.bytes, refFromPdfJs(identity.ref), { contents: "after" });
  const local = await prepareLocal({
    baseBytes: base.bytes,
    draftBytes: changed.bytes,
    operations: [operation({ uuid: identity.uuid, ref: identity.ref, timestamp: 50, operationId: "fast-merge-edit" })],
    actorId: "fast-merge-actor",
  });

  const cachedMerge = await merge({
    baseBytes: base.bytes,
    localBytes: local.bytes,
    remoteBytes: base.bytes,
    actorId: "fast-merge-actor",
    baselineState: baseline.baselineState,
    __collectTimings: true,
    saveTransactionId: "fast-merge-transaction",
  });
  assert.equal(cachedMerge.__pdfReaderTiming.saveTransactionId, "fast-merge-transaction");
  assert.equal(cachedMerge.__pdfReaderTiming.baselineCacheHit, true);
  assert.equal(cachedMerge.__pdfReaderTiming.baselineFingerprintPages, 0);
  assert.equal(cachedMerge.__pdfReaderTiming.draftFingerprintPages, 0);
  assert.equal(cachedMerge.__pdfReaderTiming.remoteFingerprintPages, 0);
  assert.equal(cachedMerge.__pdfReaderTiming.fingerprint.mode, "NONE");
  assert.equal(findIdentity(cachedMerge, identity.uuid).uuid, identity.uuid);

  const uncachedMerge = await merge({
    baseBytes: base.bytes,
    localBytes: local.bytes,
    remoteBytes: base.bytes,
    actorId: "fast-merge-actor",
    __collectTimings: true,
  });
  assert.equal(uncachedMerge.__pdfReaderTiming.baselineCacheHit, false);
  assert.ok(uncachedMerge.__pdfReaderTiming.baselineFingerprintPages > 0);
  assert.equal(uncachedMerge.__pdfReaderTiming.fingerprint.mode, "FULL");
});
