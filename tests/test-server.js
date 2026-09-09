import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
// Metadata-only scale fixture. No patient data or 100GB of synthetic originals.
const db = new DatabaseSync(path.join(process.env.DATA_DIR, 'photos.sqlite'));
db.exec(`CREATE TABLE photos (id TEXT PRIMARY KEY, owner TEXT NOT NULL, nickname TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, created TEXT NOT NULL, format TEXT NOT NULL, request_id TEXT UNIQUE)`);
const insert = db.prepare('INSERT INTO photos VALUES (?,?,?,?,?,?,?,?)');
db.exec('BEGIN');
for(let i=0;i<50000;i++) {
 const id='scale-'+String(i).padStart(5,'0');
 insert.run(id,'scale-owner',`규모검증-${String(i%100).padStart(3,'0')}치과`,id+'.jpg',1900000,new Date(Date.UTC(2026,0,1)+i*60000).toISOString(),'jpeg',id);
}
db.exec('COMMIT'); db.close();
await import('../server.js');
