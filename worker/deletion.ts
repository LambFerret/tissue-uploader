import type {AppEnv} from './usage';
// Remove metadata first (transactional trigger), then storage. If R2 fails, the
// durable job remains for Cron/retry and R2 bytes stay counted until deletion succeeds.
export async function cleanDeletedPhotos(env:AppEnv, ids?:string[]) {
 const jobs=ids?.length
  ? await env.DB.prepare(`SELECT id FROM deletion_jobs WHERE id IN (${ids.map(()=>'?').join(',')}) LIMIT 60`).bind(...ids).all<{id:string}>()
  : await env.DB.prepare('SELECT id FROM deletion_jobs LIMIT 60').all<{id:string}>();
 if(!jobs.results.length)return true;
 const keys=jobs.results.flatMap(p=>[`originals/${p.id}`,`thumbs/${p.id}.jpg`]);
 try {
  await env.PHOTOS.delete(keys);
  await env.DB.batch(jobs.results.flatMap(p=>[
   env.DB.prepare('DELETE FROM objects WHERE key IN (?,?)').bind(`originals/${p.id}`,`thumbs/${p.id}.jpg`),
   env.DB.prepare('DELETE FROM deletion_jobs WHERE id=?').bind(p.id)
  ]));
  return true;
 }catch{
  console.warn(JSON.stringify({event:'photo_deletion_cleanup_pending',count:jobs.results.length}));
  return false;
 }
}
