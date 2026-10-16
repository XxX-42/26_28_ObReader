export const TRACEMONKEY_SOURCE_SHA256 =
  "3662ff519e485810520552bf301d8c3b2b917fd2f83303f4965d7abed367e113";

export function browserSidecarHarnessScript({
  channel,
  token,
  sourceHash = `sha256:${TRACEMONKEY_SOURCE_SHA256}`,
  sourcePath = "tests/fixtures/tracemonkey.pdf",
}) {
  if (!channel || !token || !sourceHash) {
    throw new TypeError("A channel, token, and source hash are required.");
  }
  return `<script>
    (() => {
      const channel = ${JSON.stringify(channel)};
      const token = ${JSON.stringify(token)};
      const sourceHash = ${JSON.stringify(sourceHash)};
      const sourcePath = ${JSON.stringify(sourcePath)};
      const documents = new Map();
      const frame = document.querySelector("iframe");
      const host = window.__browserSidecarHost = {
        sourceHash,
        sourcePath,
        documents,
        identityRequests: [],
        durableWrites: [],
        errors: [],
        snapshotBroadcasts: [],
        operationsFor(documentId) {
          return [...(documents.get(documentId)?.operations?.values() || [])];
        },
        snapshotFor(documentId) {
          const document = documents.get(documentId);
          return document?.identity ? snapshot(documentId, document) : null;
        },
        broadcastSnapshot(documentId, openRequest, sourceMatch = "MATCH") {
          const document = documents.get(documentId);
          if (!document?.identity || !frame?.contentWindow) return false;
          const externalAnnotations = snapshot(documentId, document);
          host.snapshotBroadcasts.push({
            documentId,
            openRequest,
            revision: externalAnnotations.revision,
            annotationCount: externalAnnotations.annotations.length,
            tombstoneCount: externalAnnotations.tombstones.length,
          });
          frame.contentWindow.postMessage({
            channel,
            token,
            type: "external-annotations-update",
            documentId,
            openRequest,
            sourceMatch,
            externalAnnotations,
          }, "*");
          return true;
        },
        copyDocument(sourceDocumentId, destinationDocumentId) {
          const source = documents.get(sourceDocumentId);
          if (!source) throw new Error("No sidecar operations exist for the source document.");
          documents.set(destinationDocumentId, {
            operations: new Map(source.operations),
            revision: source.revision,
            identity: source.identity ? {
              pageCount: source.identity.pageCount,
              orderedPageIdentities: [...source.identity.orderedPageIdentities],
            } : null,
          });
        },
      };
      const emptyDocument = () => ({ operations: new Map(), revision: 0, identity: null });
      const snapshot = (documentId, document) => {
        const rows = [...document.operations.values()];
        const identity = document.identity;
        const annotations = rows.filter((row) => row.deleted !== true);
        const tombstones = rows.filter((row) => row.deleted === true).map((row) => {
          const { deleted: _deleted, ...tombstone } = row;
          return tombstone;
        });
        return {
          schemaVersion: 2,
          kind: "pdf-annotation-snapshot",
          documentId,
          docKey: "b10f9a3ce227",
          revision: document.revision,
          updatedAt: Date.now(),
          source: {
            sourcePath,
            sourceHash,
            pageCount: identity.pageCount,
            orderedPageIdentities: [...identity.orderedPageIdentities],
          },
          legacyIdentities: [],
          annotations,
          tombstones,
        };
      };
      window.addEventListener("message", (event) => {
        if (event.source !== frame?.contentWindow || !event.data ||
            event.data.channel !== channel || event.data.token !== token) return;
        const message = event.data;
        if (message.type === "annotation-source-identity") {
          const document = documents.get(message.documentId) || emptyDocument();
          documents.set(message.documentId, document);
          host.identityRequests.push({
            documentId: message.documentId,
            openRequest: message.openRequest,
            sourceHash: message.sourceHash ?? null,
            pageCount: message.pageCount,
            orderedPageIdentities: Array.isArray(message.orderedPageIdentities)
              ? [...message.orderedPageIdentities]
              : null,
            identityStatus: message.identityStatus,
          });
          if (
            message.identityStatus !== "KNOWN" ||
            !Number.isSafeInteger(message.pageCount) ||
            !Array.isArray(message.orderedPageIdentities) ||
            message.orderedPageIdentities.length !== message.pageCount ||
            message.orderedPageIdentities.some((identity) => typeof identity !== "string")
          ) {
            event.source.postMessage({
              channel, token, type: "annotation-source-mismatch",
              documentId: message.documentId, openRequest: message.openRequest,
              reason: "PAGE_IDENTITY_UNAVAILABLE",
            }, "*");
            return;
          }
          document.identity = {
            pageCount: message.pageCount,
            orderedPageIdentities: [...message.orderedPageIdentities],
          };
          event.source.postMessage({
            channel,
            token,
            type: "external-annotations-update",
            documentId: message.documentId,
            openRequest: message.openRequest,
            sourceMatch: document.operations.size ? "MATCH" : "BASELINE_ESTABLISHED",
            identityConfirmed: true,
            externalAnnotations: snapshot(message.documentId, document),
          }, "*");
        } else if (message.type === "save" || message.type === "recover") {
          const document = documents.get(message.documentId) || emptyDocument();
          documents.set(message.documentId, document);
          const operations = Array.isArray(message.operations) ? message.operations : [];
          if (message.revision > 0 && operations.length === 0) {
            host.errors.push("Revision " + message.revision + " had no sidecar operations.");
          }
          for (const operation of operations) {
            if (!operation || typeof operation.uuid !== "string") {
              host.errors.push("The viewer sent an operation without a stable UUID.");
              continue;
            }
            const prior = document.operations.get(operation.uuid);
            const stamp = (row) => [
              row?.clock?.timestamp ?? 0,
              row?.clock?.logical ?? 0,
              row?.clock?.deviceId ?? "",
              row?.clock?.opId ?? "",
            ];
            const left = stamp(operation);
            const right = stamp(prior);
            const newer = !prior || left.some((value, index) => {
              for (let earlier = 0; earlier < index; earlier += 1) {
                if (left[earlier] !== right[earlier]) return false;
              }
              return value > right[index];
            });
            if (newer || left.every((value, index) => value === right[index])) {
              document.operations.set(operation.uuid, structuredClone(operation));
            }
          }
          document.revision = Math.max(document.revision, Number(message.revision) || 0);
          host.durableWrites.push({
            type: message.type,
            documentId: message.documentId,
            openRequest: message.openRequest,
            requestId: message.requestId,
            revision: message.revision,
            operationCount: operations.length,
            sourceBytes: message.data?.byteLength ?? 0,
            durableAt: performance.timeOrigin + performance.now(),
          });
        }
      });
    })();
  </script>`;
}
