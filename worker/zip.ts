type Entry = { id:string; nickname:string; name:string; size:number; crc32:number; created:string };
// Stored ZIP: CRCs are calculated by the uploading browser. No image buffering or
// compression/CRC work on the Worker. A part has <=100 files and stays below 4 GiB.
export function archive(entries: Entry[], bucket: R2Bucket) {
 const encoder = new TextEncoder();
 function header(p: Entry, name: Uint8Array, central: boolean, offset: number) {
  const out = new Uint8Array((central ? 46 : 30)+name.length), view = new DataView(out.buffer);
  view.setUint32(0,central?0x02014b50:0x04034b50,true);
  let b = 4;
  if (central) { view.setUint16(4,20,true); b=6; }
  view.setUint16(b,20,true); view.setUint16(b+2,0x800,true);
  const d=new Date(p.created), year=Math.max(1980,d.getUTCFullYear());
  view.setUint16(b+6,(d.getUTCHours()<<11)|(d.getUTCMinutes()<<5)|(d.getUTCSeconds()>>1),true);
  view.setUint16(b+8,((year-1980)<<9)|((d.getUTCMonth()+1)<<5)|d.getUTCDate(),true);
  view.setUint32(b+10,p.crc32,true); view.setUint32(b+14,p.size,true); view.setUint32(b+18,p.size,true); view.setUint16(b+22,name.length,true);
  if(central)view.setUint32(42,offset,true);
  out.set(name,central?46:30); return out;
 }
 async function* chunks() {
  const central:Uint8Array[]=[]; let offset=0;
  for(const p of entries) {
   const object=await bucket.get(`originals/${p.id}`);
   if(!object || object.size!==p.size)throw new Error('archive_object_missing');
   const safe=(s:string)=>s.replace(/[\\/\x00-\x1f]/g,'_').replace(/^\.+$/,'_');
   const name=encoder.encode(`${safe(p.nickname)}/${p.created.slice(0,10)}_${p.id.slice(0,8)}_${safe(p.name)}`);
   const local=header(p,name,false,0); central.push(header(p,name,true,offset)); yield local;
   const reader=object.body.getReader();
   try { for(;;){const value=await reader.read();if(value.done)break;yield value.value;} }
   finally { await reader.cancel(); }
   offset+=local.length+p.size;
  }
  let length=0;for(const part of central){yield part;length+=part.length;}
  const end=new Uint8Array(22),v=new DataView(end.buffer);v.setUint32(0,0x06054b50,true);v.setUint16(8,entries.length,true);v.setUint16(10,entries.length,true);v.setUint32(12,length,true);v.setUint32(16,offset,true);yield end;
 }
 const iterator=chunks();
 return new ReadableStream<Uint8Array>({async pull(c){try{const item=await iterator.next();if(item.done)c.close();else c.enqueue(item.value);}catch(e){c.error(e);}},async cancel(){await iterator.return(undefined);}});
}
