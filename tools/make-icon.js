'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const script = path.join(__dirname, '..', 'demo', 'make-icon.py');
execFileSync('python', [script], { stdio: 'inherit' });
