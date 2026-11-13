'use strict';
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

// 只重排发往模型的请求副本，Codex 会话仍由 app-server 管理。
function reorderPreset(request, baseInstructions) {
  if (!Array.isArray(request.input)) throw new Error('模型请求缺少 input，无法定位预设。');
  const developers = [], history = [];
  for (const item of request.input) (item.role === 'developer' ? developers : history).push(item);
  const text = item => (item.content || []).map(part => part.text || '').join('\n');
  let index = developers.findLastIndex(item => item.type === 'message' && (
    text(item) === baseInstructions || (text(item).includes('<model_instructions>') && text(item).includes(baseInstructions))
  ));
  if (index < 0 && request.instructions === baseInstructions) {
    developers.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: request.instructions }] });
    delete request.instructions;
    index = developers.length - 1;
  }
  if (index < 0) throw new Error('无法定位当前预设基础指令，已停止发送，避免使用错误的消息顺序。');
  const [base] = developers.splice(index, 1);
  request.input = [...developers, base, ...history];
  return request;
}

function proxyFor(target) {
  if (['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) return null;
  const exclusions = (process.env.no_proxy || process.env.NO_PROXY || '').split(',').map(x => x.trim().toLowerCase());
  const host = target.hostname.toLowerCase();
  if (exclusions.some(entry => entry === '*' || entry === target.host.toLowerCase() || host === entry || host.endsWith('.' + entry.replace(/^\./, '')))) return null;
  const value = target.protocol === 'https:'
    ? process.env.https_proxy || process.env.HTTPS_PROXY || process.env.all_proxy || process.env.ALL_PROXY
    : process.env.http_proxy || process.env.HTTP_PROXY || process.env.all_proxy || process.env.ALL_PROXY;
  if (!value) return null;
  const proxy = new URL(value);
  if (!['http:', 'https:'].includes(proxy.protocol)) throw new Error('预设排序暂只支持 HTTP/HTTPS 上游代理。');
  return proxy;
}

function openUpstream(target, options, callback) {
  const transport = target.protocol === 'https:' ? https : http;
  const proxy = proxyFor(target);
  if (!proxy) return transport.request(target, options, callback);
  const proxyTransport = proxy.protocol === 'https:' ? https : http;
  const proxyHeaders = {};
  if (proxy.username || proxy.password) proxyHeaders['proxy-authorization'] = 'Basic ' + Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64');
  if (target.protocol === 'http:') return proxyTransport.request(proxy, { ...options, path: target.href, headers: { ...options.headers, host: target.host, ...proxyHeaders } }, callback);
  const agent = new https.Agent({ keepAlive: false });
  let connecting;
  agent.createConnection = (_options, done) => {
    let settled = false;
    const finish = (error, socket) => { if (!settled) { settled = true; done(error, socket); } };
    const tunnel = proxyTransport.request(proxy, { method: 'CONNECT', path: target.host + (target.port ? '' : ':443'), headers: { host: target.host, ...proxyHeaders } });
    connecting = tunnel;
    tunnel.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) { socket.destroy(); finish(new Error('上游代理拒绝连接。')); return; }
      if (head.length) socket.unshift(head);
      const secure = tls.connect({ socket, servername: target.hostname });
      connecting = secure;
      secure.once('secureConnect', () => { connecting = null; finish(null, secure); });
      secure.once('error', finish);
    });
    tunnel.once('error', finish); tunnel.setTimeout(30000, () => tunnel.destroy(new Error('上游代理连接超时。'))); tunnel.end();
  };
  const request = transport.request(target, { ...options, agent }, callback);
  request.once('close', () => { connecting?.destroy(); agent.destroy(); });
  return request;
}

const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
function cleanHeaders(source) {
  const headers = { ...source };
  for (const name of [...hopHeaders, ...(String(source.connection || '').toLowerCase().split(',').map(x => x.trim()))]) delete headers[name];
  return headers;
}
function decodeBody(body, encoding) {
  const options = { maxOutputLength: 128 * 1024 * 1024 };
  if (!encoding || encoding === 'identity') return body;
  if (encoding === 'gzip') return zlib.gunzipSync(body, options);
  if (encoding === 'deflate') return zlib.inflateSync(body, options);
  if (encoding === 'br') return zlib.brotliDecompressSync(body, options);
  if (encoding === 'zstd' && zlib.zstdDecompressSync) return zlib.zstdDecompressSync(body, options);
  throw new Error('当前 Node.js 无法解码模型请求的压缩格式：' + encoding);
}

