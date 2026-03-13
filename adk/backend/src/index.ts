import * as dotenv from 'dotenv';
dotenv.config();

import { app } from './app';

const PORT = process.env.PORT || 8080;

app.listen(PORT as number, '127.0.0.1', () => {
  console.log(`GSR ADK Backend listening tightly on IPv4 127.0.0.1 port ${PORT}`);
});
