const path = require('path');
const { app, session } = require('electron');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

app.whenReady().then(async () => {
  try {
    await session.defaultSession.setProxy({ mode: 'system' });
    console.log('proxy set system');
    const { testConnection } = require('../src/agent/config');
    const res = await testConnection('typesafe', {});
    console.log('TEST_RESULT', JSON.stringify(res));
    app.exit(res.success ? 0 : 2);
  } catch (e) {
    console.error('TEST_FATAL', e && (e.stack || e.message || e));
    app.exit(3);
  }
});
