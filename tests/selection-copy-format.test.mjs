import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { formatSelectionCopy, COPY_PRESETS } = createRequire(import.meta.url)('../plugin/selection-copy-format.cjs');
const context = { path: '12_books/书.pdf', page: 40, pageLabel: '二十七', pageCount: 256,
  text: '第一句。\n第二段。', linktext: '12_books/书.pdf#page=40&obreader=sel.uuid', color: '#fff066', anchorId: 'uuid' };
test('default output preserves the complete stable target and existing display', () => {
  assert.equal(formatSelectionCopy(context), '[[12_books/书.pdf#page=40&obreader=sel.uuid|书 · p.40]]');
});
test('link is a bare destination and can be wrapped explicitly without double brackets', () => {
  assert.equal(formatSelectionCopy(context,{selectionCopyTemplate:'{{link}}'}),context.linktext);
  assert.equal(formatSelectionCopy(context,{selectionCopyTemplate:'[[{{link}}]]'}),'[['+context.linktext+']]');
});
test('PDF++ data parameters and aliases use actual source values', () => {
  const fields=['file.path','pdf.basename','folder.name','page','pageLabel','pageCount','selection','colorName','comment','anchorId'];
  assert.equal(formatSelectionCopy(context,{selectionCopyTemplate:fields.map(f=>'{{'+f+'}}').join(';')}),
    '12_books/书.pdf;书;12_books;40;二十七;256;第一句。\n第二段。;#fff066;;uuid');
});
test('display, page links and preset templates share the original stable link', () => {
  for(const preset of COPY_PRESETS) assert.ok(formatSelectionCopy(context,{selectionCopyTemplate:preset.template}));
  assert.equal(formatSelectionCopy(context,{selectionDisplayTemplate:'p{{pageLabel}}',selectionCopyTemplate:'{{linkWithDisplay}}\n{{linkToPage}}'}),
    '[[12_books/书.pdf#page=40&obreader=sel.uuid|p二十七]]\n[[12_books/书.pdf#page=40]]');
  assert.equal(formatSelectionCopy(context,{selectionCopyTemplate:'{{text}}'}),context.text);
});
test('templates reject unknown parameters and code rather than evaluating it', () => {
  for(const value of ['{{app.vault.delete(file)}}','{{text.toUpperCase()}}','{{missing}}','{{text','']) {
    assert.throws(()=>formatSelectionCopy(context,{selectionCopyTemplate:value}));
  }
  assert.equal(formatSelectionCopy({...context,text:'{{app}}'},{selectionCopyTemplate:'{{text}}'}),'{{app}}');
});
