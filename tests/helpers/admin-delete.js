import {expect} from '@playwright/test';
import sharp from 'sharp';
import {randomUUID} from 'node:crypto';
export async function checkAdminDelete({page,request}){
 const institution='삭제검증-'+randomUUID().slice(0,8),buffer=await sharp({create:{width:20,height:20,channels:3,background:'white'}}).png().toBuffer();
 const config=await(await request.get('/api/config')).json();
 await page.route('**/api/photos/scale-*/thumb',route=>route.fulfill({contentType:'image/png',body:buffer}));
 await page.goto('/');await page.locator('#nickname').fill(institution);
 await page.locator('#files').setInputFiles([0,1,2].map(i=>({name:`delete-${i}.png`,mimeType:'image/png',buffer})));
 const retryId=await page.evaluate(()=>queue[0].id);
 await page.getByRole('button',{name:'업로드',exact:true}).click();await expect(page.locator('.queue-item small').filter({hasText:'완료'})).toHaveCount(3);
 const visitor=await page.evaluate(()=>localStorage.getItem('moa-visitor'));
 const ownHeaders={'X-Visitor-Id':visitor},mine=await(await request.get('/api/photos/mine',{headers:ownHeaders})).json();
 expect((await request.delete('/api/admin/photos',{data:{ids:mine.photos.map(p=>p.id)}})).status()).toBe(401);
 await page.goto('/admin');await page.locator('#password').fill('test-password-strong');await page.getByRole('button',{name:'로그인',exact:true}).click();
 await expect(page.locator('#delete-photos')).toBeDisabled();
 const before=await(await page.request.get('/api/admin/photos')).json();
 await page.locator('#filter-name').fill(institution);await page.getByRole('button',{name:'조회',exact:true}).click();await expect(page.locator('.photo-card')).toHaveCount(3);
 const all=await page.locator('[data-select]').evaluateAll(items=>items.map(item=>item.dataset.select));
 await page.locator('[data-select]').nth(0).check();await page.locator('[data-select]').nth(1).check();
 page.once('dialog',dialog=>dialog.dismiss());await page.locator('#delete-photos').click();await expect(page.locator('.photo-card')).toHaveCount(3);
 expect((await page.request.delete('/api/admin/photos',{data:{ids:[]}})).status()).toBe(400);
 expect((await page.request.delete('/api/admin/photos',{headers:{Origin:'https://foreign.example'},data:{ids:[all[0]]}})).status()).toBe(403);
 page.once('dialog',dialog=>dialog.accept());await page.locator('#delete-photos').click();await expect(page.locator('.photo-card')).toHaveCount(1);
 await expect(page.locator('#total')).toHaveText(String(before.overall.total-2));await expect(page.locator('#people')).toHaveText(String(before.overall.institutions));
 const after=await(await page.request.get('/api/admin/photos')).json();expect(after.overall.bytes).toBe(before.overall.bytes-buffer.length*2);
 if(config.uploadMode==='r2-stream')expect(after.overall.r2_bytes).toBeLessThan(before.overall.r2_bytes-buffer.length*2);
 expect((await request.get(`/api/photos/${all[0]}/original`,{headers:ownHeaders})).status()).toBe(404);
 expect((await request.get(`/api/photos/${all[0]}/thumb`,{headers:ownHeaders})).status()).toBe(404);
 expect((await request.get(`/api/photos/${all[2]}/original`,{headers:ownHeaders})).status()).toBe(200);
 expect((await(await page.request.delete('/api/admin/photos',{data:{ids:all.slice(0,2)}})).json()).deleted).toBe(0);
 await page.locator('[data-select]').check();page.once('dialog',dialog=>dialog.accept());await page.locator('#delete-photos').click();await expect(page.locator('.photo-card')).toHaveCount(0);
 await expect(page.locator('#people')).toHaveText(String(before.overall.institutions-1));await expect(page.locator('#total')).toHaveText(String(before.overall.total-3));await expect(page.locator('#delete-photos')).toBeDisabled();
 expect((await(await request.get('/api/photos/mine',{headers:ownHeaders})).json()).total).toBe(0);
 const retry=config.uploadMode==='r2-stream'
  ? await request.post('/api/uploads',{headers:ownHeaders,data:{id:retryId,institution,name:'delete-0.png',size:buffer.length,thumbSize:1,crc32:0,format:'png'}})
  : await request.post('/api/photos',{headers:ownHeaders,multipart:{requestId:retryId,institution,photo:{name:'delete-0.png',mimeType:'image/png',buffer}}});
 expect(retry.status()).toBe(410);
}
