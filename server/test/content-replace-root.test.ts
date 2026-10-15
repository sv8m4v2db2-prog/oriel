import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { COLLAB_FRAGMENT } from '@oriel/shared';
import { applyFragment } from '../src/io/content.js';

const document = (text:string) => {
  const doc=new Y.Doc();const group=new Y.XmlElement('blockGroup');
  const container=new Y.XmlElement('blockContainer');const paragraph=new Y.XmlElement('paragraph');
  const body=new Y.XmlText();body.insert(0,text);paragraph.insert(0,[body]);container.insert(0,[paragraph]);group.insert(0,[container]);
  doc.getXmlFragment(COLLAB_FRAGMENT).insert(0,[group]);return {doc,group};
};

test('content replacement retains the shared root used by connected editor bindings', () => {
  const target=document('Ancien contenu');const source=document('Nouveau contenu');
  let rootDeleted=false;
  target.doc.getXmlFragment(COLLAB_FRAGMENT).observe(event=>{if(event.changes.deleted.size)rootDeleted=true});
  target.doc.transact(()=>assert.equal(applyFragment(target.doc,source.doc,'replace'),1));
  assert.equal(rootDeleted,false);
  assert.equal(target.doc.getXmlFragment(COLLAB_FRAGMENT).get(0),target.group);
  assert.equal(target.group.toString(),source.group.toString());
  // A subsequent transaction from the same bound root remains attached to the document.
  const block=new Y.XmlElement('blockContainer');target.group.insert(1,[block]);
  assert.equal(target.doc.getXmlFragment(COLLAB_FRAGMENT).get(0).length,2);
  target.doc.destroy();source.doc.destroy();
});

test('merging a targeted edit preserves concurrent text and the existing shared nodes', () => {
  const target=document('Texte');const source=new Y.Doc();Y.applyUpdate(source,Y.encodeStateAsUpdate(target.doc));
  const root=source.getXmlFragment(COLLAB_FRAGMENT).get(0) as Y.XmlElement;
  (root.get(0) as Y.XmlElement).setAttribute('id','new-id');
  const paragraph=(target.group.get(0) as Y.XmlElement).get(0) as Y.XmlElement;
  const text=paragraph.get(0) as Y.XmlText;text.insert(text.length,' ajouté pendant la migration');
  target.doc.transact(()=>applyFragment(target.doc,source,'merge'));
  assert.equal(target.doc.getXmlFragment(COLLAB_FRAGMENT).get(0),target.group);
  assert.equal((target.group.get(0) as Y.XmlElement).getAttribute('id'),'new-id');
  assert.equal(text.toString(),'Texte ajouté pendant la migration');
  source.destroy();target.doc.destroy();
});

test('merge rejects non-XML content before applying it', () => {
  const target=document('Conservé');const source=new Y.Doc();Y.applyUpdate(source,Y.encodeStateAsUpdate(target.doc));
  const root=source.getXmlFragment(COLLAB_FRAGMENT).get(0) as Y.XmlElement;
  root.setAttribute('invalid',new Y.Map() as never);
  const before=target.group.toString();
  assert.throws(()=>target.doc.transact(()=>applyFragment(target.doc,source,'merge')),/Contenu invalide/);
  assert.equal(target.group.toString(),before);
  source.destroy();target.doc.destroy();
});
