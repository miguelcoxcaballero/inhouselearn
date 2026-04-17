import { mkdirSync, existsSync, rmSync, copyFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const agentDir = resolve(process.cwd());
const stageDir = join(agentDir, '.stage');
const releasesDir = resolve(agentDir, '..', 'releases');
const serverSource = join(agentDir, 'server.js');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: agentDir,
    stdio: 'inherit',
    shell: false,
    ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with code ${result.status}`);
  }
}

function ensureClean(dir) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function prettySize(filePath) {
  const bytes = statSync(filePath).size;
  const mb = bytes / (1024 * 1024);
  return mb.toFixed(1) + ' MB';
}

async function buildWindowsExe() {
  const exeName = 'inhouse-agent.exe';
  const stageExe = join(stageDir, exeName);
  const seaConfigPath = join(stageDir, 'sea-config.json');
  const blobPath = join(stageDir, 'sea-prep.blob');

  writeFileSync(seaConfigPath, JSON.stringify({
    main: serverSource,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false
  }, null, 2), 'utf8');

  console.log('▸ Generando blob SEA...');
  run(process.execPath, ['--experimental-sea-config', seaConfigPath]);

  console.log('▸ Copiando binario de Node a ' + exeName + '...');
  copyFileSync(process.execPath, stageExe);

  // En Windows el binario de Node viene firmado; al inyectar el blob la firma
  // queda inválida. Intentamos quitarla con signtool si está disponible (opcional).
  if (process.platform === 'win32') {
    const signtool = spawnSync('where', ['signtool'], { encoding: 'utf8' });
    if (signtool.status === 0 && signtool.stdout.trim()) {
      console.log('▸ Quitando firma original del binario...');
      spawnSync('signtool', ['remove', '/s', stageExe], { stdio: 'inherit' });
    } else {
      console.log('  (signtool no disponible — saltamos el paso de quitar firma, no es crítico)');
    }
  }

  console.log('▸ Inyectando blob con postject...');
  let postjectBin;
  try {
    postjectBin = require.resolve('postject/dist/cli.js');
  } catch (err) {
    throw new Error('postject no está instalado. Ejecuta: npm install --save-dev postject');
  }
  run(process.execPath, [
    postjectBin,
    stageExe,
    'NODE_SEA_BLOB',
    blobPath,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
  ]);

  const finalPath = join(releasesDir, exeName);
  copyFileSync(stageExe, finalPath);
  console.log('✓ ' + exeName + ' (' + prettySize(finalPath) + ') -> ' + finalPath);
  return finalPath;
}

async function main() {
  ensureClean(stageDir);
  mkdirSync(releasesDir, { recursive: true });

  await buildWindowsExe();

  // Limpiamos releases antiguos que ya no queremos servir.
  for (const stale of [
    'inhouse-agent-windows.zip',
    'inhouse-agent-linux.zip',
    'inhouse-agent-macos.zip',
    'inhouse-agent-setup.exe'
  ]) {
    const stalePath = join(releasesDir, stale);
    if (existsSync(stalePath)) {
      rmSync(stalePath, { force: true });
      console.log('✗ eliminado release antiguo: ' + stale);
    }
  }

  if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });

  console.log('\nListo. El único artefacto es ' + join(releasesDir, 'inhouse-agent.exe'));
  console.log('UX final para el usuario: click en descargar -> doble click en el .exe -> listo.');
}

main().catch((err) => {
  console.error('Fallo construyendo el release:', err);
  process.exit(1);
});
