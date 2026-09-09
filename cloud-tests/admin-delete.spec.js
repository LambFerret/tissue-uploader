import {test,expect} from '@playwright/test';
import {checkAdminDelete} from '../tests/helpers/admin-delete.js';
import {cleanDeletedPhotos} from '../worker/deletion.ts';
test('administrator selected deletion, confirmation, permissions, totals and retry',checkAdminDelete);
test('storage failure retains cleanup job and storage accounting until retry succeeds',async()=>{
 let fail=true,committed=false,keys;
 const env={DB:{prepare:sql=>({bind:()=>({all:async()=>({results:[{id:'test-id'}]}),sql})}),batch:async()=>{committed=true;}},PHOTOS:{delete:async values=>{keys=values;if(fail)throw new Error('temporary storage failure');}}};
 expect(await cleanDeletedPhotos(env,['test-id'])).toBe(false);expect(committed).toBe(false);
 fail=false;expect(await cleanDeletedPhotos(env,['test-id'])).toBe(true);expect(committed).toBe(true);expect(keys).toEqual(['originals/test-id','thumbs/test-id.jpg']);
});
