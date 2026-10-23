const http = require('http');

function probe() {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.request(
      { host: '127.0.0.1', port: 45999, method: 'GET', path: '/dsh-spectrum-rail?probe=1' },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode, ms: Date.now() - started, hdr: res.headers['x-dsh-spectrum'] });
      }
    );
    req.on('error', (e) => resolve({ error: e.message }));
    req.end();
  });
}

function readStream(ms) {
  return new Promise((resolve) => {
    let bytes = 0;
    const started = Date.now();
    const req = http.request({ host: '127.0.0.1', port: 45999, path: '/dsh-spectrum-rail' }, (res) => {
      const timer = setTimeout(() => {
        res.destroy();
        req.destroy();
        resolve({ status: res.statusCode, bytes, rate: res.headers['x-sample-rate'] });
      }, ms);
      res.on('data', (b) => {
        bytes += b.length;
      });
      res.on('close', () => clearTimeout(timer));
    });
    req.on('error', () => {});
    req.end();
  });
}

(async () => {
  console.log('probe #1', await probe());
  const streamPromise = readStream(900);
  await new Promise((r) => setTimeout(r, 200));
  console.log('probe #2 (while streaming)', await probe());
  console.log('stream', await streamPromise);
  console.log('probe #3 (after close)', await probe());
  process.exit(0);
})();
