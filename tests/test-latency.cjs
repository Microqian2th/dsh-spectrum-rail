const net = require('net');

function firstByteLatency() {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect(45999, '127.0.0.1', () => {
      socket.write('GET /dsh-spectrum-rail HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    });
    let headerDone = false;
    socket.on('data', (buf) => {
      if (!headerDone) {
        headerDone = true;
        resolve({ headerMs: Date.now() - started, bytes: buf.length });
        socket.destroy();
      }
    });
    socket.on('error', () => resolve({ error: true }));
    setTimeout(() => {
      socket.destroy();
      resolve({ timeout: true });
    }, 3000);
  });
}

(async () => {
  for (let i = 0; i < 3; i += 1) {
    const result = await firstByteLatency();
    console.log('run', i, result);
    await new Promise((r) => setTimeout(r, 300));
  }
  process.exit(0);
})();
