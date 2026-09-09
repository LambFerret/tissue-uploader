import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
if(!existsSync('.dev.vars')) {
 const password=existsSync('data/admin-password.txt')?readFileSync('data/admin-password.txt','utf8').trim():randomBytes(24).toString('base64url');
 writeFileSync('.dev.vars','ADMIN_PASSWORD='+JSON.stringify(password)+'\n',{mode:0o600});
}
