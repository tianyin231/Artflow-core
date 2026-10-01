// CLI entry — delegates to CommonJS implementation (jest-friendly).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const impl = require('./index.cjs');
if (process.argv[1] && process.argv[1].endsWith('index.mjs')) {
  const portArg = process.argv.indexOf('--port');
  const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 3302;
  impl.startMockServer(port).then(({ port: p }) => {
    console.log(`[mock-servers] listening on http://127.0.0.1:${p}`);
  });
}
export default impl;
