import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Test-only source adapter. Keep production message authentication, Context
// capture and source-open methods intact instead of implementing a second Host.
// The caller supplies only imported dependencies and the Obsidian boundary.
export async function readLearningBrowserProductionMethods(mainPath) {
  const source = await readFile(mainPath, 'utf8');
  const method = name => {
    const start = new RegExp(`^  (?:async )?${name}\\(`, 'm').exec(source);
    assert.ok(start, `Production method ${name} must exist`);
    const tail = source.slice(start.index + start[0].length);
    const next = /^  (?:async )?[A-Za-z_$][\w$]*\(/m.exec(tail);
    assert.ok(next, `Production method ${name} must have an explicit following method`);
    return source.slice(start.index, start.index + start[0].length + next.index).trim();
  };
  const helper = name => {
    const start = new RegExp(`^function ${name}\\(`, 'm').exec(source);
    assert.ok(start, `Production helper ${name} must exist`);
    const end = /^\}/m.exec(source.slice(start.index));
    assert.ok(end, `Production helper ${name} must close`);
    return source.slice(start.index, start.index + end.index + 1);
  };
  const constant = name => {
    const declaration = new RegExp(`^const ${name} = [^;]+;`, 'm').exec(source);
    assert.ok(declaration, `Production constant ${name} must exist`);
    return declaration[0];
  };
  const viewNames = ['isCurrentReaderAnchorIdentity', 'requestReaderAnchorCapture',
    'applyPendingReaderTarget', 'isCurrentVocabularyIdentity', 'cancelVocabularyEntryLookups',
    'handleVocabularyBridgeMessage', 'updatePendingVocabularyEntryPersonalRecord'];
  const pluginNames = ['handleReaderAnchorCapture', 'handleReaderVocabularyContextSave',
    'commitReaderVocabularyContextSave', 'openVocabularyContext'];
  const declarations = ['MAX_VOCABULARY_QUERY_TEXT_CHARS', 'MAX_VOCABULARY_SURFACE_CHARS',
    'MAX_LINE_HYPHEN_EVIDENCE', 'MAX_LINE_HYPHEN_SEGMENT_INDEX', 'MAX_LINE_HYPHEN_SOURCE_OFFSET',
    'VOCABULARY_LETTER_OR_MARK', 'VOCABULARY_LETTER', 'VOCABULARY_LINE_HYPHEN',
    'VOCABULARY_DISPLAY_MODES'].map(constant).join('\n');
  const body = `${declarations}\n${helper('vocabularyCodePointBefore')}\n${helper('vocabularyHasLetterBefore')}
    ${helper('validateVocabularySurface')}\n${helper('vocabularyDictionaryPercent')}\n${helper('normalizeReaderTarget')}
    return { view: { ${viewNames.map(method).join(',\n')} },
      plugin: { ${pluginNames.map(method).join(',\n')} } };`;
  // Parse all extracted methods now, without calling services or opening a PDF.
  new Function('CHANNEL', 'Notice', 'makeToken', 'normalizeVocabularyTermKey',
    'canonicalHash', 'isPdfFile', 'VocabularyEntryModal', body);
  return body;
}
