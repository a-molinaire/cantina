// Genera le icone PNG della PWA da tools/icon.html usando Edge headless.
// Uso: node tools/make-icons.mjs
// Edge non sa rendere finestre sotto ~500px: si rende la 512 e le altre si ricavano ridimensionando.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const src = pathToFileURL(join(root, 'tools', 'icon.html')).href;
const outDir = join(root, 'icons');
const out = join(outDir, 'icon-512.png');
mkdirSync(outDir, { recursive: true });
rmSync(out, { force: true });

execFileSync(edge, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  '--window-size=512,512', '--virtual-time-budget=8000', `--screenshot=${out}`, src,
], { stdio: 'ignore' });

// Edge può finire di scrivere il file dopo essere uscito
for (let i = 0; i < 50 && !(existsSync(out) && statSync(out).size > 0); i++) {
  await new Promise(r => setTimeout(r, 200));
}
if (!existsSync(out)) throw new Error('icon-512.png non generata');
console.log('creato icons/icon-512.png');

execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'tools', 'resize-icons.ps1')], { stdio: 'inherit' });
