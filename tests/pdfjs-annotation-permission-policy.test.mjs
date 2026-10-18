import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viewerSource = await readFile(
  path.join(root, "vendor", "pdfjs-generic-legacy", "web", "viewer.mjs"),
  "utf8",
);

function extractAnnotationPermissionGate(source) {
  const methodStart = source.indexOf("#initializePermissions(permissions)");
  assert.notEqual(methodStart, -1, "PDF.js permission initializer must remain present");
  const permissionReference = source.indexOf("PermissionFlag.MODIFY_CONTENTS", methodStart);
  assert.notEqual(permissionReference, -1, "The permission gate must reference MODIFY_CONTENTS");
  const conditionStart = source.lastIndexOf("if", permissionReference);
  const openParen = source.indexOf("(", conditionStart);
  assert.ok(openParen >= conditionStart, "The permission gate must be an if condition");

  let depth = 0;
  let closeParen = -1;
  for (let index = openParen; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        closeParen = index;
        break;
      }
    }
  }
  assert.notEqual(closeParen, -1, "The permission condition must be balanced");
  const condition = source.slice(openParen + 1, closeParen);
  const afterCondition = source.slice(closeParen + 1, closeParen + 220);
  assert.match(
    afterCondition,
    /params\.annotationEditorMode\s*=\s*AnnotationEditorType\.DISABLE/,
    "This condition must be the editor-disable gate",
  );
  return new Function(
    "permissions",
    "PermissionFlag",
    `return (${condition});`,
  );
}

const shouldDisableEditors = extractAnnotationPermissionGate(viewerSource);
const PermissionFlag = Object.freeze({
  MODIFY_CONTENTS: 0x08,
  MODIFY_ANNOTATIONS: 0x20,
});

test("PDF.js enables annotation editors when either annotation or content modification is permitted", () => {
  assert.equal(shouldDisableEditors([PermissionFlag.MODIFY_CONTENTS], PermissionFlag), false);
  assert.equal(shouldDisableEditors([PermissionFlag.MODIFY_ANNOTATIONS], PermissionFlag), false);
  assert.equal(
    shouldDisableEditors([4, 16, 32, 256, 512, 2048], PermissionFlag),
    false,
    "The remote read-only-source PDF grants annotation modification (32) without content modification (8).",
  );
  assert.equal(shouldDisableEditors([4, 16, 256], PermissionFlag), true);
});
