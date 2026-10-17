// Build locally installed, tested runtimes into one Windows EXE. Never package user data.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const {sourceFiles,runtimeMetadata}=require('./bundle-policy.cjs');
const root=path.resolve(__dirname,'..'),work=path.join(root,'.bro','build');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const quote=s=>"'"+s.replace(/'/g,"''")+"'";
const report={phase:'PREFLIGHT',startedUtc:new Date().toISOString(),userDataIncluded:false};
function save(){fs.mkdirSync(work,{recursive:true});fs.writeFileSync(path.join(work,'standalone-status.json'),JSON.stringify(report,null,2));}
function run(file,args,timeout=30000){
  const r=cp.spawnSync(file,args,{env:{...process.env,DOTNET_CLI_TELEMETRY_OPTOUT:'1',DOTNET_NOLOGO:'1',DOTNET_SKIP_FIRST_TIME_EXPERIENCE:'1'},cwd:root,windowsHide:true,encoding:'utf8',timeout,maxBuffer:16*1024*1024});
  fs.appendFileSync(path.join(work,'standalone-build.log'),(r.stdout||'')+'\n'+(r.stderr||''));
  if(r.error||r.status!==0)throw Error('Build command failed: '+path.basename(file)+'; '+(r.error?.code||r.status));
  return r.stdout.trim();
}
function copy(src,dest){fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(src,dest,fs.constants.COPYFILE_EXCL);}
function existing(paths){return paths.find(p=>p&&fs.existsSync(p));}
async function publicAsset(url,dest,limit){
  const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(60000)});
  if(!r.ok)throw Error('Public source unavailable: HTTP '+r.status);
  const parts=[];let bytes=0;
  for await(const b of r.body){bytes+=b.length;if(bytes>limit)throw Error('Public source size limit');parts.push(b);}
  const raw=Buffer.concat(parts);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,raw,{flag:'wx'});return sha(raw);
}
async function licenses(stage,ahk,ahkVersion){
  const dir=path.join(stage,'licenses');fs.mkdirSync(dir,{recursive:true});
  copy(path.join(root,'LICENSE'),path.join(dir,'CallMyPromts-MIT.txt'));
  await publicAsset(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`,path.join(dir,'Node-LICENSE.txt'),2000000);
  const a=existing([path.join(path.dirname(ahk),'license.txt'),path.join(path.dirname(ahk),'..','license.txt'),path.join(path.dirname(ahk),'..','License.txt')]);
  if(!a)throw Error('AutoHotkey license not found; release is blocked');
  copy(a,path.join(dir,'AutoHotkey-GPL.txt'));
  const dotnet=path.join(process.env.ProgramFiles||'C:/Program Files','dotnet');
  for(const [names,dest]of [[['LICENSE.txt','LICENSE.TXT'],'Dotnet-LICENSE.txt'],[['ThirdPartyNotices.txt','ThirdPartyNotices.TXT'],'Dotnet-NOTICES.txt']]){
    const f=existing(names.map(n=>path.join(dotnet,n)));if(!f)throw Error('Missing .NET redistribution notices');copy(f,path.join(dir,dest));
  }
  return `https://codeload.github.com/AutoHotkey/AutoHotkey/zip/refs/tags/v${ahkVersion}`;
}
function payload(stage,meta){
  const manifest={};
  function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('Linked payload');if(e.isDirectory())walk(p);else manifest[path.relative(stage,p).replaceAll('\\','/')]=sha(fs.readFileSync(p));}}
  walk(stage);fs.writeFileSync(path.join(meta,'manifest.json'),JSON.stringify(manifest));
  const zip=path.join(meta,'payload.zip');
  const ps='Add-Type -AssemblyName System.IO.Compression.FileSystem;[IO.Compression.ZipFile]::CreateFromDirectory('+quote(stage)+','+quote(zip)+',[IO.Compression.CompressionLevel]::Optimal,$false)';
  run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(ps,'utf16le').toString('base64')],120000);
  fs.writeFileSync(path.join(meta,'payload.sha256'),sha(fs.readFileSync(zip))+'\n');
  return manifest;
}
async function main(){
  if(process.platform!=='win32')throw Error('Windows build host required');save();
  const meta=path.join(__dirname,'.payload');if(fs.existsSync(meta))throw Error('Previous build payload exists; inspect its outcome before rebuilding');
  const stage=path.join(work,'standalone-'+crypto.randomUUID());fs.mkdirSync(stage,{recursive:true});fs.mkdirSync(meta);
  for(const file of sourceFiles(root))copy(path.join(root,file),path.join(stage,file));
  const ahk=existing([process.env.DECK_AHK,'C:/Program Files/AutoHotkey/v2/AutoHotkey64.exe']);if(!ahk)throw Error('AutoHotkey v2 unavailable');
  const versionScript='(Get-Item '+quote(ahk)+').VersionInfo.FileVersion';
  const version=run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(versionScript,'utf16le').toString('base64')]);
  const match=version.match(/^(2\.\d+\.\d+)/);if(!match)throw Error('Expected AutoHotkey v2');
  copy(process.execPath,path.join(stage,'vendor','node.exe'));copy(ahk,path.join(stage,'vendor','AutoHotkey64.exe'));
  const productVersion=fs.readFileSync(path.join(__dirname,'CallMyPromts.csproj'),'utf8').match(/<Version>([^<]+)<\/Version>/)?.[1];
  const sourceHashes=Object.fromEntries(sourceFiles(root).map(file=>[file,sha(fs.readFileSync(path.join(root,file)))]));
  const metadata=runtimeMetadata(productVersion,sourceHashes);
  fs.writeFileSync(path.join(stage,'package.json'),JSON.stringify(metadata.package)+'\n',{flag:'wx'});
  fs.writeFileSync(path.join(stage,'.release-id'),metadata.releaseId+'\n',{flag:'wx'});
  const sourceUrl=await licenses(stage,ahk,match[1]);
  const manifest=payload(stage,meta),id=sha(Buffer.concat([Buffer.from(JSON.stringify(manifest)),fs.readFileSync(path.join(__dirname,'Program.cs')),fs.readFileSync(path.join(__dirname,'CallMyPromts.csproj'))])).slice(0,16),out=path.join(root,'dist','standalone',id);
  fs.mkdirSync(out,{recursive:true});report.phase='PUBLISHING';report.outputDirectory=path.relative(root,out);save();
  run('dotnet.exe',['publish','packaging/CallMyPromts.csproj','-c','Release','-r','win-x64','--self-contained','true','-o',out],600000);
  const exe=path.join(out,'CallMyPromts.exe');const selfTest=run(exe,['--self-test'],60000);const proof=JSON.parse(selfTest);if(proof.ok!==true)throw Error('Embedded payload self-test failed');
  const source=path.join(out,'AutoHotkey-source-v'+match[1]+'.zip');const sourceSha=await publicAsset(sourceUrl,source,50000000);
  fs.writeFileSync(path.join(out,'THIRD-PARTY-NOTICES.md'),'Bundled Node '+process.versions.node+', AutoHotkey '+match[1]+', and Microsoft .NET 8. License texts are embedded in licenses/. Corresponding AutoHotkey source is distributed alongside the EXE: '+path.basename(source)+'.\n');
  const exeSha=sha(fs.readFileSync(exe));fs.writeFileSync(path.join(out,'SHA256SUMS'),exeSha+'  CallMyPromts.exe\n'+sourceSha+'  '+path.basename(source)+'\n');
  report.phase='BUILT_SELF_TESTED';report.finishedUtc=new Date().toISOString();report.exeSha256=exeSha;report.ahkVersion=match[1];report.nodeVersion=process.versions.node;report.selfTest=proof;report.nativeAcceptance=false;save();console.log(JSON.stringify(report));
}
main().catch(e=>{report.phase='FAILED';report.error=e.message;save();console.error(e.message);process.exitCode=1;});
