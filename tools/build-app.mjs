// Package xMonkey as a double-clickable macOS .app.
//
// Why a hand-written packager instead of electron-builder: the whole point is a
// reproducible, dependency-free build. This copies the locally installed Electron
// runtime, swaps in our app, rewrites the bundle identity, installs the icon and
// ad-hoc signs the result. No network, no extra toolchain, ~15 seconds.
//
// Usage:
//   node tools/build-app.mjs            # build into dist/xMonkey.app
//   node tools/build-app.mjs --dist     # also copy to /Applications
//   node tools/build-app.mjs --out DIR

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const OUT_DIR = path.resolve(ROOT, opt('--out', 'dist'));
const APP_NAME = 'xMonkey';

function log(msg) { console.log(`• ${msg}`); }
function must(cond, msg) { if (!cond) { console.error(`✗ ${msg}`); process.exit(1); } }

// ---------------------------------------------------------------- checks

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const electronDir = path.join(ROOT, 'node_modules', 'electron', 'dist');
must(fs.existsSync(electronDir),
  'Electron is not installed. Run `npm install` first.');
const electronApp = path.join(electronDir, 'Electron.app');
must(fs.existsSync(electronApp), `Electron.app not found in ${electronDir}`);

const iconSrc = path.join(ROOT, 'app', 'assets', 'icon.icns');
if (!fs.existsSync(iconSrc)) {
  log('icon missing, generating it');
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'make-icon.mjs')], { cwd: ROOT, stdio: 'inherit' });
}
must(fs.existsSync(iconSrc), 'icon.icns could not be produced');

// ---------------------------------------------------------------- copy runtime

