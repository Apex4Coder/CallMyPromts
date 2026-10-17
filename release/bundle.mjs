// Runtime allowlist: user state, personal prompts, archives and task logs never enter a release.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const RUNTIME_DIRS=['server','bridge','contracts','library','rank','clipboard','ui'];
export function sourceFiles(root){
  const files=[];
  function walk(dir){
    if(fs.lstatSync(path.join(root,dir)).isSymbolicLink())throw Error('Linked runtime source: '+dir);
    for(const e of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){
      const rel=dir+'/'+e.name;
      if(e.isSymbolicLink())throw Error('Linked runtime source: '+rel);
      if(e.isDirectory())walk(rel);
      else if(/\.(?:mjs|js|cjs|css|html|ahk|svg|png|ico|woff2?)$/i.test(e.name))files.push(rel);
      else throw Error('Unexpected runtime asset: '+rel);
    }
  }
  for(const dir of RUNTIME_DIRS)walk(dir);
  const starter='packaging/portable-start.cjs';
  if(!fs.lstatSync(path.join(root,starter)).isFile())throw Error('Invalid standalone entrypoint');
  files.push(starter);
  return files.sort();
}

// Generated release metadata, not the development package or user configuration.
export function runtimeMetadata(version, sourceHashes) {
  if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Invalid runtime version');
  const entries=Object.entries(sourceHashes).sort(([a],[b])=>a.localeCompare(b));
  if(!entries.length||entries.some(([,h])=>!/^[a-f0-9]{64}$/.test(h)))throw Error('Invalid source manifest');
  const id=createHash('sha256').update(JSON.stringify({version,files:entries})).digest('hex').slice(0,20);
  return {package:{name:'call-my-prompts',version,private:true,type:'module',engines:{node:'>=24'}},releaseId:'paper-w2-'+id};
}
