import { resolve } from 'node:path';
import { createApp } from './app.mjs';

const port = Number(process.env.PORT ?? 3100);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const app = await createApp({ dataDir: resolve(process.env.DATA_DIR ?? 'data') });
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 10000);
    timeout.unref();
    try { await app.close(); } catch (error) { app.log.error(error); process.exitCode = 1; }
    clearTimeout(timeout);
  });
}
try {
  await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
