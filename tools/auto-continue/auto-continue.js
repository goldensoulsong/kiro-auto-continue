/**
 * Auto-Continue Proxy + kiro-rs 管理器
 * 
 * 整合功能：
 * 1. 自动启动 kiro-rs 后端
 * 2. 流式自动续写代理（max_tokens 截断 + 字数上限被动截断）
 * 3. Web 管理面板（开关、状态、配置）
 * 
 * 用法: node auto-continue.js
 * 
 * 端口分配：
 *   8991 - kiro-rs 后端（自动启动）
 *   8992 - 代理端口（酒馆连这个）
 *   8993 - 管理面板
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// 强制 stdout/stderr 使用 UTF-8，避免英文/日文等非 GBK 系统的 Windows 终端中文乱码
if (process.platform === 'win32') {
  try { process.stdout.setDefaultEncoding('utf8'); } catch (_) {}
  try { process.stderr.setDefaultEncoding('utf8'); } catch (_) {}
}

// ============================================================================
// 配置加载
// ============================================================================

const CONFIG_PATH = path.join(__dirname, 'config.json');
let config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

const TARGET_HOST = config.targetHost;
const TARGET_PORT = config.targetPort;
const LISTEN_PORT = config.listenPort;
const ADMIN_PORT = config.adminPort;

// 读取 kiro-rs 的 config.json，拿到 adminApiKey 用于反代到 kiro-rs 的 admin API
let kiroAdminApiKey = '';
try {
  const kiroConfigPath = path.resolve(__dirname, config.kiroConfig);
  if (fs.existsSync(kiroConfigPath)) {
    const kiroConfig = JSON.parse(fs.readFileSync(kiroConfigPath, 'utf-8'));
    kiroAdminApiKey = kiroConfig.adminApiKey || '';
  }
} catch (e) {
  console.error('[warn] 读取 kiro-rs config 失败：', e.message);
}

// 运行时状态（可通过管理面板修改）
let runtimeState = {
  enabled: config.enabled,
  maxContinuations: config.maxContinuations,
  continuePrompt: config.continuePrompt,
  truncateThreshold: config.truncateThreshold ?? 7600,
  debug: config.debug,
  // 限流配置（防封号）
  rateLimitEnabled: config.rateLimitEnabled ?? true,
  rateLimitWindowMs: config.rateLimitWindowMs ?? 60_000,
  rateLimitMaxRequests: config.rateLimitMaxRequests ?? 3,
  rateLimitOnExceed: config.rateLimitOnExceed ?? 'queue', // 'queue' | 'reject'
  rateLimitMaxQueue: config.rateLimitMaxQueue ?? 20,
  // IDE 互斥保护（防同号双客户端并发被风控）
  ideExclusiveEnabled: config.ideExclusiveEnabled ?? true,
  ideExclusiveCheckIntervalMs: config.ideExclusiveCheckIntervalMs ?? 10_000,
  ideDetected: false,
  ideBlockedReason: null,
  // 统计
  totalRequests: 0,
  totalContinuations: 0,
  totalRateLimited: 0,
  totalQueued: 0,
  totalIdeBlocked: 0,
  lastRequestTime: null,
  kiroRunning: false
};

// ============================================================================
// 限流（滑动窗口 + 串行队列）
// ============================================================================

const rl = {
  timestamps: [], // 最近窗口内允许进入的时间戳
  queue: [],      // 队列里的 callback
};

function rateLimitAcquire() {
  return new Promise((resolve, reject) => {
    if (!runtimeState.rateLimitEnabled) return resolve();

    const tryAcquire = () => {
      const now = Date.now();
      const windowStart = now - runtimeState.rateLimitWindowMs;
      // 清理过期时间戳
      while (rl.timestamps.length && rl.timestamps[0] < windowStart) {
        rl.timestamps.shift();
      }
      if (rl.timestamps.length < runtimeState.rateLimitMaxRequests) {
        rl.timestamps.push(now);
        return true;
      }
      return false;
    };

    if (tryAcquire()) return resolve();

    if (runtimeState.rateLimitOnExceed === 'reject') {
      runtimeState.totalRateLimited++;
      const retryAfterSec = Math.ceil(
        (rl.timestamps[0] + runtimeState.rateLimitWindowMs - Date.now()) / 1000
      );
      const err = new Error('rate_limit');
      err.retryAfter = Math.max(retryAfterSec, 1);
      return reject(err);
    }

    // queue 模式
    if (rl.queue.length >= runtimeState.rateLimitMaxQueue) {
      runtimeState.totalRateLimited++;
      const err = new Error('queue_full');
      err.retryAfter = 30;
      return reject(err);
    }
    runtimeState.totalQueued++;
    rl.queue.push({ tryAcquire, resolve });
  });
}

// 定时驱动队列：当一个时间槽过期，唤醒队头
setInterval(() => {
  if (!rl.queue.length) return;
  const head = rl.queue[0];
  if (head.tryAcquire()) {
    rl.queue.shift();
    head.resolve();
  }
}, 200);

function log(...args) {
  console.log(`[auto-continue]`, ...args);
}

function dbg(...args) {
  if (runtimeState.debug) console.log(`[debug]`, ...args);
}


// ============================================================================
// kiro-rs 进程管理
// ============================================================================

let kiroProcess = null;

function startKiro() {
  if (kiroProcess) {
    log('kiro-rs 已在运行');
    return;
  }

  // 互斥保护：启动前检测 Kiro IDE
  if (runtimeState.ideExclusiveEnabled) {
    // 同步阻塞一下确认；用同步 spawn 避免异步竞态
    const { execSync } = require('child_process');
    try {
      const out = execSync('tasklist /FI "IMAGENAME eq Kiro.exe" /FO CSV /NH', { windowsHide: true, timeout: 4000 }).toString();
      if (/^"Kiro\.exe"/m.test(out)) {
        runtimeState.ideDetected = true;
        runtimeState.ideBlockedReason = '检测到 Kiro IDE 正在运行（同号并发风控会封号）';
        log(`[互斥保护] 拒绝启动 kiro-rs：${runtimeState.ideBlockedReason}`);
        log(`[互斥保护] 请关闭 Kiro IDE 后再启动反代`);
        return;
      }
    } catch (e) {
      log(`[互斥保护] 检测异常（继续启动）：${e.message}`);
    }
    runtimeState.ideDetected = false;
    runtimeState.ideBlockedReason = null;
  }

  const exePath = path.resolve(__dirname, config.kiroExe);
  const configPath = path.resolve(__dirname, config.kiroConfig);
  const credPath = path.resolve(__dirname, config.kiroCredentials);

  if (!fs.existsSync(exePath)) {
    log(`错误: 找不到 kiro-rs: ${exePath}`);
    return;
  }

  log(`启动 kiro-rs: ${exePath}`);
  kiroProcess = spawn(exePath, ['-c', configPath, '--credentials', credPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: path.dirname(exePath)
  });

  kiroProcess.stdout.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      if (line.trim()) console.log(`[kiro-rs] ${line.trim()}`);
    }
  });

  kiroProcess.stderr.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      if (line.trim()) console.log(`[kiro-rs:err] ${line.trim()}`);
    }
  });

  kiroProcess.on('exit', (code) => {
    log(`kiro-rs 退出 (code: ${code})`);
    kiroProcess = null;
    runtimeState.kiroRunning = false;
  });

  runtimeState.kiroRunning = true;
}

function stopKiro() {
  if (kiroProcess) {
    log('停止 kiro-rs');
    kiroProcess.kill();
    kiroProcess = null;
    runtimeState.kiroRunning = false;
  }
}

// ============================================================================
// IDE 互斥保护：检测到 Kiro IDE 进程时停掉反代，避免同号并发触发封号
// ============================================================================

/**
 * 检测本机是否有 Kiro IDE (Kiro.exe) 进程在跑。
 * 排除自身和 kiro-rs.exe / kiro-tunnel 等同前缀进程。
 */
