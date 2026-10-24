'use strict';
const { app, session } = require('electron');
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const ses = session.fromPartition(`memory:d${Math.random()}`, { cache: false });
  for (const url of ['https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf','https://www.orimi.com/pdf-test.pdf']) {
    try {
      const r = await ses.fetch(url, { redirect: 'follow', headers: { accept: '*/*' } });
      const buf = Buffer.from(await r.arrayBuffer());
      console.log(url, r.status, r.headers.get('content-type'), buf.length, JSON.stringify(buf.subarray(0,8).toString('latin1')));
    } catch (e) { console.log(url, 'ERR', e.message); }
  }
  app.exit(0);
});
