'use strict';

/** 用 API 打包，便于看到真实错误 */

const packager = require('@electron/packager');
const path = require('node:path');
const { version } = require('../package.json');

const root = path.join(__dirname, '..');

packager({
  dir: root,
  name: 'GitDesk',
  productName: 'GitDesk',
  platform: 'win32',
  arch: 'x64',
  out: path.join(root, 'dist'),
  overwrite: true,
  appVersion: version,
  buildVersion: version,
  asar: true,
  icon: path.join(root, 'renderer', 'icon.ico'),
  ignore: [/^\/(test|tools|dist|demo|\.git|\.env[^/]*)(\/|$)/],
  prune: true,
  quiet: false,
})
  .then((paths) => {
    console.log('PACK_OK', paths.join(', '));
  })
  .catch((e) => {
    console.error('PACK_FAIL', e && e.stack ? e.stack : e);
    process.exitCode = 1;
  });