function detectKiroIde() {
  return new Promise((resolve) => {
    // tasklist 比 powershell 启动开销小很多
    const { exec } = require('child_process');
    exec('tasklist /FI "IMAGENAME eq Kiro.exe" /FO CSV /NH', { windowsHide: true, timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(false);
      // 只要输出里有一行 "Kiro.exe","..."  就是真的 IDE 在跑
      const found = /^"Kiro\.exe"/m.test(stdout);
      resolve(found);
    });
  });
}

let ideWatchTimer = null;

async function ideExclusiveCheckOnce(reason) {
  if (!runtimeState.ideExclusiveEnabled) {
    runtimeState.ideDetected = false;
    runtimeState.ideBlockedReason = null;
    return false;
  }
  const found = await detectKiroIde();
  runtimeState.ideDetected = found;
  if (found) {
    runtimeState.ideBlockedReason = reason || '检测到 Kiro IDE 正在运行';
    if (kiroProcess) {
      log(`[互斥保护] ${runtimeState.ideBlockedReason}，自动停止 kiro-rs`);
      stopKiro();
    }
    return true;
  } else {
    runtimeState.ideBlockedReason = null;
    return false;
  }
}

function startIdeWatcher() {
  if (ideWatchTimer) return;
  ideWatchTimer = setInterval(() => {
    ideExclusiveCheckOnce('运行中检测到 Kiro IDE 启动').catch(() => {});
  }, runtimeState.ideExclusiveCheckIntervalMs);
}

function stopIdeWatcher() {
  if (ideWatchTimer) {
    clearInterval(ideWatchTimer);
    ideWatchTimer = null;
  }
}

// ============================================================================
// SSE 工具函数
// ============================================================================

function extractTextFromSSE(sseChunk) {
  const lines = sseChunk.split('\n');
  let text = '';
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        const data = JSON.parse(line.slice(6));
        if (data.delta && data.delta.type === 'text_delta' && data.delta.text) {
          text += data.delta.text;
        }
      } catch {}
    }
  }
  return text;
}

