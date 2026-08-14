'use strict';
/* cloudflared 多镜像下载（断点续传 + 停滞检测），供 server.js 与下载脚本共用 */

const fs = require('fs');

// 可用性排序：国内镜像优先（直连 GitHub 常超时），续传优先
const URLS = [
  'https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
  'https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
  'https://ghfast.top/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
];

const STALL_MS = 45000;  // 45 秒无数据进展视为停滞，换源
const TOTAL_MS = 600000; // 单源最长 10 分钟

async function downloadCloudflared(dest) {
  fs.mkdirSync(require('path').dirname(dest), { recursive: true });
  let lastErr = '';
  for (const url of URLS) {
    console.log('尝试下载源: ' + url);
    const existing = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    if (existing > 0) console.log('  已有 ' + Math.round(existing / 1048576) + 'MB，断点续传…');
    const ac = new AbortController();
    let lastChunk = Date.now();
    const totalTimer = setTimeout(() => ac.abort(new Error('总超时')), TOTAL_MS);
    const stallTimer = setInterval(() => {
      if (Date.now() - lastChunk > STALL_MS) ac.abort(new Error('下载停滞'));
    }, 5000);
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: existing > 0 ? { Range: 'bytes=' + existing + '-' } : {},
        signal: ac.signal,
      });
      let append = false;
      if (res.status === 206) append = true;          // 续传
      else if (res.status === 200) { /* 从头下载 */ }
      else {
        lastErr = 'HTTP ' + res.status;
        console.log('  源不可用(' + lastErr + ')，换下一个…');
        continue;
      }
      const total = Number(res.headers.get('content-length')) || 0;
      const expected = (append ? existing : 0) + total;
      const reader = res.body.getReader();
      const out = fs.createWriteStream(dest, { flags: append ? 'a' : 'w' });
      let done = existing;
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        lastChunk = Date.now();
        done += r.value.length;
        if (!out.write(r.value)) await new Promise((r2) => out.once('drain', r2));
        const dl = done - existing;
        if (dl > 0 && dl % (5 * 1024 * 1024) < 65536) {
          console.log('  …' + Math.round(done / 1048576) + 'MB' + (expected ? '/' + Math.round(expected / 1048576) + 'MB' : ''));
        }
      }
      await new Promise((resolve, reject) => { out.end((err) => (err ? reject(err) : resolve())); });
      if (done < 1024 * 1024) {
        lastErr = '文件过小(' + Math.round(done / 1024) + 'KB)，疑似被拦截';
        console.log('  ' + lastErr);
        continue;
      }
      console.log('✅ cloudflared 下载完成: ' + Math.round(done / 1048576) + 'MB → ' + dest);
      return dest;
    } catch (e) {
      let why;
      if (e.name === 'AbortError') why = /停滞/.test(e.message) ? '下载停滞' : '超时';
      else why = (e.cause && e.cause.code) ? e.cause.code : e.message;
      lastErr = why;
      console.log('  下载失败: ' + why + '（已保留部分文件，下次自动续传）');
    } finally {
      clearTimeout(totalTimer);
      clearInterval(stallTimer);
    }
  }
  throw new Error('所有下载源均失败(' + lastErr + ')。手动方案：用浏览器下载 https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe ，改名为 cloudflared.exe 放入本程序 bin 目录，然后重新点"开启公网联机"。');
}

module.exports = { downloadCloudflared, URLS };
