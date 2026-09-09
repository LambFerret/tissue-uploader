export type AppEnv = Env & { ADMIN_PASSWORD?: string; CF_ANALYTICS_TOKEN?: string };
type Row = { sum?: Record<string, number>; max?: Record<string, number>; dimensions?: Record<string, string | number> };
type Snapshot = { value: number | null; updated: number | null; status: string; period: string };
const A = new Set('ListBuckets PutBucket ListObjects ListObjectsV2 PutObject CopyObject CompleteMultipartUpload CreateMultipartUpload LifecycleStorageTierTransition ListMultipartUploads UploadPart UploadPartCopy ListParts PutBucketEncryption PutBucketCors PutBucketLifecycleConfiguration'.split(' '));
const B = new Set('HeadBucket HeadObject GetObject UsageSummary GetBucketEncryption GetBucketLocation GetBucketCors GetBucketLifecycleConfiguration'.split(' '));
const FREE = new Set('DeleteObject DeleteObjects DeleteBucket AbortMultipartUpload'.split(' '));
export function billingStart(anchor: string | undefined, now: Date): string | null {
 if(!anchor || !/^\d{4}-\d{2}-\d{2}T/.test(anchor) || !Number.isFinite(Date.parse(anchor)))return null;
 const first=new Date(anchor);
 function at(month:number){const date=new Date(Date.UTC(now.getUTCFullYear(),month,1,first.getUTCHours(),first.getUTCMinutes(),first.getUTCSeconds()));const last=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();date.setUTCDate(Math.min(first.getUTCDate(),last));return date;}
 let start=at(now.getUTCMonth());if(start>now)start=at(now.getUTCMonth()-1);
 return start.toISOString();
}
export function classifyOperations(rows: Row[]) {
 let a = 0, b = 0;
 for (const row of rows) {
  const action = String(row.dimensions?.actionType || ''), n = row.sum?.requests;
  if (!Number.isFinite(n) || Number(n) < 0) throw new Error('invalid_metric');
  // R2 pricing excludes unauthorized (401) operations; a billable 404 must count.
  if(Number(row.dimensions?.responseStatusCode)===401)continue;
  if (A.has(action)) a += n!;
  else if (B.has(action)) b += n!;
  else if (!FREE.has(action) && n) throw new Error('unknown_r2_operation');
 }
 return { a, b };
}
async function graph(env: AppEnv, selection: string): Promise<Record<string, Row[]>> {
 const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
  method: 'POST', headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: `{viewer{accounts(filter:{accountTag:${JSON.stringify(env.CF_ACCOUNT_ID)}}){${selection}}}}` }),
  signal: AbortSignal.timeout(15000)
 });
 const body = await response.json() as { errors?: unknown[]; data?: { viewer?: { accounts?: Record<string, Row[]>[] } } };
 if (!response.ok || body.errors?.length || !body.data?.viewer?.accounts?.[0]) throw new Error('analytics_unavailable');
 return body.data.viewer.accounts[0];
}
const sum = (rows: Row[], field: string, kind: 'sum' | 'max' = 'sum') => rows.reduce((n, row) => {
 const value = row[kind]?.[field];
 if (!Number.isFinite(value) || Number(value) < 0) throw new Error('invalid_metric');
 return n + value!;
}, 0);
async function save(env: AppEnv, id: string, body: unknown) {
 await env.DB.prepare('INSERT INTO analytics_cache(id,body,updated,error) VALUES(?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET body=excluded.body,updated=excluded.updated,error=NULL').bind(id, JSON.stringify(body), Date.now()).run();
}
export async function collectUsage(env: AppEnv, now = new Date()) {
 if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) return;
 const day = now.toISOString().slice(0, 10), periodStart = billingStart(env.R2_BILLING_ANCHOR,now);
 const time = `datetime_geq:"${day}T00:00:00Z",datetime_leq:"${now.toISOString()}"`;
 const tasks: [string, () => Promise<Record<string, number>>][] = [
  ['workers', async () => { const d = await graph(env, `workersInvocationsAdaptive(limit:1,filter:{${time}}){sum{requests}}`); return { requests: sum(d.workersInvocationsAdaptive, 'requests') }; }],
  ['d1', async () => { const d = await graph(env, `d1AnalyticsAdaptiveGroups(limit:1,filter:{date_geq:"${day}",date_leq:"${day}"}){sum{rowsRead rowsWritten}}`); return { reads: sum(d.d1AnalyticsAdaptiveGroups, 'rowsRead'), writes: sum(d.d1AnalyticsAdaptiveGroups, 'rowsWritten') }; }],
  ['d1-storage', async () => { const d = await graph(env, `d1StorageAdaptiveGroups(limit:10000,filter:{date_geq:"${day}",date_leq:"${day}"}){max{databaseSizeBytes} dimensions{databaseId}}`); if (!d.d1StorageAdaptiveGroups.length || d.d1StorageAdaptiveGroups.length >= 10000) throw new Error('storage_not_reported'); return { bytes: sum(d.d1StorageAdaptiveGroups, 'databaseSizeBytes', 'max') }; }],
  ['r2', async () => {
   if(!periodStart)throw new Error('billing_period_unconfigured');
   // One UTC day per query also works with accounts whose dataset query window is one day.
   // Revisit the two most recent days for delayed reporting; older daily totals are reused.
   let a = 0, b = 0;
   for (let start = Date.parse(periodStart); start < now.getTime();) {
    const date=new Date(start).toISOString().slice(0,10),startISO=new Date(start).toISOString(),key=`r2-day:${startISO}`;
    const next=Date.parse(`${date}T00:00:00Z`)+86400000;
    const cached = await env.DB.prepare('SELECT body FROM analytics_cache WHERE id=?').bind(key).first<{body: string}>();
    let values: {a:number;b:number};
    if (cached && next < Date.parse(`${day}T00:00:00Z`)-86400000) values = JSON.parse(cached.body);
    else {
     const end = new Date(Math.min(next,now.getTime())).toISOString();
     const d = await graph(env, `r2OperationsAdaptiveGroups(limit:1000,filter:{datetime_geq:"${startISO}",datetime_lt:"${end}"}){sum{requests} dimensions{actionType responseStatusCode}}`);
     if (d.r2OperationsAdaptiveGroups.length >= 1000) throw new Error('truncated_metrics');
     values = classifyOperations(d.r2OperationsAdaptiveGroups); await save(env, key, values);
    }
    a += values.a; b += values.b;start=next;
   }
   return { a, b };
  }]
 ];
 // Keep datasets independent: one unavailable dataset must not erase working cards.
 await Promise.all(tasks.map(async ([id, read]) => {
  try { await save(env, id, { ...await read(), period: id === 'r2' ? periodStart : day }); }
  catch { await env.DB.prepare('INSERT INTO analytics_cache(id,body,updated,error) VALUES(?,?,0,?) ON CONFLICT(id) DO UPDATE SET error=excluded.error').bind(id, '{}', '조회 실패 · 권한 또는 집계 상태 확인').run(); console.warn(JSON.stringify({event:'analytics_failed', dataset:id})); }
 }));
}
export function quota(id: string, label: string, used: number | null, limit: number, unit: string, period: string, extra: Record<string, unknown> = {}) {
 return { id, label, used, limit, unit, period, remaining: used === null ? null : Math.max(0, limit-used), percent: used === null ? null : used/limit*100, level: used === null ? 'unknown' : used >= limit ? 'exceeded' : used >= limit*.95 ? 'warning' : 'normal', ...extra };
}
export async function usage(env: AppEnv, r2Bytes: number, now = new Date()) {
 const rows = await env.DB.prepare('SELECT * FROM analytics_cache WHERE id IN (?,?,?,?)').bind('workers','d1','d1-storage','r2').all<{id:string;body:string;updated:number;error:string|null}>();
 const day = now.toISOString().slice(0,10), periodStart = billingStart(env.R2_BILLING_ANCHOR,now)||'';
 function snapshot(id: string, field: string, period: string): Snapshot {
  const row = rows.results.find(r => r.id === id), data = row ? JSON.parse(row.body) : {};
  const connected = !!(env.CF_ANALYTICS_TOKEN && env.CF_ACCOUNT_ID);
  const current = data.period === period && Number.isFinite(data[field]);
  return { value: connected && current ? data[field] : null, updated: row?.updated || null, period,
   status: !connected ? '미연결' : id==='r2'&&!periodStart ? '청구 주기 미설정' : !current ? (row?.error || '집계 대기') : row?.error || now.getTime()-row!.updated > 30*60000 ? '갱신 지연 · 마지막 집계' : 'Cloudflare 집계' };
 }
 const specs = [
  ['workers','requests','Workers 요청',Number(env.WORKERS_DAILY_LIMIT),'회',day],
  ['r2','a','R2 Class A · 쓰기·목록',Number(env.R2_CLASS_A_MONTHLY_LIMIT),'회',periodStart],
  ['r2','b','R2 Class B · 읽기',Number(env.R2_CLASS_B_MONTHLY_LIMIT),'회',periodStart],
  ['d1','reads','D1 읽은 행',Number(env.D1_READ_DAILY_LIMIT),'행',day],
  ['d1','writes','D1 쓴 행',Number(env.D1_WRITE_DAILY_LIMIT),'행',day],
  ['d1-storage','bytes','D1 계정 저장량',Number(env.D1_STORAGE_LIMIT),'bytes',day]
 ] as const;
 return { metrics: [quota('r2-storage','이 앱 R2 저장량',r2Bytes,Number(env.R2_FREE_BYTES),'bytes','현재', { status:'원본 + 썸네일',updated:now.getTime(),scope:'이 앱', level:r2Bytes>=Number(env.R2_FREE_BYTES)?'exceeded':r2Bytes>=Number(env.R2_WARNING_BYTES)?'warning':'normal' }),
  ...specs.map(([id,field,label,limit,unit,period]) => { const s = snapshot(id,field,period); return quota(`${id}-${field}`,label,s.value,limit,unit,id==='r2'?(period?`${period.slice(0,10)}부터 · 청구 주기`:'월간 청구 주기'):period,{status:s.status,updated:s.updated,scope:'계정 전체'}); })],
  note:'Workers Free·D1 Free·R2 Standard 기준. 일일 한도는 한국 시간 오전 9시, R2 월간 요청량은 계정 청구 주기 기준입니다. 계정 집계에는 다른 앱도 포함되며 집계 지연·샘플링으로 청구값과 다를 수 있습니다. R2 저장 요금은 월간 일별 최대 저장량의 평균 기준이며, 현재 용량 표시는 예상 경고입니다. 이 표시는 자동 과금 차단이 아닙니다.' };
}