function isMaxTokensStop(sseChunk) {
  const lines = sseChunk.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        const data = JSON.parse(line.slice(6));
        if (data.type === 'message_delta' && data.delta && data.delta.stop_reason === 'max_tokens') {
          return true;
        }
      } catch {}
    }
  }
  return false;
}

function hasMessageStop(sseChunk) {
  const lines = sseChunk.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        const data = JSON.parse(line.slice(6));
        if (data.type === 'message_stop') return true;
      } catch {}
    }
  }
  return false;
}

/**
 * 检查输出是否有正常的结束标记
 * 如果有这些标记，说明模型自然写完了，不需要续写
 */
function hasNormalEnding(text) {
  const trimmed = text.trimEnd();
  // 你的输出结构末尾应该有这些标记之一
  if (trimmed.endsWith('</StatusPlaceHolderImpl>')) return true;
  if (trimmed.endsWith('<StatusPlaceHolderImpl/>')) return true;
  if (trimmed.endsWith('</summary>')) return true;
  if (trimmed.endsWith('</UpdateVariable>')) return true;
  // 如果最后 200 字符里包含这些标记，也算正常结束
  const tail = trimmed.slice(-200);
  if (tail.includes('<StatusPlaceHolderImpl') || tail.includes('</summary>')) return true;
  return false;
}

function stripFinalEvents(sseChunk) {
  const events = sseChunk.split('\n\n');
  const filtered = events.filter(event => {
    if (!event.trim()) return false;
    const dataLine = event.split('\n').find(l => l.startsWith('data: '));
    if (!dataLine) return true;
    try {
      const data = JSON.parse(dataLine.slice(6));
      if (data.type === 'message_delta' || data.type === 'message_stop') return false;
      if (data.type === 'content_block_stop') return false;
    } catch {}
    return true;
  });
  return filtered.length > 0 ? filtered.join('\n\n') + '\n\n' : '';
}

function makeStreamRequestWithCallback(requestBody, headers, onChunk, onEnd, onError, urlPath) {
  const bodyStr = typeof requestBody === 'string' ? requestBody : JSON.stringify(requestBody);
  const fwdHeaders = { ...headers, host: `${TARGET_HOST}:${TARGET_PORT}`, 'content-length': Buffer.byteLength(bodyStr) };
  const reqOptions = {
    hostname: TARGET_HOST,
    port: TARGET_PORT,
    path: urlPath || '/v1/messages',
    method: 'POST',
    headers: fwdHeaders
  };

  const proxyReq = http.request(reqOptions, (proxyRes) => {
    proxyRes.setEncoding('utf-8');
    proxyRes.on('data', chunk => onChunk(chunk, proxyRes));
    proxyRes.on('end', () => onEnd(proxyRes));
  });

  proxyReq.on('error', onError);
  proxyReq.write(bodyStr);
  proxyReq.end();
  return proxyReq;
}

/**
 * 把 /kiro-admin/* 反代到 kiro-rs 的 /admin (UI) 与 /api/admin (API)
 * 自动注入 admin api key, 实现一站式管理且同源访问
 */
