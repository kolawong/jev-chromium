/** Local, read-only acceptance fixtures for testing the visible app with real models. */
const http = require('node:http');
const css = '<style>body{font:18px system-ui;max-width:780px;margin:48px auto;color:#202938}article{padding:24px;border:1px solid #ddd;border-radius:12px}a,button,select,input{font:inherit;padding:10px;margin:8px}</style>';
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  let body;
  if (url.pathname === '/a') body = '<title>青松键盘</title><article><h1>青松键盘</h1><p>名称：青松键盘</p><p>价格：199 元</p><p>库存：12 件</p></article><a href="/">返回产品目录</a>';
  else if (url.pathname === '/b') body = '<title>白桦鼠标</title><article><h1>白桦鼠标</h1><p>名称：白桦鼠标</p><p>价格：89 元</p><p>此产品暂未提供库存信息。</p></article><a href="/">返回产品目录</a>';
  else if (url.pathname === '/filter') body = `<title>航司筛选测试</title><h1>航班列表</h1><label>航空公司<select id="airline"><option>全部航司</option><option>南方航空</option><option>东方航空</option></select></label><div id="results"></div><script>
    const flights=[['南方航空','CZ1234'],['东方航空','MU5678']];
    const update=()=>results.innerHTML=flights.filter(f=>airline.value==='全部航司'||f[0]===airline.value).map(f=>'<p>'+f.join(' ')+'</p>').join('');
    airline.onchange=update;update();
  </script>`;
  else body = '<title>产品目录</title><h1>产品目录</h1><p>目录共 2 款产品，价格与库存请打开各自详情页查看。</p><a href="/a">青松键盘详情</a><a href="/b">白桦鼠标详情</a><p><a href="/filter">航司筛选测试</a></p>';
  res.end('<!doctype html><meta charset="utf-8">' + css + body);
});
server.listen(Number(process.env.PORT || 4178), '127.0.0.1', () => {
  console.log(`测试页面：http://127.0.0.1:${server.address().port}`);
});
