import { rename, unlink } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

// Windows scanners can briefly retain file handles after a write completes.
async function retryFileOperation(operation) {
 for (let attempt = 0; ; attempt++) {
  try { return await operation(); }
  catch (error) {
   if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code) || attempt === 5) throw error;
   await setTimeout(80 * 2 ** attempt);
  }
 }
}
export const moveFile = (from, to) => retryFileOperation(() => rename(from, to));
export const removeFile = file => retryFileOperation(() => unlink(file)).catch(error => {
 if (error.code !== 'ENOENT') console.error('Temporary file cleanup failed:', error.code);
});
