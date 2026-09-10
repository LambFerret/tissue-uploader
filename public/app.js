const $ = (selector) => document.querySelector(selector);
const app = $('#app');
const isAdmin = location.pathname.startsWith('/admin');
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const storage = { get(key) { try { return localStorage.getItem(key); } catch { return null; } }, set(key, value) { try { localStorage.setItem(key, value); } catch {} } };
const uuid = () => '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (Number(c) ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> Number(c) / 4).toString(16));
const visitor = storage.get('moa-visitor') || uuid(); storage.set('moa-visitor', visitor);
const runtimeConfig = api('/api/config').catch(() => ({ uploadConcurrency: 2 }));
let nickname = storage.get('tissue-institution') || storage.get('moa-nickname') || '', queue = [], busy = false, photos = [], selected = new Set(), objectUrls = [], galleryVersion = 0;
const date = value => new Intl.DateTimeFormat('ko-KR', { timeZone:'Asia/Seoul', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }).format(new Date(value));
const size = bytes => bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(1)} GB` : bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
function toast(message) { $('#toast').textContent = message; $('#toast').style.display = 'block'; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').style.display = 'none', 3500); }
async function api(url, options = {}) { const res = await fetch(url, { ...options, headers: { 'X-Visitor-Id': visitor, ...options.headers } }); if (!res.ok) { const body = await res.json().catch(() => ({})); const error = new Error(body.error || '요청을 처리하지 못했습니다. 다시 시도해 주세요.'); error.status = res.status; throw error; } return res.json(); }
document.querySelectorAll('dialog .close').forEach(button => button.onclick = () => button.closest('dialog').close());
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } }));
async function share() { try { const config = await api('/api/config'); $('#qr').src = config.qr; $('#share-url').value = config.url; $('#share-dialog').showModal(); } catch (e) { toast(e.message); } }
$('#copy-link').onclick = async () => { try { await navigator.clipboard.writeText($('#share-url').value); toast('링크 복사 완료'); } catch { $('#share-url').select(); toast('링크를 길게 누르거나 Ctrl+C로 복사해 주세요.'); } };
function uploader() {
 app.classList.add('upload-page');
 app.innerHTML = `<header class="upload-intro"><img class="company-logo" src="/cowellmedi-logo.png" alt="코웰메디" width="1241" height="281"><h1>조직이식결과서를 업로드해주세요.</h1><p class="upload-notice">코웰메디 조직은행 제품에 해당하는 조직이식결과서만 업로드해 주세요.</p></header><div class="nickname-row"><input id="nickname" aria-label="의료기관명" maxlength="100" placeholder="의료기관명 (예: XX치과)" value="${esc(nickname)}"><button class="secondary" id="save-name">저장</button></div><span id="name-help" hidden></span><div class="dropzone" id="dropzone"><div class="pick-actions"><button class="primary" id="choose">파일 선택</button><button class="secondary" id="camera">촬영</button></div></div><input type="file" accept="image/*" multiple id="files" hidden><input type="file" accept="image/*" capture="environment" id="camera-files" hidden><div id="queue" class="queue" aria-live="polite"></div><div class="upload-bottom"><span id="queue-summary"></span><button class="primary" id="upload" disabled>업로드</button></div><section class="my-photos" hidden><div class="section-heading"><span id="my-count" hidden></span><button class="secondary" id="refresh">새로고침</button></div><div id="gallery" class="gallery"></div><div id="empty"></div><div id="pagination" class="pagination" hidden></div></section>`;
 $('#save-name').onclick = saveName;
 $('#nickname').addEventListener('change', saveName);
 $('#refresh').onclick = () => loadMine();
 $('#choose').onclick = () => $('#files').click(); $('#camera').onclick = () => $('#camera-files').click();
 for (const input of [$('#files'), $('#camera-files')]) input.onchange = () => { addFiles(input.files); input.value = ''; };
 const zone = $('#dropzone');
 for (const event of ['dragenter','dragover']) zone.addEventListener(event, e => { e.preventDefault(); zone.classList.add('drag'); });
 for (const event of ['dragleave','drop']) zone.addEventListener(event, e => { e.preventDefault(); zone.classList.remove('drag'); });
 zone.addEventListener('drop', e => addFiles(e.dataTransfer.files)); $('#upload').onclick = uploadAll; loadMine();
}
function saveName() { nickname = $('#nickname').value.trim(); storage.set('tissue-institution', nickname); $('#name-help').textContent = nickname ? '저장 완료' : '의료기관명을 입력해주세요.'; }
function addFiles(files) { if (busy) return toast('업로드 중입니다.'); queue = queue.filter(q => { if(q.status === '완료') { URL.revokeObjectURL(q.url); return false; } return true; }); for (const file of files) { if (file.size > 30 * 1048576) { toast(`${file.name}: 30MB 초과`); continue; } if (!file.type.startsWith('image/') && !/\.(heic|heif|avif)$/i.test(file.name)) { toast(`${file.name}: 사진 파일을 선택해 주세요.`); continue; } if (queue.some(q => q.file.name === file.name && q.file.size === file.size && q.file.lastModified === file.lastModified)) continue; queue.push({ id:uuid(), file, url:URL.createObjectURL(file), status:'대기 중', progress:0 }); } renderQueue(); }
function renderQueue() { $('#queue').innerHTML = queue.map(q => `<div class="queue-item"><img src="${q.url}" alt="선택한 사진"><div class="queue-info"><b>${esc(q.file.name)}</b><small class="${q.error ? 'error' : ''}">${size(q.file.size)} · ${esc(q.status)}</small><progress max="100" value="${q.progress}" aria-label="업로드 진행률"></progress></div>${!busy ? `<button class="remove" data-remove="${q.id}" aria-label="${esc(q.file.name)} 목록에서 제거">×</button>` : ''}</div>`).join(''); $('#queue-summary').textContent = queue.length ? `${queue.length}장 선택 · ${size(queue.reduce((sum,q) => sum+q.file.size,0))}` : ''; $('#upload').disabled = busy || !queue.some(q => q.status !== '완료'); $('#upload').textContent = busy ? '업로드 중…' : queue.some(q => q.error) ? '재시도' : '업로드'; document.querySelectorAll('[data-remove]').forEach(b => b.onclick = () => { const q = queue.find(q => q.id === b.dataset.remove); URL.revokeObjectURL(q.url); queue = queue.filter(q => q.id !== b.dataset.remove); renderQueue(); }); }
function sendPhoto(q, name) { return new Promise((resolve, reject) => { const xhr = new XMLHttpRequest(); xhr.open('POST','/api/photos'); xhr.setRequestHeader('X-Visitor-Id', visitor); xhr.timeout = 180000; xhr.upload.onprogress = e => { if (e.lengthComputable) { q.progress = Math.round(e.loaded/e.total*100); q.status = q.progress === 100 ? '사진 처리 중…' : `올리는 중 ${q.progress}%`; renderQueue(); } }; xhr.onload = () => { let data; try { data = JSON.parse(xhr.responseText); } catch {} if (xhr.status >= 200 && xhr.status < 300) resolve(data); else reject(new Error(data?.error || '업로드 실패. 다시 시도해 주세요.')); }; xhr.onerror = xhr.ontimeout = () => reject(new Error('연결 오류. 다시 시도해주세요.')); const form = new FormData(); form.append('institution', name); form.append('name', q.file.name); form.append('requestId', q.id); form.append('photo', q.file); xhr.send(form); }); }
async function uploadAll() { saveName(); if (!nickname) { $('#nickname').focus(); return toast('의료기관명을 입력해주세요.'); } const uploadName = nickname; busy = true; renderQueue(); let cursor = 0; const pending = queue.filter(q => q.status !== '완료'); const config = await runtimeConfig; const concurrency = Math.min(3, Math.max(1, Number(config.uploadConcurrency) || 2)); await Promise.all(Array.from({length:Math.min(concurrency,pending.length)}, async () => { while (cursor < pending.length) { const q = pending[cursor++]; q.error = false; try { await (config.uploadMode === "r2-stream" ? cloudPhoto(q, uploadName) : sendPhoto(q, uploadName)); q.status = '완료'; q.progress = 100; } catch (e) { q.status = e.message; q.error = true; } renderQueue(); } })); busy = false; renderQueue(); toast(pending.some(q => q.error) ? '일부 업로드 실패' : `${pending.length}개 업로드 완료`); await loadMine(); $('#choose').textContent = '더 업로드하기'; }
window.addEventListener('beforeunload', e => { if (busy) { e.preventDefault(); e.returnValue = ''; } });
let mineRequest = 0;
function pagination(result, onPage) {
 const container = $('#pagination');
 container.hidden = result.pages <= 1;
 container.innerHTML = '<button class="secondary" id="previous-page">이전</button><span>' + result.page + ' / ' + result.pages + '</span><button class="secondary" id="next-page">다음</button>';
 $('#previous-page').disabled = result.page <= 1;
 $('#next-page').disabled = result.page >= result.pages;
 $('#previous-page').onclick = () => onPage(result.page-1);
 $('#next-page').onclick = () => onPage(result.page+1);
}
async function loadMine(page = 1) {
 const request = ++mineRequest;
 try {
  const result = await api('/api/photos/mine?page='+page);
  if (request !== mineRequest) return;
  photos = result.photos; $('#my-count').textContent = result.total; $('.my-photos').hidden = result.total === 0;
  pagination(result, loadMine); await renderGallery(false);
 } catch (e) { toast(e.message); }
}
async function renderGallery(adminMode) { const version = ++galleryVersion; objectUrls.forEach(URL.revokeObjectURL); objectUrls = []; $('#empty').hidden = photos.length > 0; $('#gallery').innerHTML = photos.map(p => `<article class="photo-card">${adminMode ? `<input type="checkbox" data-select="${p.id}" aria-label="${esc(p.name)} 선택" ${selected.has(p.id) ? 'checked' : ''}>` : ''}<button class="photo-open" data-open="${p.id}" aria-label="${esc(p.name)} 크게 보기"><img ${adminMode ? `src="/api/photos/${p.id}/thumb"` : ''} data-photo="${p.id}" alt="${esc(p.name)}" loading="lazy"></button><div class="photo-meta"><b>${esc(p.nickname)}</b><p>${date(p.created)} · ${size(p.size)}</p></div></article>`).join(''); document.querySelectorAll('[data-select]').forEach(c => c.onchange = () => { c.checked ? selected.add(c.dataset.select) : selected.delete(c.dataset.select); updateSelection(); }); document.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openPhoto(b.dataset.open, adminMode)); if (!adminMode) { let index = 0; const items = [...photos]; await Promise.all(Array.from({length:Math.min(4,items.length)}, async () => { while(index < items.length && version === galleryVersion) { const p = items[index++]; try { const response = await fetch(`/api/photos/${p.id}/thumb`, { headers:{'X-Visitor-Id':visitor} }); if (!response.ok) continue; const blob = await response.blob(); if (version !== galleryVersion) return; const url = URL.createObjectURL(blob); objectUrls.push(url); const img = document.querySelector(`[data-photo="${p.id}"]`); if (img) img.src = url; } catch {} } })); } }
async function openPhoto(id, adminMode) { const p = photos.find(p => p.id === id); $('#viewer-image').src = document.querySelector(`[data-photo="${id}"]`).src; $('#viewer-caption').textContent = `${p.nickname} · ${date(p.created)} · ${p.name}`; $('#viewer-download').href = `/api/photos/${id}/original`; $('#viewer-download').onclick = adminMode ? null : async e => { e.preventDefault(); try { const res = await fetch(`/api/photos/${id}/original`, { headers:{'X-Visitor-Id':visitor} }); if (!res.ok) throw new Error('다운로드에 실패했습니다.'); const url = URL.createObjectURL(await res.blob()); const a = document.createElement('a'); a.href=url; a.download=p.name; a.click(); setTimeout(() => URL.revokeObjectURL(url),60000); } catch(e) { toast(e.message); } }; $('#viewer').showModal(); }
async function adminInit() { app.classList.remove('upload-page'); try { await api('/api/admin/session'); adminPage(); } catch { loginPage(); } }
function loginPage() { stopAdminRefresh(); ++adminRequest; app.innerHTML = `<section class="panel login"><h2>관리자 로그인</h2><form id="login"><input type="password" id="password" autocomplete="current-password" placeholder="관리자 비밀번호" aria-label="관리자 비밀번호" required><button class="primary">로그인</button><p class="error" id="login-error" role="alert"></p></form></section>`; $('#login').onsubmit = async e => { e.preventDefault(); try { await api('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('#password').value})}); adminPage(); } catch (e) { $('#login-error').textContent=e.message; } }; }
function adminPage() { startAdminRefresh(); app.innerHTML = `<section class="intro"><div><h1>업로드 내역</h1></div><button class="secondary" id="logout">로그아웃</button></section><div class="stats"><div><b id="total">0</b><span>파일</span></div><div><b id="people">0</b><span>의료기관명</span></div><div><b id="volume">0</b><span>보관 중</span></div></div><section id="cloud-usage" class="cloud-usage" hidden></section><form class="filters" id="filter-form"><input type="search" id="filter-name" placeholder="의료기관명 검색" aria-label="의료기관명 검색"><label class="date-field">업로드 시작일<input type="date" id="filter-from" aria-label="업로드 시작일"></label><label class="date-field">업로드 종료일<input type="date" id="filter-to" aria-label="업로드 종료일"></label><select id="sort" aria-label="정렬"><option value="newest">최신순</option><option value="oldest">오래된순</option><option value="institution">의료기관명 가나다순</option><option value="institution-desc">의료기관명 역순</option></select><button class="secondary">조회</button><button class="secondary" type="button" id="reset">초기화</button></form><div class="section-heading"><label class="help"><input type="checkbox" id="select-all"> 현재 페이지 선택 <span id="selection-count"></span></label><div class="admin-actions"><button class="secondary" id="share">링크 · QR ↗</button><button class="primary" id="download">전체 ZIP 다운로드 ↓</button></div></div><p class="help">한국 시간(KST) 기준 · 종료일 포함 · 전체 ZIP은 모든 페이지의 조회 결과를 포함합니다.</p><div id="gallery" class="gallery"></div><div id="empty" class="empty">조회 결과 없음</div><div id="pagination" class="pagination" hidden></div>`; $('#logout').onclick = async () => { await api('/api/admin/logout',{method:'POST'}); loginPage(); }; $('#share').onclick=share; $('#filter-form').onsubmit=e=>{e.preventDefault();loadAdmin();}; $('#sort').onchange=()=>loadAdmin(); $('#reset').onclick=()=>{$('#filter-form').reset();loadAdmin();}; $('#select-all').onchange=e=>{selected = new Set(e.target.checked ? photos.map(p=>p.id) : []); renderGallery(true);updateSelection();}; $('#download').onclick=async()=>{if((await runtimeConfig).zipParts)return cloudDownload();const q=new URLSearchParams(adminFilters);if(selected.size)q.set('ids',[...selected].join(','));const form=document.createElement('form');form.method='POST';form.action='/api/admin/download';for(const [key,value] of q){const input=document.createElement('input');input.type='hidden';input.name=key;input.value=value;form.append(input);}document.body.append(form);form.submit();form.remove();};loadAdmin(); }
function filterParams() {return new URLSearchParams({institution:$('#filter-name').value.trim(),from:$('#filter-from').value,to:$('#filter-to').value,sort:$('#sort').value});}
let adminRequest = 0, adminTimer, adminActive = false, adminLoading = false, adminCurrentPage = 1;
let adminFilters = new URLSearchParams();
let deletingPhotos=false;
async function deleteSelectedPhotos() {
 const ids=[...selected];if(!ids.length||deletingPhotos)return;
 if(!confirm(`선택한 ${ids.length}장의 사진을 삭제할까요?\n원본과 썸네일이 삭제되며 복구할 수 없습니다.`))return;
 deletingPhotos=true;updateSelection();
 try {
  const result=await api('/api/admin/photos',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})});
  selected.clear();await loadAdmin(adminCurrentPage,{useApplied:true});
  toast(result.cleanupPending?`${result.deleted}장 삭제 · 저장 공간 정리 재시도 예정`:`${result.deleted}장 삭제 완료`);
 }catch(e){if(e.status===401)loginPage();else toast(e.message);}
 finally{deletingPhotos=false;if($('#delete-photos'))updateSelection();}
}
function stopAdminRefresh() { adminActive=false; clearInterval(adminTimer); }
function startAdminRefresh() {
 stopAdminRefresh(); adminActive=true; adminLoading=false;
}
function refreshAdmin() {
 if(adminActive && !adminLoading && document.visibilityState === 'visible') loadAdmin(adminCurrentPage,{refresh:true});
}
// Refresh only on explicit user action; avoid background requests against free quotas.
async function loadAdmin(page = 1, {refresh = false, useApplied = false} = {}) {
 const actions = document.querySelector('.admin-actions');
 if(actions && !$('#delete-photos')) { const button=document.createElement('button');button.className='secondary danger';button.id='delete-photos';button.textContent='선택 삭제';button.disabled=true;button.onclick=deleteSelectedPhotos;actions.append(button); }
 if(actions && !$('#admin-refresh')) { const button=document.createElement('button');button.className='secondary';button.id='admin-refresh';button.textContent='새로고침';button.onclick=()=>loadAdmin(adminCurrentPage,{refresh:true});actions.prepend(button); }
 const params = (refresh || useApplied) ? new URLSearchParams(adminFilters) : filterParams();
 const from=params.get('from'), to=params.get('to');
 if(from && to && from > to) return toast('종료일은 시작일 이후로 선택해주세요.');
 const request=++adminRequest; adminLoading=true;
 try {
  params.set('page',page);
  const result = await api('/api/admin/photos?'+params);
  if(request!==adminRequest || !adminActive)return;
  const changed=JSON.stringify(photos)!==JSON.stringify(result.photos);
  photos=result.photos; adminCurrentPage=result.page;
  params.delete('page'); adminFilters=params;
  if(refresh) selected=new Set([...selected].filter(id=>photos.some(p=>p.id===id)));
  else selected.clear();
  $('#total').textContent=result.overall.total;
  $('#people').textContent=result.overall.institutions;
  $('#volume').textContent=size(result.overall.bytes);
  renderUsage(result.usage);
  pagination(result, page=>loadAdmin(page,{useApplied:true}));
  if(changed || !refresh) await renderGallery(true);
  updateSelection();
 } catch(e){
  if(request!==adminRequest || !adminActive)return;
  if(e.status===401) loginPage();
  else if(!refresh) toast(e.message);
 } finally { if(request===adminRequest) adminLoading=false; }
}
function updateSelection() { if($('#delete-photos')){ $('#delete-photos').disabled=deletingPhotos||selected.size===0;$('#delete-photos').textContent=deletingPhotos?'삭제 중…':selected.size?`선택한 ${selected.size}장 삭제`:'선택 삭제'; } $('#selection-count').textContent=selected.size ? `· ${selected.size}장 선택` : ''; $('#select-all').checked=photos.length>0 && selected.size===photos.length;$('#select-all').indeterminate=selected.size>0 && selected.size<photos.length;$('#download').disabled=!photos.length;$('#download').textContent=selected.size ? `선택한 ${selected.size}장 다운로드 ↓` : '전체 ZIP 다운로드 ↓'; }
isAdmin ? adminInit() : uploader();
