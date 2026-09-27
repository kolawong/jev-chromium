require('dotenv').config();
const { app, BrowserWindow, WebContentsView } = require('electron');
const { SNAPSHOT_SCRIPT } = require('../src/agent/snapshot');
const { choose } = require('../src/agent/model');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 900 });
  const view = new WebContentsView();
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1440, height: 900 });

  await view.webContents.loadURL('https://www.baidu.com/s?wd=OpenAI%20%E6%96%B0%E9%97%BB');
  await new Promise(r => setTimeout(r, 2000));

  const page = await view.webContents.executeJavaScript(SNAPSHOT_SCRIPT);
  const goal = '我想找明天 12 点从深圳飞上海的航班';
  console.log('Total actions observed:', page.actions.length);

  const searchBox = page.actions.find(a => /搜索|kw|wd/i.test(a.label) || a.id === 'e1');
  console.log('Search box action:', searchBox);

  const decision = await choose(page, goal, []);
  console.log('Decision choice:', decision.choice);
  console.log('Decision operation:', decision.operation);
  console.log('Decision confidence:', decision.confidence);
  console.log('Operation probabilities:', decision.operation_probabilities);

  app.quit();
});