function proxyToKiro(req, res) {
  let raw = req.url.replace(/^\/kiro-admin/, '') || '/';

  // /kiro-admin/api/...  -> /api/admin/...   (kiro-rs admin API)
  // 其他                   -> /admin + path  (kiro-rs admin UI 静态资源)
  let targetPath;
  if (raw.startsWith('/api/')) {
    targetPath = '/api/admin' + raw.slice(4);
  } else {
    if (raw === '/') raw = '/';
    targetPath = '/admin' + (raw === '/' ? '' : raw);
  }

  const fwdHeaders = { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}` };
  // 自动注入 admin api key
  if (kiroAdminApiKey) {
    fwdHeaders['x-api-key'] = kiroAdminApiKey;
  }
  delete fwdHeaders['content-length'];

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (body.length) fwdHeaders['content-length'] = body.length;

    const reqOptions = {
      hostname: TARGET_HOST,
      port: TARGET_PORT,
      path: targetPath,
      method: req.method,
      headers: fwdHeaders
    };

    const proxyReq = http.request(reqOptions, (proxyRes) => {
      const respHeaders = { ...proxyRes.headers };
      // 移除会阻止 iframe 嵌入的安全头
      delete respHeaders['x-frame-options'];
      delete respHeaders['content-security-policy'];
      // 改写 admin UI 内的绝对路径，保持同源
      if (respHeaders['location']) {
        respHeaders['location'] = respHeaders['location']
          .replace(/^\/admin\b/, '/kiro-admin')
          .replace(/^\/api\/admin\b/, '/kiro-admin/api');
      }
      const ct = respHeaders['content-type'] || '';
      const isText = ct.includes('text/html') || ct.includes('javascript') || ct.includes('json');

      if (isText) {
        const buf = [];
        proxyRes.on('data', c => buf.push(c));
        proxyRes.on('end', () => {
          let body = Buffer.concat(buf).toString('utf-8');
          // admin UI 里的 /api/admin 调用要转成 /kiro-admin/api，让浏览器请求落回本服务器
          body = body
            .replace(/(["'])\/api\/admin/g, '$1/kiro-admin/api')
            .replace(/(["'])\/admin\//g, '$1/kiro-admin/');
          delete respHeaders['content-length'];
          delete respHeaders['content-encoding'];
          res.writeHead(proxyRes.statusCode, respHeaders);
          res.end(body);
        });
      } else {
        res.writeHead(proxyRes.statusCode, respHeaders);
        proxyRes.pipe(res);
      }
    });

    proxyReq.on('error', (err) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'kiro-rs unreachable', message: err.message }));
    });

    if (body.length) proxyReq.write(body);
    proxyReq.end();
  });
}


// ============================================================================
// 核心：流式自动续写
// ============================================================================

function handleStreamRequest(originalBody, headers, clientRes, urlPath) {
  const originalRequest = JSON.parse(originalBody);

  if (!originalRequest.stream) {
    passthrough(originalBody, headers, urlPath, clientRes);
    return;
  }

  if (!runtimeState.enabled) {
    passthroughStream(originalBody, headers, clientRes, urlPath);
    return;
  }

  runtimeState.totalRequests++;
  runtimeState.lastRequestTime = new Date().toISOString();
  log(`处理请求 #${runtimeState.totalRequests} (model: ${originalRequest.model}, msgs: ${originalRequest.messages.length})`);

  let continuationCount = 0;
  let allAccumulatedText = '';
  let headersSent = false;
  let currentChunkBuffer = '';

  function doRequest(requestBody) {
    currentChunkBuffer = '';

    makeStreamRequestWithCallback(
      requestBody,
      headers,
      // onChunk
      (chunk, proxyRes) => {
        if (!headersSent) {
          // 如果上游返回非 200，直接透传错误响应
          if (proxyRes.statusCode !== 200) {
            clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
            clientRes.write(chunk);
            return;
          }
          clientRes.writeHead(proxyRes.statusCode, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive'
          });
          headersSent = true;
        }

        currentChunkBuffer += chunk;
        const newText = extractTextFromSSE(chunk);
        if (newText && runtimeState.debug && allAccumulatedText.length < 200) {
          dbg(`首批文本: "${newText.slice(0, 100)}"`);
        }
        allAccumulatedText += newText;

        // max_tokens 截断 — 拦截结束事件
        if (isMaxTokensStop(chunk)) {
          dbg(`max_tokens 截断 (续写 ${continuationCount}/${runtimeState.maxContinuations})`);
          const stripped = stripFinalEvents(chunk);
          if (stripped) clientRes.write(stripped);
          return;
        }

        // 正常结束 — 直接透传
        if (hasMessageStop(chunk)) {
          clientRes.write(chunk);
          return;
        }

        clientRes.write(chunk);
      },
      // onEnd
      (proxyRes) => {
        // 非 200 响应直接结束
        if (proxyRes && proxyRes.statusCode !== 200) {
          clientRes.end();
          log(`上游返回 ${proxyRes.statusCode}，跳过续写`);
          return;
        }

        const needsContinuation =
          isMaxTokensStop(currentChunkBuffer) ||
          // 备用检测：流结束但没有 message_stop，说明被截断了
          (!hasMessageStop(currentChunkBuffer) && allAccumulatedText.length > 0) ||
          // 字数上限被动截断：超过用户设定阈值且没有正常结束标记
          (allAccumulatedText.length > runtimeState.truncateThreshold && !hasNormalEnding(allAccumulatedText));

        if (needsContinuation && continuationCount < runtimeState.maxContinuations) {
          continuationCount++;
          runtimeState.totalContinuations++;
          log(`续写 #${continuationCount} (累积 ${allAccumulatedText.length} 字符)`);

          const continuationRequest = buildContinuationRequest(originalRequest, allAccumulatedText);
          currentChunkBuffer = '';
          doRequest(JSON.stringify(continuationRequest));
        } else {
          // 真正结束
          if (!hasMessageStop(currentChunkBuffer)) {
            const outputTokens = Math.ceil(allAccumulatedText.length / 4);
            clientRes.write(`event: content_block_stop\ndata: {"index":0,"type":"content_block_stop"}\n\n`);
            clientRes.write(`event: message_delta\ndata: {"delta":{"stop_reason":"end_turn","stop_sequence":null},"type":"message_delta","usage":{"input_tokens":0,"output_tokens":${outputTokens}}}\n\n`);
            clientRes.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
          }
          clientRes.end();
          log(`完成 (续写: ${continuationCount}次, 输出: ${allAccumulatedText.length}字符)`);
        }
      },
      // onError
      (err) => {
        log(`错误: ${err.message}`);
        if (!headersSent) clientRes.writeHead(502, { 'content-type': 'application/json' });
        clientRes.end(JSON.stringify({ error: 'proxy_error', message: err.message }));
      },
      urlPath
    );
  }

  doRequest(originalBody);
}

