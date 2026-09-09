async function cloudPhoto(q, institution) {
 if(!q.prepared) {
  q.status='사진 확인 중…';renderQueue();
  let bitmap;
  try { bitmap=await createImageBitmap(q.file); } catch { throw new Error('이 브라우저에서 읽을 수 없는 사진입니다. JPG로 저장한 뒤 업로드해주세요.'); }
  try {
   if(bitmap.width*bitmap.height>100000000)throw new Error('사진 해상도가 너무 큽니다. 1억 화소 이하로 올려주세요.');
   const scale=Math.min(1,900/bitmap.width,900/bitmap.height),canvas=document.createElement('canvas');
   canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
   canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
   const thumb=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.82));
   if(!thumb)throw new Error('미리보기를 만들지 못했습니다. 다시 시도해주세요.');
   const bytes=new Uint8Array(await q.file.arrayBuffer()),head=new TextDecoder('latin1').decode(bytes.subarray(0,64));
   const format=bytes[0]===255&&bytes[1]===216?'jpeg':bytes[0]===137&&head.slice(1,4)==='PNG'?'png':head.startsWith('GIF8')?'gif':head.startsWith('RIFF')&&head.slice(8,12)==='WEBP'?'webp':head.slice(4,8)==='ftyp'&&/avif|avis/.test(head.slice(8))?'avif':null;
   if(!format)throw new Error('JPG, PNG, WebP, GIF 또는 AVIF로 올려주세요.');
   const table=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;table[n]=c>>>0;}
   let crc=0xffffffff;for(let at=0;at<bytes.length;at+=1048576){const end=Math.min(bytes.length,at+1048576);for(let i=at;i<end;i++)crc=table[(crc^bytes[i])&255]^(crc>>>8);await new Promise(resolve=>setTimeout(resolve,0));}
   q.prepared={thumb,format,crc32:(crc^0xffffffff)>>>0};
  } finally { bitmap.close(); }
 }
 const p=q.prepared;
 const init=await api('/api/uploads',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:q.id,institution,name:q.file.name,size:q.file.size,thumbSize:p.thumb.size,format:p.format,crc32:p.crc32})});
 if(init.complete)return init;
 function put(kind,file) {return new Promise((resolve,reject)=>{
  const xhr=new XMLHttpRequest();xhr.open('PUT',`/api/uploads/${q.id}/${kind}`);xhr.setRequestHeader('X-Visitor-Id',visitor);xhr.timeout=180000;
  xhr.upload.onprogress=e=>{if(e.lengthComputable){q.progress=kind==='original'?Math.round(e.loaded/e.total*95):98;q.status=`올리는 중 ${q.progress}%`;renderQueue();}};
  xhr.onload=()=>{let body;try{body=JSON.parse(xhr.responseText);}catch{}if(xhr.status>=200&&xhr.status<300)resolve(body);else reject(new Error(body?.error||'업로드 실패. 재시도해주세요.'));};
  xhr.onerror=xhr.ontimeout=()=>reject(new Error('연결 오류. 재시도해주세요.'));xhr.send(file);
 });}
 await put('original',q.file);await put('thumb',p.thumb);
 return api(`/api/uploads/${q.id}/complete`,{method:'POST'});
}
function renderUsage(data) {
 const host=document.querySelector('#cloud-usage');if(!host)return;
 host.hidden=!data;if(!data)return;
 const value=(n,unit)=>unit==='bytes'?`${(n/1e9).toLocaleString('ko-KR',{maximumFractionDigits:3})} GB`:`${Math.round(n).toLocaleString('ko-KR')}${unit}`;
 const markup=`<h2>사용량 · 무료 한도</h2><div class="quota-grid">${data.metrics.map(m=>`<div class="quota-card ${esc(m.level)}" data-quota="${esc(m.id)}"><span>${esc(m.label)}</span><b>${m.used===null?esc(m.status):`${value(m.used,m.unit)} / ${value(m.limit,m.unit)}`}</b>${m.used===null?'':`<progress aria-label="${esc(m.label)} 사용률" max="100" value="${Math.min(100,m.percent)}"></progress><strong>${m.percent.toFixed(1)}% · ${m.level==='exceeded'?'한도 도달·초과':m.level==='warning'?'한도 임박':`남음 ${value(m.remaining,m.unit)}`}</strong>`}<small>${esc(m.scope)} · ${esc(m.period)}${m.used===null?'':` · ${esc(m.status)}`}</small><small>${m.updated?`마지막 집계 ${new Date(m.updated).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})}`:'아직 집계되지 않음'}</small>${m.used===null?`<small>무료 한도 ${value(m.limit,m.unit)}</small>`:''}</div>`).join('')}</div><p class="help">${esc(data.note)}</p>`;
 if(host.innerHTML!==markup)host.innerHTML=markup;
}
async function cloudDownload() {
 try {
  const q=new URLSearchParams(adminFilters);if(selected.size)q.set('ids',[...selected].join(','));q.set('until',new Date().toISOString());
  const plan=await api('/api/admin/download-plan?'+q);
  const download=part=>{const params=new URLSearchParams(q);params.set('part',part);const a=document.createElement('a');a.href='/api/admin/download?'+params;a.download='';a.click();};
  if(plan.parts===1)return download(1);
  let dialog=document.querySelector('#zip-parts');if(dialog)dialog.remove();dialog=document.createElement('dialog');dialog.id='zip-parts';
  dialog.innerHTML=`<button class="close" aria-label="닫기">×</button><h2>ZIP 다운로드</h2><p>${plan.total.toLocaleString('ko-KR')}장 · 100장씩 ${plan.parts}개 파일</p><div class="zip-parts">${Array.from({length:plan.parts},(_,i)=>`<button class="secondary" data-part="${i+1}">${i+1} / ${plan.parts} 다운로드</button>`).join('')}</div>`;
  document.body.append(dialog);dialog.querySelector('.close').onclick=()=>dialog.close();dialog.querySelectorAll('[data-part]').forEach(b=>b.onclick=()=>download(b.dataset.part));dialog.showModal();
 } catch(e){toast(e.message);}
}
