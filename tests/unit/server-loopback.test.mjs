import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createServer} from 'node:http';
import {listenLoopback} from '../../server/index.mjs';
class Listener extends EventEmitter {
  constructor(failures){super();this.failures=failures;this.calls=[];}
  listen(port,host){this.calls.push({port,host});queueMicrotask(()=>{
    if(this.failures-->0)this.emit('error',Object.assign(Error('occupied'),{code:'EADDRINUSE'}));
    else this.emit('listening');
  });}
  address(){return {port:this.calls.at(-1).port};}
}
test('dynamic listener uses a real browser-safe localhost port',async()=>{
  const server=createServer((_,res)=>res.end('safe'));
  try{const port=await listenLoopback(server);assert.ok(port>=49152&&port<=65535);
    assert.equal(await fetch(`http://127.0.0.1:${port}`).then(r=>r.text()),'safe');}
  finally{await new Promise(done=>server.close(done));}
});
test('occupied ports retry within a bound and clean temporary listeners',async()=>{
  const server=new Listener(1);assert.equal(await listenLoopback(server,{pickPort:()=>50001}),50001);
  assert.equal(server.calls.length,2);assert.ok(server.calls.every(x=>x.host==='127.0.0.1'));
  assert.equal(server.listenerCount('error'),0);assert.equal(server.listenerCount('listening'),0);
});
test('exhausted port retries fail without an unbounded loop',async()=>{
  const server=new Listener(20);
  await assert.rejects(()=>listenLoopback(server,{pickPort:()=>50001,attempts:3}),{code:'EADDRINUSE'});
  assert.equal(server.calls.length,3);
});
test('unsafe candidate and invalid retry budget are rejected before bind',async()=>{
  const server=new Listener(0);
  await assert.rejects(()=>listenLoopback(server,{pickPort:()=>10080}),/safe loopback port/);
  await assert.rejects(()=>listenLoopback(server,{attempts:0}),/attempt limit/);
  assert.equal(server.calls.length,0);
});
