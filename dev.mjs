import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const api = spawn(process.execPath, ['server.mjs'], { stdio: 'inherit' });
const web = spawn(npm, ['run', 'start:web'], { stdio: 'inherit', shell: process.platform === 'win32' });

function stop() {
  api.kill();
  web.kill();
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
api.on('exit', code => { if (code) process.exitCode = code; });
web.on('exit', code => { stop(); process.exit(code ?? 0); });
