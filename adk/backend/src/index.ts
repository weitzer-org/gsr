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

import { app } from './app';
import { assertProductionAuthConfigured } from './auth';

assertProductionAuthConfigured();

const PORT = process.env.PORT || 8080;

app.listen(PORT as number, '0.0.0.0', () => {
  console.log(`GSR ADK Backend listening on IPv4 0.0.0.0 port ${PORT}`);
});
