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
function usageConnectionHelp() {
 return `<details id="usage-connection-help" class="connection-help"><summary>R2·D1 / 사용량 통계 연결 방법</summary>
 <p>사진 저장용 연결과 사용량 통계 조회 권한은 별개입니다. 사진이 정상 업로드된다면 저장소를 새로 만들 필요가 없습니다.</p>
 <ol>
 <li><b>사진 저장용 R2·D1 연결 확인</b><p>Cloudflare 대시보드 → Workers &amp; Pages → tissue-uploader → Bindings에서 확인합니다.</p><p><code>PHOTOS</code> → R2 버킷 <code>tissue-uploader-photos</code><br><code>DB</code> → D1 데이터베이스 <code>tissue-uploader</code></p><p>R2 공개 접근은 비활성으로 유지합니다. 현재 운영 환경은 저장소 연결과 D1 테이블 초기화가 완료된 상태입니다.</p></li>
 <li><b>요청량 통계 연결</b><p><a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener noreferrer">Cloudflare API 토큰 만들기 ↗</a>에서 Custom Token을 만들고, 해당 계정의 <code>Account → Account Analytics → Read</code> 권한을 선택합니다.</p><p>Worker → Settings → Variables and Secrets에서 유형 <code>Secret</code>, 이름 <code>CF_ANALYTICS_TOKEN</code>, 값에 발급받은 토큰을 넣고 저장·배포합니다. Build 설정의 비밀값이 아니라 <b>Worker 실행용 Secret</b>에 넣습니다.</p></li>
 <li><b>R2 청구 주기 설정</b><p>Cloudflare Billing에서 청구 기간 시작 시각을 확인합니다. GitHub의 <code>wrangler.jsonc</code> → <code>vars</code> → <code>R2_BILLING_ANCHOR</code>에 UTC 시각을 입력하고 커밋·배포합니다.</p><p>예: 매월 15일 한국 시간 오전 9시에 시작하면 <code>2026-09-15T00:00:00Z</code>. 예시를 그대로 쓰지 말고 실제 청구 기간에 맞춥니다. 대시보드의 변수만 수정하면 다음 GitHub 배포 때 덮어써질 수 있습니다.</p></li>
 </ol><p>설정 후 다음 15분 수집 주기가 지난 뒤 이 화면의 <b>새로고침</b>을 누릅니다. 미연결은 토큰 설정, 청구 주기 미설정은 시작 시각, 조회 실패는 토큰 권한·만료 상태를 확인하세요. Cloudflare 집계가 늦으면 표시도 지연될 수 있습니다.</p>
 <p>토큰은 GitHub 코드나 이 페이지에 붙여넣지 않습니다.</p></details>`;
}
function renderUsage(data) {
 const host=document.querySelector('#cloud-usage');if(!host)return;
 host.hidden=!data;if(!data)return;
 const value=(n,unit)=>unit==='bytes'?`${(n/1e9).toLocaleString('ko-KR',{maximumFractionDigits:3})} GB`:`${Math.round(n).toLocaleString('ko-KR')}${unit}`;
 const markup=`<h2>사용량 · 무료 한도</h2><div class="quota-grid">${data.metrics.map(m=>`<div class="quota-card ${esc(m.level)}" data-quota="${esc(m.id)}"><span>${esc(m.label)}</span><b>${m.used===null?esc(m.status):`${value(m.used,m.unit)} / ${value(m.limit,m.unit)}`}</b>${m.used===null?'':`<progress aria-label="${esc(m.label)} 사용률" max="100" value="${Math.min(100,m.percent)}"></progress><strong>${m.percent.toFixed(1)}% · ${m.level==='exceeded'?'한도 도달·초과':m.level==='warning'?'한도 임박':`남음 ${value(m.remaining,m.unit)}`}</strong>`}<small>${esc(m.scope)} · ${esc(m.period)}${m.used===null?'':` · ${esc(m.status)}`}</small><small>${m.updated?`마지막 집계 ${new Date(m.updated).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})}`:'아직 집계되지 않음'}</small>${m.used===null?`<small>무료 한도 ${value(m.limit,m.unit)}</small>`:''}</div>`).join('')}</div><p class="help">${esc(data.note)}</p>`;
 const expanded=host.querySelector('#usage-connection-help')?.open;
 const withHelp=markup+usageConnectionHelp();
 if(host.innerHTML!==withHelp){host.innerHTML=withHelp;if(expanded)host.querySelector('#usage-connection-help').open=true;}
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