const outApp = path.join(OUT_DIR, `${APP_NAME}.app`);
log(`cleaning ${path.relative(ROOT, outApp)}`);
fs.rmSync(outApp, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

log('copying the Electron runtime (this is the slow part)');
fs.cpSync(electronApp, outApp, {
  recursive: true,
  verbatimSymlinks: true,
  // Do not carry Electron's own default_app bundle.
  filter: (src) => !src.includes(path.join('Resources', 'default_app.asar')),
});

const res = path.join(outApp, 'Contents', 'Resources');
const macos = path.join(outApp, 'Contents', 'MacOS');
const frameworks = path.join(outApp, 'Contents', 'Frameworks');

// ---------------------------------------------------------------- our app

log('installing xMonkey source into the bundle');
const appDir = path.join(res, 'app');
fs.mkdirSync(appDir, { recursive: true });

const INCLUDE = ['app', 'src', 'bin', 'package.json', 'LICENSE', 'README.md', 'xmonkey.config.json'];
// app/assets/fonts is git-ignored (Anthropic's proprietary faces) but MUST be in
// the bundle, or the UI silently falls back to Georgia and stops matching.
const FONT_DIR = path.join(ROOT, 'app', 'assets', 'fonts');
for (const item of INCLUDE) {
  const from = path.join(ROOT, item);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, path.join(appDir, item), {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}node_modules${path.sep}`) && !src.endsWith('.DS_Store'),
  });
}

if (!fs.existsSync(FONT_DIR) || fs.readdirSync(FONT_DIR).filter((f) => f.endsWith('.woff2')).length === 0) {
  console.warn('! app/assets/fonts is empty — the UI will fall back to system serif/sans.');
  console.warn('  Copy the Anthropic variable fonts from the Claude Desktop extraction:');
  console.warn('  see docs/FONTS.md');
}

// The bundle's package.json must point at the Electron entry, and must NOT list
// the electron devDependency (the runtime is already here).
const appPkg = {
  name: 'xmonkey',
  productName: APP_NAME,
  version: pkg.version,
  description: pkg.description,
  main: 'app/main.mjs',
  type: 'module',
  license: pkg.license,
};
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(appPkg, null, 2));

// Rename the executable so the process shows as xMonkey in Activity Monitor and
// in the Dock. The helper apps also need their inner binary renamed.
log('renaming the executable');
const exeOld = path.join(macos, 'Electron');
const exeNew = path.join(macos, APP_NAME);
if (fs.existsSync(exeOld)) fs.renameSync(exeOld, exeNew);

const helperApps = fs.readdirSync(frameworks).filter((f) => f.endsWith('.app'));
for (const helper of helperApps) {
  const hDir = path.join(frameworks, helper);
  const hMac = path.join(hDir, 'Contents', 'MacOS');
  const hOld = path.join(hMac, 'Electron');
  if (!fs.existsSync(hOld)) continue;
  // "Electron Helper (Renderer).app" -> "xMonkey Helper (Renderer).app"
  const newName = helper.replace(/^Electron/, APP_NAME);
  const hNew = path.join(hMac, newName.replace(/\.app$/, ''));
  fs.renameSync(hOld, hNew);
  const newDir = path.join(frameworks, newName);
  fs.renameSync(hDir, newDir);
}

// ---------------------------------------------------------------- bundle identity

log('writing Info.plist');
const plist = path.join(outApp, 'Contents', 'Info.plist');
const pbCapture = (...a) => {
  try {
    return { ok: true, out: execFileSync('/usr/libexec/PlistBuddy', ['-c', ...a, plist], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (err) {
    return { ok: false, err: String(err.stderr || err.message) };
  }
};
// `Set` fails on an ABSENT key and `Add` fails on a PRESENT one, so decide from
// the plist itself rather than from an exception (both signals are Exit 1).
const hasKey = (key) => pbCapture(`Print :${key}`).ok;
const set = (key, value) => {
  const v = String(value);
  if (hasKey(key)) {
    if (!pbCapture(`Set :${key}`, v).ok) pbCapture(`Delete :${key}`), pbCapture(`Add :${key} string ${v}`);
  } else {
    pbCapture(`Add :${key} string ${v}`);
  }
  if (!hasKey(key)) throw new Error(`could not set ${key} in Info.plist`);
};
set('CFBundleExecutable', APP_NAME);
set('CFBundleName', APP_NAME);
set('CFBundleDisplayName', APP_NAME);
set('CFBundleIdentifier', 'com.xmonkey.app');
set('CFBundleShortVersionString', pkg.version);
set('CFBundleVersion', pkg.version);
set('CFBundleIconFile', 'icon.icns');
set('LSApplicationCategoryType', 'public.app-category.developer-tools');
set('NSHighResolutionCapable', 'true');
try { pb('Delete :ElectronAsarIntegrity'); } catch { /* not present */ }

// Icon
fs.copyFileSync(iconSrc, path.join(res, 'icon.icns'));
// Remove Electron's default icons so ours is the only candidate.
for (const f of fs.readdirSync(res)) {
  if (/^electron\.icns$|^default_app/.test(f)) fs.rmSync(path.join(res, f), { force: true });
}

// Every helper must point at its own renamed binary, or the app crashes on
// launch with "helper executable not found".
for (const f of fs.readdirSync(frameworks)) {
  if (!f.endsWith('.app')) continue;
  const hPlist = path.join(frameworks, f, 'Contents', 'Info.plist');
  if (!fs.existsSync(hPlist)) continue;
  const base = f.replace(/\.app$/, '');
  const hb = (...a) => execFileSync('/usr/libexec/PlistBuddy', ['-c', ...a, hPlist], { stdio: 'ignore' });
  try { hb('Set :CFBundleExecutable', base); } catch { /* older layout */ }
  try { hb('Set :CFBundleName', base); } catch { /* older layout */ }
  try { hb('Set :CFBundleIdentifier', `com.xmonkey.app.${base.replace(/[^A-Za-z0-9.]/g, '-')}`); } catch { /* older layout */ }
}

// ---------------------------------------------------------------- sign

log('ad-hoc signing');
function sign(target) {
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', target], { stdio: 'pipe' });
}
try {
  // Sign nested helpers first, then the outer bundle: --deep is convenient but
  // ordering matters for verification on newer macOS.
  for (const f of fs.readdirSync(frameworks)) {
    if (f.endsWith('.app')) sign(path.join(frameworks, f));
  }
  sign(outApp);
} catch (err) {
  console.warn('! codesign failed (the app will still run locally):', err.message);
}

// ---------------------------------------------------------------- verify

log('verifying the bundle');
must(fs.existsSync(path.join(macos, APP_NAME)), 'executable missing after rename');
must(fs.existsSync(path.join(appDir, 'app', 'main.mjs')), 'app/main.mjs missing from the bundle');
must(fs.existsSync(path.join(appDir, 'src', 'core', 'loop.mjs')), 'src/ missing from the bundle');
const size = dirSize(outApp);
log(`built ${path.relative(process.cwd(), outApp)} (${(size / 1024 / 1024).toFixed(0)} MB)`);

if (flag('--dist')) {
  const dest = path.join('/Applications', `${APP_NAME}.app`);
  log(`installing to ${dest}`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(outApp, dest, { recursive: true, verbatimSymlinks: true });
  log('installed. Double-click it in /Applications, or run: open /Applications/xMonkey.app');
}

console.log(`\nDouble-click: ${outApp}`);
console.log(`Or: open "${outApp}"`);

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; } catch { /* race */ } }
    }
  };
  walk(dir);
  return total;
}
