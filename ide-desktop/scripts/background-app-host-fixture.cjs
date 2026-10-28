'use strict';
require('./lib/probe-guard.cjs');

const { BackgroundAppService } = require('../electron/background-app.cjs');
const service = new BackgroundAppService({ executable: require('electron') });
service.execute({ sessionId: 'host-fixture', workspaceRoot: process.argv[2], tool: 'background_app_open', input: { path: 'host-exit' } })
  .then(result => { if (process.connected) process.send(result); });
