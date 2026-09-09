import QRCode from 'qrcode';
import { collectUsage, usage, type AppEnv } from './usage';
import { archive } from './zip';
type Photo={id:string;owner:string;nickname:string;name:string;size:number;thumb_size:number;crc32:number;format:string;created:string;status?:string};
type Totals={total:number;institutions:number;bytes:number;r2_bytes:number;revision:number};
class Failure extends Error { constructor(public status:number,message:string){super(message);} }
const fail=(status:number,message:string):never=>{throw new Failure(status,message);};
const json=(body:unknown,status=200,headers:HeadersInit={})=>Response.json(body,{status,headers});
const uuid=(s:unknown)=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(s);
async function hash(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');}
async function owner(req:Request){const id=req.headers.get('X-Visitor-Id');if(!uuid(id))fail(400,'이용자 정보를 새로고침해 주세요.');return hash(id!);}
async function token(req:Request){return hash(req.headers.get('cookie')?.match(/(?:^|;\s*)admin=([^;]*)/)?.[1]||'');}
async function admin(req:Request,env:AppEnv){const s=await env.DB.prepare('SELECT expires FROM sessions WHERE token=?').bind(await token(req)).first<{expires:number}>();if(!s||s.expires<Date.now())fail(401,'관리자 로그인이 필요합니다.');}
async function smallBody(req:Request){
 if(!req.body)return '';
 const reader=req.body.getReader(),chunks:Uint8Array[]=[];let count=0;
 for(;;){const r=await reader.read();if(r.done)break;count+=r.value.length;if(count>16384){await reader.cancel();fail(413,'요청 내용이 너무 큽니다.');}chunks.push(r.value);}
 const out=new Uint8Array(count);let at=0;for(const c of chunks){out.set(c,at);at+=c.length;}return new TextDecoder().decode(out);
}
async function body(req:Request){try{return JSON.parse(await smallBody(req));}catch(e){if(e instanceof Failure)throw e;return fail(400,'요청 형식이 잘못되었습니다.');}}
function filters(q:URLSearchParams,ownerId?:string){
 const conditions:string[]=[],args:(string|number)[]=[];
 if(ownerId){conditions.push('owner=?');args.push(ownerId);}
 const institution=q.get('institution')||q.get('nickname');if(institution){conditions.push('instr(lower(nickname),lower(?))>0');args.push(institution.slice(0,100));}
 const until=q.get('until');if(until&&Number.isFinite(Date.parse(until))){conditions.push('created<=?');args.push(new Date(until).toISOString());}
 for(const [value,end] of [[q.get('from')||q.get('date'),false],[q.get('to')||q.get('date'),true]] as const){if(value&&/^\d{4}-\d{2}-\d{2}$/.test(value)){const time=Date.parse(`${value}T00:00:00+09:00`);if(Number.isFinite(time)){conditions.push(end?'created<?':'created>=?');args.push(new Date(time+(end?86400000:0)).toISOString());}}}
 const ids=q.get('ids')?.split(',').filter(Boolean);if(ids?.length){if(ids.length>100||ids.some(id=>!uuid(id)))fail(400,'선택한 사진 정보가 잘못되었습니다.');conditions.push(`id IN (${ids.map(()=>'?').join(',')})`);args.push(...ids);}
 const orders:Record<string,string>={newest:'created DESC,id DESC',oldest:'created ASC,id ASC',institution:'nickname COLLATE NOCASE ASC,created DESC,id DESC','institution-desc':'nickname COLLATE NOCASE DESC,created DESC,id DESC'};
 return {where:conditions.length?'WHERE '+conditions.join(' AND '):'',args,order:orders[q.get('sort')||'']||orders.newest};
}
async function list(env:AppEnv,q:URLSearchParams,ownerId?:string){
 const overall=(await env.DB.prepare('SELECT * FROM totals WHERE id=1').first<Totals>())!;
 const {where,args,order}=filters(q,ownerId),requested=Math.max(1,Math.floor(Number(q.get('page'))||1));
 const key=await hash(JSON.stringify([where,args,order,requested]));
 const cached=await env.DB.prepare('SELECT body FROM list_cache WHERE key=? AND revision=? AND expires>?').bind(key,overall.revision,Date.now()).first<{body:string}>();
 let result;
 if(cached)result=JSON.parse(cached.body);
 else {
  const stats=where?await env.DB.prepare(`SELECT count(*) total,count(DISTINCT nickname) institutions,coalesce(sum(size),0) bytes FROM photos ${where}`).bind(...args).first():overall;
  const pages=Math.max(1,Math.ceil(Number(stats!.total)/60)),page=Math.min(pages,requested);
  const photos=await env.DB.prepare(`SELECT id,nickname,name,size,created FROM photos ${where} ORDER BY ${order} LIMIT 60 OFFSET ?`).bind(...args,(page-1)*60).all();
  result={photos:photos.results,total:stats!.total,institutions:stats!.institutions,bytes:stats!.bytes,page,pages,pageSize:60};
  await env.DB.prepare('INSERT INTO list_cache(key,revision,body,expires) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,body=excluded.body,expires=excluded.expires').bind(key,overall.revision,JSON.stringify(result),Date.now()+300000).run();
 }
 return ownerId?result:{...result,overall,usage:await usage(env,overall.r2_bytes)};
}
function imageFormat(bytes:Uint8Array){
 const text=new TextDecoder('latin1').decode(bytes);
 if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'jpeg';
 if(bytes[0]===137&&text.slice(1,4)==='PNG')return 'png';
 if(/^GIF8[79]a/.test(text))return 'gif';
 if(text.startsWith('RIFF')&&text.slice(8,12)==='WEBP')return 'webp';
 if(text.slice(4,8)==='ftyp'&&/avif|avis/.test(text.slice(8)))return 'avif';
 return null;
}
async function uploadPart(req:Request,env:AppEnv,p:Photo,thumb:boolean){
 const expected=thumb?p.thumb_size:p.size,key=thumb?`thumbs/${p.id}.jpg`:`originals/${p.id}`;
 if(p.status==='complete')return json({ok:true});
 if(Date.parse(p.created)<Date.now()-86400000)fail(410,'업로드 시간이 만료되었습니다. 파일을 다시 선택해주세요.');
 if(!req.body || Number(req.headers.get('content-length'))!==expected)fail(400,'사진 크기가 일치하지 않습니다. 다시 시도해주세요.');
 const prior=await env.PHOTOS.head(key);
 if(prior){if(prior.size!==expected)fail(409,'저장된 사진 크기가 다릅니다.');await req.body!.cancel();await env.DB.prepare('INSERT OR IGNORE INTO objects(key,size) VALUES(?,?)').bind(key,prior.size).run();return json({ok:true});}
 const reader=req.body!.getReader();const initial:Uint8Array[]=[];let length=0;
 while(length<32){const v=await reader.read();if(v.done)break;initial.push(v.value);length+=v.value.length;}
 const prefix=new Uint8Array(Math.min(length,64));let at=0;for(const v of initial){const take=v.subarray(0,prefix.length-at);prefix.set(take,at);at+=take.length;if(at===prefix.length)break;}
 const format=imageFormat(prefix);
 if(!format||(thumb&&format!=='jpeg')||(!thumb&&format!==p.format)){await reader.cancel();fail(415,'읽을 수 없는 사진입니다. JPG, PNG, WebP, GIF 또는 AVIF로 올려주세요.');}
 const stream=new FixedLengthStream(expected),writer=stream.writable.getWriter();
 const pump=(async()=>{try{for(const chunk of initial)await writer.write(chunk);for(;;){const r=await reader.read();if(r.done)break;await writer.write(r.value);}await writer.close();}catch(e){await writer.abort(e).catch(()=>{});throw e;}finally{await reader.cancel().catch(()=>{});}})();
 const put=env.PHOTOS.put(key,stream.readable,{httpMetadata:{contentType:`image/${format}`}}).catch(async e=>{await writer.abort(e).catch(()=>{});throw e;});
 const outcomes=await Promise.allSettled([pump,put]);
 const object=outcomes[1].status==='fulfilled'?outcomes[1].value:null;
 const existing=object;
 if(!existing||existing.size!==expected)fail(503,'사진을 저장하지 못했습니다. 재시도를 눌러주세요.');
 await env.DB.prepare('INSERT OR IGNORE INTO objects(key,size) VALUES(?,?)').bind(key,existing!.size).run();
 return json({ok:true});
}
async function route(req:Request,env:AppEnv,ctx:ExecutionContext):Promise<Response>{
 const url=new URL(req.url),path=url.pathname,method=req.method;
 if(path==='/healthz')return json({ok:true});
 if(!path.startsWith('/api/'))return env.ASSETS.fetch(path==='/admin'?new Request(new URL('/',url),req):req);
 if(!['GET','HEAD'].includes(method)&&req.headers.get('origin')&&req.headers.get('origin')!==url.origin)fail(403,'허용되지 않은 요청입니다.');
 if(path==='/api/config'&&method==='GET'){const link=url.origin+'/';return json({url:link,qr:'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(await QRCode.toString(link,{type:'svg',margin:2})),maxMB:30,uploadConcurrency:3,uploadMode:'r2-stream',zipParts:true});}
 if(path==='/api/admin/login'&&method==='POST'){
  if(!env.ADMIN_PASSWORD)fail(503,'관리자 비밀번호 설정이 필요합니다.');
  const key=await hash((req.headers.get('CF-Connecting-IP')||'local')+':'+Math.floor(Date.now()/900000));
  const attempts=await env.DB.prepare('INSERT INTO login_attempts(key,attempts,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1 RETURNING attempts').bind(key,Date.now()+900000).first<{attempts:number}>();
  if(attempts!.attempts>15)fail(429,'잠시 후 다시 시도해주세요.');
  const input=await body(req),a=await hash(typeof input.password==='string'?input.password:''),b=await hash(env.ADMIN_PASSWORD!);let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);if(diff)fail(401,'비밀번호를 확인해주세요.');
  const session=crypto.randomUUID()+crypto.randomUUID();await env.DB.prepare('INSERT INTO sessions(token,expires) VALUES(?,?)').bind(await hash(session),Date.now()+86400000).run();
  return json({ok:true},200,{'Set-Cookie':`admin=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${url.protocol==='https:'?'; Secure':''}`});
 }
 if(path==='/api/admin/logout'&&method==='POST'){await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(await token(req)).run();return json({ok:true},200,{'Set-Cookie':'admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});}
 if(path.startsWith('/api/admin/')){
  await admin(req,env);
  if(path==='/api/admin/session'&&method==='GET')return json({ok:true});
  if(path==='/api/admin/photos'&&method==='GET')return json(await list(env,url.searchParams));
  if((path==='/api/admin/download'||path==='/api/admin/download-plan')&&['GET','POST'].includes(method)){
   const q=method==='POST'?new URLSearchParams(await smallBody(req)):url.searchParams;
   const {where,args,order}=filters(q);
   const count=await env.DB.prepare(`SELECT count(*) total FROM photos ${where}`).bind(...args).first<{total:number}>();
   if(!count?.total)fail(404,'다운로드할 사진이 없습니다.');
   const parts=Math.ceil(count!.total/100),part=Math.min(parts,Math.max(1,Math.floor(Number(q.get('part'))||1)));
   if(path.endsWith('-plan'))return json({total:count!.total,parts});
   const entries=await env.DB.prepare(`SELECT * FROM photos ${where} ORDER BY ${order} LIMIT 100 OFFSET ?`).bind(...args,(part-1)*100).all<Photo>();
   return new Response(archive(entries.results,env.PHOTOS),{headers:{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="photos-${part}-of-${parts}.zip"`}});
  }
 }
 if(path==='/api/photos/mine'&&method==='GET')return json(await list(env,url.searchParams,await owner(req)));
 if(path==='/api/uploads'&&method==='POST'){
  const own=await owner(req),v=await body(req),name=String(v.institution||'').trim();
  if(!uuid(v.id)||!name||name.length>100||!Number.isInteger(v.size)||v.size<1||v.size>30*1048576||!Number.isInteger(v.thumbSize)||v.thumbSize<1||v.thumbSize>2*1048576||!Number.isInteger(v.crc32)||v.crc32<0||v.crc32>0xffffffff||!['jpeg','png','webp','gif','avif'].includes(v.format))fail(400,'사진 또는 의료기관명 정보가 잘못되었습니다.');
  const filename=String(v.name||'photo').replace(/[\\/\x00-\x1f]/g,'_').slice(0,200);
  await env.DB.prepare('INSERT OR IGNORE INTO uploads(id,owner,nickname,name,size,thumb_size,crc32,format,created) VALUES(?,?,?,?,?,?,?,?,?)').bind(v.id,own,name,filename,v.size,v.thumbSize,v.crc32,v.format,new Date().toISOString()).run();
  const p=await env.DB.prepare('SELECT * FROM uploads WHERE id=?').bind(v.id).first<Photo>();
  if(p!.owner!==own||p!.size!==v.size||p!.crc32!==v.crc32||p!.nickname!==name||p!.thumb_size!==v.thumbSize)fail(409,'업로드 정보가 변경되었습니다. 파일을 다시 선택해주세요.');return json({id:v.id,complete:p!.status==='complete'});
 }
 const upload=path.match(/^\/api\/uploads\/([a-f0-9-]{36})\/(original|thumb|complete)$/);
 if(upload){const own=await owner(req),p=await env.DB.prepare('SELECT * FROM uploads WHERE id=? AND owner=?').bind(upload[1],own).first<Photo>();if(!p)fail(404,'업로드 정보를 찾을 수 없습니다.');
  if(upload[2]!=='complete'&&method==='PUT')return uploadPart(req,env,p!,upload[2]==='thumb');
  if(upload[2]==='complete'&&method==='POST'){
   if(p!.status!=='complete'&&Date.parse(p!.created)<Date.now()-86400000)fail(410,'업로드 시간이 만료되었습니다. 파일을 다시 선택해주세요.');
   const receipt=await env.DB.prepare('SELECT count(*) n FROM objects WHERE (key=? AND size=?) OR (key=? AND size=?)').bind(`originals/${p!.id}`,p!.size,`thumbs/${p!.id}.jpg`,p!.thumb_size).first<{n:number}>();if(receipt?.n!==2)fail(409,'사진 업로드가 아직 완료되지 않았습니다.');
   await env.DB.batch([env.DB.prepare('INSERT OR IGNORE INTO photos(id,owner,nickname,name,size,thumb_size,crc32,format,created) SELECT id,owner,nickname,name,size,thumb_size,crc32,format,? FROM uploads WHERE id=?').bind(new Date().toISOString(),p!.id),env.DB.prepare("UPDATE uploads SET status='complete' WHERE id=?").bind(p!.id)]);
   return json({id:p!.id},201);
  }
 }
 const photo=path.match(/^\/api\/photos\/([a-f0-9-]{36})\/(original|thumb)$/);
 if(photo&&method==='GET'){
  const p=await env.DB.prepare('SELECT * FROM photos WHERE id=?').bind(photo[1]).first<Photo>();if(!p)fail(404,'사진을 찾을 수 없습니다.');
  if(await hash(req.headers.get('X-Visitor-Id')||'')!==p!.owner)await admin(req,env);
  const object=await env.PHOTOS.get(photo[2]==='thumb'?`thumbs/${p!.id}.jpg`:`originals/${p!.id}`);if(!object)fail(404,'사진을 찾을 수 없습니다.');
  const headers=new Headers();object!.writeHttpMetadata(headers);headers.set('Content-Length',String(object!.size));headers.set('ETag',object!.httpEtag);
  if(photo[2]==='original')headers.set('Content-Disposition',`attachment; filename="photo.${p!.format}"; filename*=UTF-8''${encodeURIComponent(p!.name).replace(/'/g,'%27')}`);
  return new Response(object!.body,{headers});
 }
 return fail(404,'요청한 주소를 찾을 수 없습니다.');
}
export async function maintenance(env:AppEnv){
 await collectUsage(env);
 const old=await env.DB.prepare("SELECT id FROM uploads WHERE status='pending' AND created<? LIMIT 20").bind(new Date(Date.now()-2*86400000).toISOString()).all<{id:string}>();
 for(const p of old.results){const keys=[`originals/${p.id}`,`thumbs/${p.id}.jpg`];await env.PHOTOS.delete(keys);await env.DB.batch([env.DB.prepare('DELETE FROM objects WHERE key IN (?,?)').bind(...keys),env.DB.prepare("DELETE FROM uploads WHERE id=? AND status='pending'").bind(p.id)]);}
 await env.DB.batch(['sessions','login_attempts','list_cache'].map(t=>env.DB.prepare(`DELETE FROM ${t} WHERE expires<?`).bind(Date.now())));
 await env.DB.prepare("DELETE FROM analytics_cache WHERE id LIKE 'r2-day:%' AND updated<?").bind(Date.now()-40*86400000).run();
}
export default {
 async fetch(req:Request,env:AppEnv,ctx:ExecutionContext){
  let res:Response;
  try{res=await route(req,env,ctx);}catch(e){const reference=crypto.randomUUID().slice(0,8);if(!(e instanceof Failure))console.error(JSON.stringify({event:'request_failed',reference,error:e instanceof Error?e.message:'unknown'}));res=json({error:e instanceof Failure?e.message:`서버 저장 오류입니다. 재시도해주세요. (${reference})`},e instanceof Failure?e.status:500);}
  const headers=new Headers(res.headers);headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','same-origin');headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  if(new URL(req.url).pathname.startsWith('/api/'))headers.set('Cache-Control','no-store');
  return new Response(res.body,{status:res.status,headers});
 },
 async scheduled(_event:ScheduledController,env:AppEnv,_ctx:ExecutionContext){await maintenance(env);}
} satisfies ExportedHandler<AppEnv>;
