import {test} from '@playwright/test';
import {checkAdminDelete} from './helpers/admin-delete.js';
test('administrator selected deletion, confirmation, permissions, totals and retry',checkAdminDelete);