async function createPresetGateway(upstreamUrl, baseInstructions) {
  const upstream = new URL(upstreamUrl);
  if (!['http:', 'https:'].includes(upstream.protocol)) throw new Error('预设排序需要 HTTP/HTTPS Responses 端点。');
  const prefix = '/' + crypto.randomBytes(24).toString('hex');
  const pending = new Set();
  const server = http.createServer(async (req, res) => {
    if (!req.url.startsWith(prefix + '/')) { res.writeHead(404); res.end(); return; }
    try {
      const chunks = []; let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 128 * 1024 * 1024) throw new Error('模型请求超过 128 MiB。');
        chunks.push(chunk);
      }
      const route = new URL(req.url.slice(prefix.length), 'http://localhost');
      const target = new URL(upstream);
      target.pathname = upstream.pathname.replace(/\/$/, '') + route.pathname;
      for (const [key, value] of route.searchParams) target.searchParams.append(key, value);
      let body = Buffer.concat(chunks);
      const headers = cleanHeaders(req.headers); delete headers.host;
      // 压缩请求只在内存中解码；流式响应直接转发，不记录正文或凭据。
      if (req.method === 'POST' && route.pathname.replace(/\/$/, '') === '/responses') {
        const parsed = JSON.parse(decodeBody(body, headers['content-encoding']).toString('utf8'));
        body = Buffer.from(JSON.stringify(reorderPreset(parsed, baseInstructions)));
        delete headers['content-encoding'];
      }
      headers['content-length'] = String(body.length);
      const forward = openUpstream(target, { method: req.method, headers }, response => {
        res.writeHead(response.statusCode, cleanHeaders(response.headers));
        response.on('error', () => res.destroy()); response.pipe(res);
      });
      pending.add(forward);
      forward.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('模型端点连接失败。'); } else res.destroy(); });
      forward.on('close', () => pending.delete(forward));
      res.on('close', () => { if (!res.writableFinished) forward.destroy(); });
      forward.end(body);
    } catch (error) {
      if (!res.headersSent) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: error.message, type: 'preset_order_error' } })); }
      else res.destroy();
    }
  });
  // 端点只提供 HTTP/SSE，WebSocket 客户端可立即回退，不悬挂升级连接。
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: 'http://127.0.0.1:' + server.address().port + prefix,
    close() { for (const request of pending) request.destroy(); server.close(); server.closeAllConnections(); },
  };
}

async function presetTransport(client, cwd, baseInstructions) {
  const { config } = await client.request('config/read', { cwd, includeLayers: false });
  const id = config.model_provider || 'openai';
  if (id === 'amazon-bedrock') throw new Error('预设精确排序暂不支持 Bedrock 签名传输。');
  const provider = config.model_providers?.[id] || {};
  let upstream = provider.base_url || (id === 'openai' && (config.openai_base_url || process.env.OPENAI_BASE_URL));
  if (!upstream) {
    const { account } = await client.request('account/read');
    upstream = account?.type === 'chatgpt' && (provider.requires_openai_auth || id === 'openai')
      ? (config.chatgpt_base_url || 'https://chatgpt.com/backend-api/').replace(/\/$/, '') + '/codex'
      : 'https://api.openai.com/v1';
  }
  const gateway = await createPresetGateway(upstream, baseInstructions);
  // 只覆盖本次会话的端点与传输；鉴权、模型和原有 provider 配置交给 Codex。
  const withoutNulls = value => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([, v]) => v != null).map(([key, v]) => [key, withoutNulls(v)])) : value;
  gateway.config = id === 'openai' ? {
    openai_base_url: gateway.url,
  } : {
    model_providers: {
      [id]: withoutNulls({ name: id, ...provider, base_url: gateway.url, supports_websockets: false }),
    },
  };
  gateway.config['features.enable_request_compression'] = false;
  return gateway;
}

module.exports = { reorderPreset, createPresetGateway, presetTransport };
