import * as dotenv from 'dotenv';
import * as path from 'path';

const currentDir = typeof __dirname !== 'undefined' ? __dirname : undefined;
if (currentDir) {
    const isCompiled = currentDir.includes(path.join('dist', 'src'));
    const envPath = isCompiled 
        ? path.resolve(currentDir, '../../.env') 
        : path.resolve(currentDir, '../.env');
    dotenv.config({ path: envPath });
} else {
    dotenv.config();
}

import * as fs from 'fs';
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // Current dir is either backend/src or backend/dist/src
    const saPath = currentDir 
        ? path.resolve(currentDir, currentDir.includes('dist') ? '../../../../jetski-sa-key.json' : '../../../jetski-sa-key.json') 
        : '';
    if (fs.existsSync(saPath)) {
        console.log('🔑 Auto-loading jetski-sa-key.json for GCP authentication...');
        process.env.GOOGLE_APPLICATION_CREDENTIALS = saPath;
    }
}

import { app } from './app';

const PORT = process.env.PORT || 8080;

app.listen(PORT as number, '0.0.0.0', () => {
  console.log(`GSR ADK Backend listening on IPv4 0.0.0.0 port ${PORT}`);
});
