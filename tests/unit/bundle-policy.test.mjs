import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as policy from '../../release/index.mjs';
function fixture(fn){
  const root=mkdtempSync(join(tmpdir(),'paper-package-'));
  try{
    for(const dir of [...policy.RUNTIME_DIRS,'packaging','state','prompts','.bro'])mkdirSync(join(root,dir));
    writeFileSync(join(root,'server','index.mjs'),'// fixture');
    writeFileSync(join(root,'packaging','portable-start.cjs'),'// fixture');
    return fn(root);
  }finally{rmSync(root,{recursive:true,force:true});}
}
test('standalone includes only runtime allowlist, never personal files',()=>fixture(root=>{
  for(const dir of ['state','prompts','.bro'])writeFileSync(join(root,dir,'personal.mjs'),'PRIVATE');
  assert.deepEqual(policy.sourceFiles(root),['packaging/portable-start.cjs','server/index.mjs']);
}));
test('standalone rejects unknown assets in runtime sources',()=>fixture(root=>{
  writeFileSync(join(root,'server','secret.json'),'{}');
  assert.throws(()=>policy.sourceFiles(root),/Unexpected runtime asset/);
}));
test('standalone rejects linked source files',t=>fixture(root=>{
  try{symlinkSync(join(root,'server','index.mjs'),join(root,'server','linked.mjs'));}
  catch(error){if(error.code==='EPERM'){t.skip('Windows account cannot create test symlink');return;}throw error;}
  assert.throws(()=>policy.sourceFiles(root),/Linked runtime source/);
}));

test('runtime metadata has stable code identity and no development dependencies',()=>{
  const a=policy.runtimeMetadata('1.1.0',{'ui/app.js':'a'.repeat(64),'server/index.mjs':'b'.repeat(64)});
  const b=policy.runtimeMetadata('1.1.0',{'server/index.mjs':'b'.repeat(64),'ui/app.js':'a'.repeat(64)});
  assert.deepEqual(a,b);assert.equal(a.package.version,'1.1.0');assert.equal(a.package.type,'module');
  assert.equal('devDependencies' in a.package,false);assert.match(a.releaseId,/^paper-w2-[a-f0-9]{20}$/);
  assert.notEqual(a.releaseId,policy.runtimeMetadata('1.1.1',{'ui/app.js':'a'.repeat(64)}).releaseId);
});
test('runtime metadata rejects unknown versions and missing source hashes',()=>{
  assert.throws(()=>policy.runtimeMetadata('unknown',{'x':'a'.repeat(64)}),/Invalid runtime version/);
  assert.throws(()=>policy.runtimeMetadata('1.1.0',{}),/Invalid source manifest/);
  assert.throws(()=>policy.runtimeMetadata('1.1.0',{'x':'not-a-hash'}),/Invalid source manifest/);
});
