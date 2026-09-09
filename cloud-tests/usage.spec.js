import {test,expect} from '@playwright/test';
import {quota,classifyOperations,usage,billingStart,collectUsage} from '../worker/usage.ts';
import {readFileSync} from 'node:fs';
test('warning thresholds, unknown metrics and UTC reset',async()=>{
 expect(billingStart('',new Date())).toBeNull();
 expect(billingStart('2026-01-15T03:00:00Z',new Date('2026-09-09T00:00:00Z'))).toBe('2026-08-15T03:00:00.000Z');
 expect(billingStart('2026-01-31T00:00:00Z',new Date('2026-02-28T01:00:00Z'))).toBe('2026-02-28T00:00:00.000Z');
 expect(quota('r2','R2',9499999999,1e10,'bytes','현재').level).toBe('normal');
 expect(quota('r2','R2',9500000000,1e10,'bytes','현재').level).toBe('warning');
 expect(quota('r2','R2',1e10,1e10,'bytes','현재').level).toBe('exceeded');
 expect(quota('w','Workers',100001,100000,'회','오늘').remaining).toBe(0);
 expect(quota('w','Workers',null,100000,'회','오늘').percent).toBeNull();
 expect(classifyOperations([{sum:{requests:7},dimensions:{actionType:'PutObject'}},{sum:{requests:4},dimensions:{actionType:'HeadObject'}},{sum:{requests:10},dimensions:{actionType:'DeleteObject'}}])).toEqual({a:7,b:4});
 expect(()=>classifyOperations([{sum:{requests:1},dimensions:{actionType:'Unknown'}}])).toThrow();
 expect(classifyOperations([{sum:{requests:4},dimensions:{actionType:'HeadObject',responseStatusCode:404}},{sum:{requests:10},dimensions:{actionType:'PutObject',responseStatusCode:401}}])).toEqual({a:0,b:4});
 const rows=[{id:'workers',body:JSON.stringify({requests:99999,period:'2026-09-08'}),updated:Date.parse('2026-09-08T23:59:00Z'),error:null}];
 const env={DB:{prepare:()=>({bind:()=>({all:async()=>({results:rows})})})},CF_ACCOUNT_ID:'account',CF_ANALYTICS_TOKEN:'token',R2_FREE_BYTES:'10000000000',R2_WARNING_BYTES:'9500000000',WORKERS_DAILY_LIMIT:'100000',D1_READ_DAILY_LIMIT:'5000000',D1_WRITE_DAILY_LIMIT:'100000',D1_STORAGE_LIMIT:'5000000000',R2_CLASS_A_MONTHLY_LIMIT:'1000000',R2_CLASS_B_MONTHLY_LIMIT:'10000000'};
 const reset=await usage(env,9500000000,new Date('2026-09-09T00:00:01Z'));
 expect(reset.metrics[0].level).toBe('warning');expect(reset.metrics.find(m=>m.id==='workers-requests').used).toBeNull();
 const missing=await usage({...env,CF_ANALYTICS_TOKEN:''},0);expect(missing.metrics.find(m=>m.id==='workers-requests').status).toBe('미연결');
});
test('admin renders a red 9.5 GB warning and explicitly unknown request usage',async({page})=>{
 await page.route('**/api/admin/session',r=>r.fulfill({json:{ok:true}}));
 await page.route('**/api/admin/photos?*',r=>r.fulfill({json:{photos:[],page:1,pages:1,total:0,overall:{total:100,institutions:4,bytes:9400000000},usage:{note:'검증용 사용량',metrics:[
  quota('r2-storage','이 앱 R2 저장량',9500000000,1e10,'bytes','현재',{status:'원본 + 썸네일',scope:'이 앱',updated:Date.now()}),
  quota('workers-requests','Workers 요청',null,100000,'회','오늘',{status:'미연결',scope:'계정 전체',updated:null})
 ]}}}));
 await page.goto('/admin');
 const card=page.locator('[data-quota="r2-storage"]');await expect(card).toHaveClass(/warning/);await expect(card).toContainText('9.5 GB / 10 GB');await expect(card).toContainText('한도 임박');
 await expect(card).toHaveCSS('border-top-color','rgb(188, 28, 39)');
 await expect(page.locator('[data-quota="workers-requests"]')).toContainText('미연결');await expect(page.locator('[data-quota="workers-requests"] progress')).toHaveCount(0);
 await expect(page.locator('#total')).toHaveText('100');
});
test('account collection sums the billing period and keeps last good metrics on partial failure',async()=>{
 const rows=new Map(),originalFetch=globalThis.fetch;
 const env={...JSON.parse(readFileSync('wrangler.jsonc','utf8')).vars,CF_ANALYTICS_TOKEN:'test-only',R2_BILLING_ANCHOR:'2026-09-01T00:00:00Z',DB:{prepare(sql){return{bind(...args){return{
  async first(){return rows.get(args[0])||null;},async all(){return{results:[...rows.values()]};},async run(){
   const [id,body,updated]=args;if(sql.includes('VALUES(?,?,?,NULL)'))rows.set(id,{id,body,updated,error:null});else rows.set(id,{...(rows.get(id)||{id,body:'{}',updated:0}),error:args.at(-1)});
  }
 };}};}}};
 let unavailable=false;
 globalThis.fetch=async(_url,options)=>{
  if(unavailable)return Response.json({errors:[{message:'denied'}]});
  const q=JSON.parse(options.body).query;let data;
  if(q.includes('workersInvocationsAdaptive'))data={workersInvocationsAdaptive:[{sum:{requests:95000}}]};
  else if(q.includes('d1AnalyticsAdaptiveGroups'))data={d1AnalyticsAdaptiveGroups:[{sum:{rowsRead:1200,rowsWritten:200}}]};
  else if(q.includes('d1StorageAdaptiveGroups'))return Response.json({errors:[{message:'storage temporarily unavailable'}]});
  else data={r2OperationsAdaptiveGroups:[{sum:{requests:7},dimensions:{actionType:'PutObject',responseStatusCode:200}},{sum:{requests:4},dimensions:{actionType:'HeadObject',responseStatusCode:404}}]};
  return Response.json({data:{viewer:{accounts:[data]}}});
 };
 try{
  const now=new Date('2026-09-02T12:00:00Z');await collectUsage(env,now);
  const result=await usage(env,0,now),metric=id=>result.metrics.find(m=>m.id===id);
  expect(metric('workers-requests').used).toBe(95000);expect(metric('workers-requests').level).toBe('warning');expect(metric('r2-a').used).toBe(14);expect(metric('r2-b').used).toBe(8);
  expect(metric('d1-reads').used).toBe(1200);expect(metric('d1-storage-bytes').used).toBeNull();expect(metric('d1-storage-bytes').status).toContain('조회 실패');
  unavailable=true;await collectUsage(env,now);const stale=await usage(env,0,now);expect(stale.metrics.find(m=>m.id==='workers-requests')).toMatchObject({used:95000,status:'갱신 지연 · 마지막 집계'});
 }finally{globalThis.fetch=originalFetch;}
});
