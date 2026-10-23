/** Host half: keeps the WASAPI loopback helper alive while the plugin is loaded. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 与 Client 半约定的端口段（helper 会自动顺延，Client 会逐端口探测）。 */
const PORT_BASE = 45999;
/** 意外退出时的重启次数上限，避免 exe 坏掉时无限拉起。 */
const MAX_RESTARTS = 5;

let child = null;
let restarts = 0;
let stopping = false;
let restartTimer = null;

function scheduleRestart() {
  if (stopping || restarts >= MAX_RESTARTS) return;
  restarts += 1;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startHelper();
  }, 2000);
}

function startHelper() {
  if (child !== null || stopping) return;
  let executable;
  try {
    executable = fileURLToPath(new URL('./native/loopback-capture.exe', import.meta.url));
  } catch (error) {
    return;
  }
  try {
    child = spawn(executable, ['--serve', String(PORT_BASE)], {
      stdio: 'ignore',
      windowsHide: true,
      detached: false
    });
    child.on('exit', () => {
      child = null;
      scheduleRestart();
    });
    child.on('error', () => {
      child = null;
      scheduleRestart();
    });
  } catch (error) {
    child = null;
    scheduleRestart();
  }
}

export function apply(ctx) {
  ctx.effect(() => {
    stopping = false;
    startHelper();
    return () => {
      stopping = true;
      if (restartTimer !== null) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      if (child !== null) {
        try {
          child.kill();
        } catch (error) {
          /* 忽略 */
        }
        child = null;
      }
    };
  });
}