function buildContinuationRequest(originalRequest, accumulatedText) {
  // 字数被动截断：正文输出到一半被截断，让模型严格接续
  const continuationPrompt = `[系统提示：以下是你之前生成的内容，由于输出字数上限被截断，并非完整内容：

<previously_generated>
${accumulatedText}
</previously_generated>

请严格接续上面被截断的内容继续输出。要求：
1. 从截断处的最后一个字精确续写
2. 不要重复任何已生成的内容
3. 不要重新开始
4. 不要输出思维链
5. 直接续写正文内容]`;

  return {
    ...originalRequest,
    messages: [
      ...originalRequest.messages,
      { role: 'assistant', content: [{ type: 'text', text: accumulatedText }] },
      { role: 'user', content: [{ type: 'text', text: continuationPrompt }] }
    ]
  };
}

function passthroughStream(body, headers, clientRes, urlPath) {
  const reqOptions = {
    hostname: TARGET_HOST, port: TARGET_PORT, path: urlPath || '/v1/messages',
    method: 'POST', headers: { ...headers, host: `${TARGET_HOST}:${TARGET_PORT}` }
  };
  const proxyReq = http.request(reqOptions, (proxyRes) => {
    clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(clientRes);
  });
  proxyReq.on('error', (err) => { clientRes.writeHead(502); clientRes.end(JSON.stringify({ error: err.message })); });
  proxyReq.write(body);
  proxyReq.end();
}

function passthrough(body, headers, urlPath, clientRes) {
  const reqOptions = {
    hostname: TARGET_HOST, port: TARGET_PORT, path: urlPath,
    method: 'POST', headers: { ...headers, host: `${TARGET_HOST}:${TARGET_PORT}` }
  };
  const proxyReq = http.request(reqOptions, (proxyRes) => {
    clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(clientRes);
  });
  proxyReq.on('error', (err) => { clientRes.writeHead(502); clientRes.end(JSON.stringify({ error: err.message })); });
  proxyReq.write(body);
  proxyReq.end();
}


