'use strict';

/**
 * 手工打包为 Windows 免安装目录版：
 *  - 复制 node_modules/electron/dist 作为运行时
 *  - 把应用代码打成 resources/app.asar
 *  - electron.exe 改名为 GitDesk.exe，并写入图标与版本信息
 */

const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
const { version } = require('../package.json');

const root = path.join(__dirname, '..');
const stage = path.join(root, 'tools', '.stage');
const outRoot = path.join(root, 'dist');
const appDir = path.join(outRoot, 'GitDesk-win32-x64');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');

function rm(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copy(src, dst) {
  fs.cpSync(src, dst, { recursive: true });
}

async function main() {
  if (!fs.existsSync(electronDist)) throw new Error('找不到 electron 运行时：' + electronDist);
  rm(stage);
  rm(appDir);
  fs.mkdirSync(stage, { recursive: true });

  for (const item of ['main.js', 'preload.js', 'package.json', 'lib', 'renderer']) {
    copy(path.join(root, item), path.join(stage, item));
  }

  fs.mkdirSync(appDir, { recursive: true });
  copy(electronDist, appDir);

  const asarPath = path.join(appDir, 'resources', 'app.asar');
  await asar.createPackage(stage, asarPath);
  rm(path.join(appDir, 'resources', 'default_app.asar'));
  rm(path.join(appDir, 'version'));

  const exe = path.join(appDir, 'GitDesk.exe');
  fs.renameSync(path.join(appDir, 'electron.exe'), exe);

  try {
    setExeMetadata(exe);
    console.log('RPEDIT_OK 图标与版本信息已写入');
  } catch (e) {
    console.error('RPEDIT_FAIL 图标/版本写入失败（不影响运行）：', e.message);
  }

  rm(stage);
  const size = dirSize(appDir);
  console.log('PACK_OK ' + exe);
  console.log('SIZE_MB ' + (size / 1024 / 1024).toFixed(1));
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    }
  };
  walk(dir);
  return total;
}

function setExeMetadata(exePath) {
  const ResEdit = require('resedit');
  const data = fs.readFileSync(exePath);
  const exe = ResEdit.NtExecutable.from(data, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  const icoPath = path.join(root, 'renderer', 'icon.ico');
  if (fs.existsSync(icoPath)) {
    const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
    const icons = iconFile.icons.map((i) => i.data);
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, icons);
  }

  const langs = new Set();
  try {
    const viList = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
    if (viList.length) langs.add(viList[0].lang || 1033);
  } catch { /* 没有版本信息就新建 */ }
  const lang = langs.size ? [...langs][0] : 1033;

  let vi;
  const list = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (list.length) {
    vi = list[0];
  } else {
    vi = ResEdit.Resource.VersionInfo.createEmpty();
  }
  const [major, minor, patch] = version.split('.').map(Number);
  vi.setFileVersion(major, minor, patch, 0);
  vi.setProductVersion(major, minor, patch, 0);
  vi.setStringValues(
    { lang, codepage: 1200 },
    {
      CompanyName: 'GitDesk',
      FileDescription: 'GitDesk - 本地 Git 面板',
      ProductName: 'GitDesk',
      OriginalFilename: 'GitDesk.exe',
      InternalName: 'GitDesk',
      LegalCopyright: '',
    }
  );
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
}

main().catch((e) => {
  console.error('PACK_FAIL', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
