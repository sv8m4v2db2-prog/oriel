import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TreeResponse } from '@oriel/shared';
import { addMember, createPage, expectOk, setupAdmin, startTestServer } from './helpers.js';

test('navigation groups preserve hierarchy and workspace/private access', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid } = await setupAdmin(srv.base);
    const { client: viewer } = await addMember(admin,wid,'navigation@oriel.test','Lecteur','viewer');
    const team = await createPage(admin,wid,{title:'Production',visibility:'workspace'});
    const child = await createPage(admin,wid,{title:'Projet partagé',parentType:'page',parentId:team.id});
    const privatePage = await createPage(admin,wid,{title:'Notes privées',visibility:'private'});
    expectOk(await admin.patch(`/pages/${team.id}`,{format:{teamspaceRoot:true}}));
    expectOk(await admin.patch(`/pages/${child.id}`,{format:{teamspaceRoot:true,sharedShortcut:true}}));
    expectOk(await admin.patch(`/pages/${privatePage.id}`,{format:{teamspaceRoot:true,sharedShortcut:true}}));
    const own = expectOk(await admin.get<TreeResponse>(`/workspaces/${wid}/tree`)).nodes;
    assert.equal(own.find(n=>n.id===team.id)!.isTeamspace,true);
    assert.equal(own.find(n=>n.id===child.id)!.isTeamspace,undefined);
    assert.equal(own.find(n=>n.id===child.id)!.parentId,team.id);
    assert.equal(own.find(n=>n.id===child.id)!.isSharedShortcut,true);
    assert.equal(own.find(n=>n.id===privatePage.id)!.isTeamspace,undefined);
    const visible = expectOk(await viewer.get<TreeResponse>(`/workspaces/${wid}/tree`)).nodes;
    assert(!visible.some(n=>n.id===privatePage.id));
    assert.equal(visible.find(n=>n.id===child.id)!.parentId,team.id);
    assert.equal((await viewer.patch(`/pages/${team.id}`,{format:{teamspaceRoot:false}})).status,403);
  } finally { await srv.stop(); }
});
