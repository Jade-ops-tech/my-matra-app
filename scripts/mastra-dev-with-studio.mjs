/**
 * 补偿 mastra dev 丢失 `.mastra/output/studio`（ENOENT index.html）。
 * 仅在 output 内已有 bundle 产物后再复制，避免与 CLI 清空 output 冲突（ENOTEMPTY）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const studioSrc = path.join(projectRoot, 'node_modules', 'mastra', 'dist', 'studio');
const outDir = path.join(projectRoot, '.mastra', 'output');
const studioIndex = path.join(outDir, 'studio', 'index.html');
const mastraCli = path.join(projectRoot, 'node_modules', 'mastra', 'dist', 'index.js');

/** 仅在 bundle 已写入后再补 Studio，避免在 CLI 清空 output 时抢先写入子目录导致 rmdir ENOTEMPTY */
function ensureStudio() {
  try {
    if (!fs.existsSync(studioSrc)) return;
    if (fs.existsSync(studioIndex)) return;
    if (!fs.existsSync(outDir)) return;
    const bundleReady =
      fs.existsSync(path.join(outDir, 'index.mjs')) ||
      fs.existsSync(path.join(outDir, 'mastra.mjs'));
    if (!bundleReady) return;
    fs.cpSync(studioSrc, path.join(outDir, 'studio'), { recursive: true });
  } catch {
    // 与 bundler 并发时偶发失败，下轮 interval 重试
  }
}

const extraArgs = process.argv.slice(2);
const child = spawn(process.execPath, [mastraCli, 'dev', ...extraArgs], {
  stdio: 'inherit',
  cwd: projectRoot,
  env: process.env,
});

const interval = setInterval(ensureStudio, 1500);
ensureStudio();

function shutdown(signal) {
  clearInterval(interval);
  if (child.pid && !child.killed) {
    child.kill(signal);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

child.on('exit', (code, signal) => {
  clearInterval(interval);
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