// ============================================================================
// 管理面板 (Admin UI)
// ============================================================================

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>kiro-rs 统一管理面板</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e0e0e0; min-height: 100vh; display: flex; flex-direction: column; }
.topbar { background: #1a1d27; border-bottom: 1px solid #2a2d37; padding: 12px 24px; display: flex; align-items: center; gap: 16px; }
.topbar h1 { font-size: 1.1rem; color: #fff; font-weight: 600; }
.topbar .ports { color: #888; font-size: 0.8rem; margin-left: auto; }
.tabs { display: flex; background: #1a1d27; border-bottom: 1px solid #2a2d37; padding: 0 24px; }
.tab { padding: 12px 20px; cursor: pointer; color: #888; border-bottom: 2px solid transparent; font-size: 0.9rem; transition: 0.2s; }
.tab:hover { color: #ccc; }
.tab.active { color: #fff; border-bottom-color: #3b82f6; }
.content { flex: 1; overflow: auto; }
.tab-pane { display: none; }
.tab-pane.active { display: block; }
.tab-pane.iframe-pane { height: calc(100vh - 90px); }
.tab-pane.iframe-pane iframe { width: 100%; height: 100%; border: 0; background: #fff; }
.panel { max-width: 720px; margin: 0 auto; padding: 24px; }
.subtitle { color: #888; margin-bottom: 24px; font-size: 0.9rem; }
.card { background: #1a1d27; border: 1px solid #2a2d37; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
.card-title { font-size: 0.85rem; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; }
.status-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; }
.status-label { color: #aaa; }
.status-value { font-weight: 500; }
.status-value.on { color: #4ade80; }
.status-value.off { color: #f87171; }
.toggle { position: relative; width: 48px; height: 26px; cursor: pointer; }
.toggle input { opacity: 0; width: 0; height: 0; }
.toggle .slider { position: absolute; inset: 0; background: #333; border-radius: 13px; transition: 0.3s; }
.toggle .slider:before { content: ""; position: absolute; width: 20px; height: 20px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: 0.3s; }
.toggle input:checked + .slider { background: #4ade80; }
.toggle input:checked + .slider:before { transform: translateX(22px); }
.input-row { display: flex; align-items: center; gap: 12px; padding: 8px 0; }
.input-row label { color: #aaa; min-width: 120px; }
.input-row input { background: #0f1117; border: 1px solid #333; color: #fff; padding: 6px 10px; border-radius: 6px; width: 200px; }
.btn { padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-size: 0.85rem; transition: 0.2s; }
.btn-primary { background: #3b82f6; color: #fff; }
.btn-primary:hover { background: #2563eb; }
.btn-danger { background: #dc2626; color: #fff; }
.btn-danger:hover { background: #b91c1c; }
.btn-success { background: #16a34a; color: #fff; }
.btn-success:hover { background: #15803d; }
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.stat-box { text-align: center; padding: 12px; background: #0f1117; border-radius: 8px; }
.stat-num { font-size: 1.5rem; font-weight: 700; color: #fff; }
.stat-label { font-size: 0.75rem; color: #888; margin-top: 4px; }
.actions { display: flex; gap: 8px; margin-top: 12px; }
.empty-state { padding: 40px; text-align: center; color: #888; }
.empty-state .icon { font-size: 2rem; margin-bottom: 8px; }
</style>
</head>
<body>
<div class="topbar">
  <h1>kiro-rs 统一管理面板</h1>
  <div class="ports">代理 ${LISTEN_PORT} · 后端 ${TARGET_PORT} · 面板 ${ADMIN_PORT}</div>
</div>

<div class="tabs">
  <div class="tab active" data-tab="continue">自动续写 / 服务</div>
  <div class="tab" data-tab="kiro">凭据管理（kiro-rs）</div>
</div>

<div class="content">
<div class="tab-pane active" id="pane-continue">
<div class="panel">
<p class="subtitle">本地服务状态、自动续写开关与统计</p>

<div class="card">
  <div class="card-title">服务状态</div>
  <div class="status-row">
    <span class="status-label">kiro-rs 后端</span>
    <span class="status-value" id="kiro-status">--</span>
  </div>
  <div class="status-row">
    <span class="status-label">代理端口</span>
    <span class="status-value">${LISTEN_PORT}</span>
  </div>
  <div class="actions">
    <button class="btn btn-success" onclick="api('/start-kiro')">启动 kiro-rs</button>
    <button class="btn btn-danger" onclick="api('/stop-kiro')">停止 kiro-rs</button>
  </div>
</div>

<div class="card">
  <div class="card-title">自动续写</div>
  <div class="status-row">
    <span class="status-label">总开关</span>
    <label class="toggle"><input type="checkbox" id="toggle-enabled" onchange="toggle('enabled', this.checked)"><span class="slider"></span></label>
  </div>
  <div class="input-row">
    <label>字数触发阈值</label>
    <input type="number" id="input-threshold" value="" onchange="setVal('truncateThreshold', +this.value)">
  </div>
  <div class="input-row">
    <label>最大续写次数</label>
    <input type="number" id="input-max" value="" onchange="setVal('maxContinuations', +this.value)">
  </div>
  <div class="input-row">
    <label>续写提示词</label>
    <input type="text" id="input-prompt" value="" onchange="setVal('continuePrompt', this.value)">
  </div>
  <div class="status-row">
    <span class="status-label">调试日志</span>
    <label class="toggle"><input type="checkbox" id="toggle-debug" onchange="toggle('debug', this.checked)"><span class="slider"></span></label>
  </div>
</div>

<div class="card">
  <div class="card-title">限流防封 <span style="color:#888;font-weight:normal">（保护账号不被风控）</span></div>
  <div class="status-row">
    <span class="status-label">启用限流</span>
    <label class="toggle"><input type="checkbox" id="toggle-rl-enabled" onchange="toggle('rateLimitEnabled', this.checked)"><span class="slider"></span></label>
  </div>
  <div class="input-row">
    <label>窗口期 (秒)</label>
    <input type="number" id="input-rl-window" value="" onchange="setVal('rateLimitWindowMs', this.value * 1000)">
  </div>
  <div class="input-row">
    <label>窗口内最大次数</label>
    <input type="number" id="input-rl-max" value="" onchange="setVal('rateLimitMaxRequests', +this.value)">
  </div>
  <div class="input-row">
    <label>超额行为</label>
    <select id="input-rl-mode" onchange="setVal('rateLimitOnExceed', this.value)" style="background:#0f1117;border:1px solid #333;color:#fff;padding:6px 10px;border-radius:6px;width:200px">
      <option value="queue">排队等待</option>
      <option value="reject">直接拒绝 (429)</option>
    </select>
  </div>
</div>

<div class="card">
  <div class="card-title">IDE 互斥保护 <span style="color:#888;font-weight:normal">（防 IDE+反代同时跑被封号）</span></div>
  <div class="status-row">
    <span class="status-label">启用互斥</span>
    <label class="toggle"><input type="checkbox" id="toggle-ide-excl" onchange="toggle('ideExclusiveEnabled', this.checked)"><span class="slider"></span></label>
  </div>
  <div class="status-row">
    <span class="status-label">当前 IDE 状态</span>
    <span class="status-value" id="ide-state">--</span>
  </div>
  <div class="status-row" id="ide-block-row" style="display:none">
    <span class="status-label" style="color:#f87171">阻塞原因</span>
    <span class="status-value" id="ide-block-reason" style="color:#f87171">--</span>
  </div>
  <div style="color:#888;font-size:0.8rem;margin-top:8px;line-height:1.5">
    检测到 Kiro IDE 进程时自动停止反代。运行中每 \${runtimeState.ideExclusiveCheckIntervalMs / 1000}s 轮询一次（启动时同步检测）。
  </div>
</div>

<div class="card">
  <div class="card-title">统计</div>
  <div class="stats">
    <div class="stat-box"><div class="stat-num" id="stat-requests">0</div><div class="stat-label">总请求</div></div>
    <div class="stat-box"><div class="stat-num" id="stat-continuations">0</div><div class="stat-label">总续写</div></div>
    <div class="stat-box"><div class="stat-num" id="stat-last">--</div><div class="stat-label">最后请求</div></div>
  </div>
  <div class="stats" style="margin-top:8px">
    <div class="stat-box"><div class="stat-num" id="stat-queued">0</div><div class="stat-label">排队等过</div></div>
    <div class="stat-box"><div class="stat-num" id="stat-ratelimited">0</div><div class="stat-label">被拒次数</div></div>
    <div class="stat-box"><div class="stat-num" id="stat-ide-blocked">0</div><div class="stat-label">IDE 拦截</div></div>
  </div>
</div>
</div>
</div>

<div class="tab-pane iframe-pane" id="pane-kiro">
  <iframe id="kiro-iframe" src="about:blank" title="kiro-rs Admin"></iframe>
</div>
</div>

<script>
function api(path, body) {
  fetch(path, { method: 'POST', headers: {'content-type':'application/json'}, body: body ? JSON.stringify(body) : undefined })
    .then(r => r.json()).then(() => refresh());
}
function toggle(key, val) { api('/set', { [key]: val }); }
function setVal(key, val) { api('/set', { [key]: val }); }
function refresh() {
  fetch('/status').then(r => r.json()).then(s => {
    document.getElementById('kiro-status').textContent = s.kiroRunning ? '运行中' : '已停止';
    document.getElementById('kiro-status').className = 'status-value ' + (s.kiroRunning ? 'on' : 'off');
    document.getElementById('toggle-enabled').checked = s.enabled;
    document.getElementById('toggle-debug').checked = s.debug;
    document.getElementById('input-max').value = s.maxContinuations;
    document.getElementById('input-prompt').value = s.continuePrompt;
    document.getElementById('input-threshold').value = s.truncateThreshold;
    document.getElementById('toggle-rl-enabled').checked = s.rateLimitEnabled;
    document.getElementById('input-rl-window').value = s.rateLimitWindowMs / 1000;
    document.getElementById('input-rl-max').value = s.rateLimitMaxRequests;
    document.getElementById('input-rl-mode').value = s.rateLimitOnExceed;
    document.getElementById('toggle-ide-excl').checked = s.ideExclusiveEnabled;
    const ideEl = document.getElementById('ide-state');
    ideEl.textContent = s.ideDetected ? '运行中（已阻断）' : '未运行';
    ideEl.className = 'status-value ' + (s.ideDetected ? 'off' : 'on');
    document.getElementById('ide-block-row').style.display = s.ideDetected ? 'flex' : 'none';
    document.getElementById('ide-block-reason').textContent = s.ideBlockedReason || '--';
    document.getElementById('stat-requests').textContent = s.totalRequests;
    document.getElementById('stat-continuations').textContent = s.totalContinuations;
    document.getElementById('stat-queued').textContent = s.totalQueued;
    document.getElementById('stat-ratelimited').textContent = s.totalRateLimited;
    document.getElementById('stat-ide-blocked').textContent = s.totalIdeBlocked;
    document.getElementById('stat-last').textContent = s.lastRequestTime ? new Date(s.lastRequestTime).toLocaleTimeString() : '--';
  }).catch(() => {});
}

// Tab 切换
const tabs = document.querySelectorAll('.tab');
const panes = document.querySelectorAll('.tab-pane');
tabs.forEach(tab => tab.addEventListener('click', () => {
  const target = tab.dataset.tab;
  tabs.forEach(t => t.classList.toggle('active', t === tab));
  panes.forEach(p => p.classList.toggle('active', p.id === 'pane-' + target));
  if (target === 'kiro') {
    const iframe = document.getElementById('kiro-iframe');
    if (iframe.src === 'about:blank' || !iframe.src.includes('/kiro-admin')) {
      // 通过本地反代访问，避免跨端口的 storage 限制
      iframe.src = '/kiro-admin/';
    }
  }
}));

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;

const adminServer = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // 反代 /kiro-admin/* -> kiro-rs 的 /admin (UI) 与 /api/admin (API)
  // 自动注入 admin api key, 同源访问避免跨端口 storage 问题
  if (req.url.startsWith('/kiro-admin')) {
    proxyToKiro(req, res);
    return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/admin')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(ADMIN_HTML);
    return;
  }

  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(runtimeState));
    return;
  }

  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/set') {
      try {
        const updates = JSON.parse(body);
        for (const [k, v] of Object.entries(updates)) {
          if (k in runtimeState) runtimeState[k] = v;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/start-kiro') {
      startKiro();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && req.url === '/stop-kiro') {
      stopKiro();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });
});


// ============================================================================
// 代理服务器
// ============================================================================

const proxyServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk.toString(); });
  req.on('end', () => {
    const url = req.url;

    // GET 请求透传
    if (req.method === 'GET') {
      const reqOptions = {
        hostname: TARGET_HOST, port: TARGET_PORT, path: url,
        method: 'GET', headers: { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}` }
      };
      const proxyReq = http.request(reqOptions, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });
      proxyReq.on('error', (err) => { res.writeHead(502); res.end(JSON.stringify({ error: err.message })); });
      proxyReq.end();
      return;
    }

    // POST /v1/messages — 核心
    if (req.method === 'POST' && url.includes('/messages') && !url.includes('count_tokens')) {
      // 互斥保护：IDE 在跑就直接拒绝, 防止任何漏网请求
      if (runtimeState.ideExclusiveEnabled && runtimeState.ideDetected) {
        runtimeState.totalIdeBlocked++;
        log(`[互斥保护] 拒绝请求：${runtimeState.ideBlockedReason}`);
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type: 'forbidden',
            message: `已暂停（${runtimeState.ideBlockedReason}）。请关闭 Kiro IDE 后重启反代。`
          }
        }));
        return;
      }

      // 修正 URL：酒馆可能发 //messages，需要转为 /v1/messages
      let forwardUrl = url;
      if (!url.startsWith('/v1/') && !url.startsWith('/cc/v1/')) {
        forwardUrl = '/v1/messages';
      }
      log(`路由: ${req.method} ${url} -> ${forwardUrl}`);

      // 限流：进入实际请求前等一个许可
      rateLimitAcquire().then(() => {
        try {
          handleStreamRequest(body, req.headers, res, forwardUrl);
        } catch (e) {
          log(`[error] handleStreamRequest 异常: ${e.message}`);
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal_error', message: e.message }));
          }
        }
      }, err => {
        // 仅处理限流相关错误（rate_limit / queue_full）
        const status = err.message === 'queue_full' ? 503 : 429;
        log(`[限流] 请求被拒绝 (${err.message}, retry-after ${err.retryAfter}s)`);
        res.writeHead(status, {
          'content-type': 'application/json',
          'retry-after': String(err.retryAfter || 30)
        });
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type: err.message === 'queue_full' ? 'overloaded_error' : 'rate_limit_error',
            message: err.message === 'queue_full'
              ? '本地队列已满，请稍后重试（防封号限流）'
              : `本地限流: ${runtimeState.rateLimitMaxRequests} 次/${runtimeState.rateLimitWindowMs / 1000}秒`
          }
        }));
      });
      return;
    }

    // 其他 POST 透传
    passthrough(body, req.headers, url, res);
  });
});

// ============================================================================
// 启动
// ============================================================================

// 1. 启动 kiro-rs
startKiro();

// 2. 等 kiro-rs 启动后再开代理
setTimeout(() => {
  proxyServer.listen(LISTEN_PORT, '127.0.0.1', () => {
    log(`代理已启动: http://127.0.0.1:${LISTEN_PORT}`);
  });

  adminServer.listen(ADMIN_PORT, '127.0.0.1', () => {
    log(`管理面板: http://127.0.0.1:${ADMIN_PORT}`);
  });

  console.log(`\n${'='.repeat(50)}`);
  console.log(`  kiro-rs Auto-Continue 一键启动`);
  console.log(`${'='.repeat(50)}`);
  console.log(`  kiro-rs 后端:  http://127.0.0.1:${TARGET_PORT}`);
  console.log(`  代理端口:      http://127.0.0.1:${LISTEN_PORT}  ← 酒馆连这个`);
  console.log(`  管理面板:      http://127.0.0.1:${ADMIN_PORT}`);
  console.log(`${'='.repeat(50)}`);
  console.log(`  自动续写: ${runtimeState.enabled ? '✅ 开启' : '❌ 关闭'}`);
  console.log(`  字数阈值: ${runtimeState.truncateThreshold} 字`);
  console.log(`  最大续写: ${runtimeState.maxContinuations} 次`);
  console.log(`  限流防封: ${runtimeState.rateLimitEnabled ? `✅ ${runtimeState.rateLimitMaxRequests} 次/${runtimeState.rateLimitWindowMs / 1000}秒` : '❌ 关闭'}`);
  console.log(`  IDE 互斥: ${runtimeState.ideExclusiveEnabled ? `✅ 每${runtimeState.ideExclusiveCheckIntervalMs / 1000}秒检测` : '❌ 关闭'}`);
  console.log(`${'='.repeat(50)}\n`);

  // 启动 IDE 互斥保护后台监控
  if (runtimeState.ideExclusiveEnabled) {
    startIdeWatcher();
  }
}, 2000);

// 退出时清理
process.on('SIGINT', () => { stopIdeWatcher(); stopKiro(); process.exit(0); });
process.on('SIGTERM', () => { stopIdeWatcher(); stopKiro(); process.exit(0); });
process.on('exit', () => { stopIdeWatcher(); stopKiro(); });
