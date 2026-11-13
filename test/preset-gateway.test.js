'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { reorderPreset, createPresetGateway, presetTransport } = require('../preset-gateway');
const message = (role, text) => ({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] });

test('预设必须紧邻第一条 user 之前，其他历史、工具调用和说明保持相对顺序', () => {
  const tools = { type: 'additional_tools', role: 'developer', tools: [] };
  const base = message('developer', '旧预设');
  const rules = message('developer', '运行约定');
  const project = message('user', '项目说明');
  const seed = message('assistant', '示例');
  const call = { type: 'function_call', call_id: 'call_1', name: 'test', arguments: '{}' };
  const output = { type: 'function_call_output', call_id: 'call_1', output: '结果' };
  const update = message('developer', '<model_instructions>新预设</model_instructions>');
  const actual = message('user', '真实消息');
  const request = { model: 'test', input: [tools, base, rules, project, seed, call, output, update, actual], reasoning: { effort: 'high' } };
  reorderPreset(request, '新预设');
  assert.deepEqual(request.input, [tools, base, rules, update, project, seed, call, output, actual]);
  assert.deepEqual(request.reasoning, { effort: 'high' });
  assert.throws(() => reorderPreset({ input: [rules, actual] }, '不存在的预设'), /无法定位/);
  const topLevel = reorderPreset({ instructions: '预设', input: [tools, rules, actual] }, '预设');
  assert.equal(topLevel.instructions, undefined);
  assert.deepEqual(topLevel.input, [tools, rules, message('developer', '预设'), actual]);
});

test('本机网关保留鉴权、查询参数和响应，解压请求且不改压缩接口', async () => {
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Test-Response': 'preserved' }); res.end('{"ok":true}');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const gateway = await createPresetGateway('http://127.0.0.1:' + upstream.address().port + '/v1?origin=1', '预设');
  try {
    const body = JSON.stringify({ input: [message('developer', '预设'), message('developer', '运行约定'), message('user', '真实消息')] });
    const encodings = [['gzip', zlib.gzipSync], ...(zlib.zstdCompressSync ? [['zstd', zlib.zstdCompressSync]] : [])];
    for (const [encoding, compress] of encodings) {
      const result = await fetch(gateway.url + '/responses?api-version=synthetic', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': encoding, Authorization: 'Bearer LOCAL_TEST_ONLY' }, body: compress(Buffer.from(body)) });
      assert.equal(result.status, 200); assert.equal(result.headers.get('X-Test-Response'), 'preserved');
      assert.equal(await result.text(), '{"ok":true}');
      const request = received.at(-1);
      assert.equal(request.url, '/v1/responses?origin=1&api-version=synthetic');
      assert.equal(request.headers.authorization, 'Bearer LOCAL_TEST_ONLY');
      assert.equal(request.headers['content-encoding'], undefined);
      assert.equal(JSON.parse(request.body).input[1].content[0].text, '预设');
    }
    const compact = '{"input":[],"instructions":"保持原样的压缩请求"}';
    const result = await fetch(gateway.url + '/responses/compact', { method: 'POST', body: compact });
    await result.text(); assert.equal(received.at(-1).body, compact);
    const previous = received.length;
    const rejected = await fetch(gateway.url + '/responses', { method: 'POST', body: '{"input":[]}' });
    assert.equal(rejected.status, 400); assert.equal(received.length, previous);
    assert.match(await rejected.text(), /无法定位/);
    const hidden = await fetch(new URL('/wrong-path/responses', gateway.url));
    assert.equal(hidden.status, 404); await hidden.text();
  } finally { gateway.close(); await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }); }
});

test('网关即时转发流式响应，不等待整段回复', async () => {
  let release;
  const upstream = http.createServer(async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: first\n\n');
    await new Promise(resolve => { release = resolve; }); res.end('data: done\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const gateway = await createPresetGateway('http://127.0.0.1:' + upstream.address().port, '预设');
  try {
    const result = await fetch(gateway.url + '/responses', { method: 'POST', body: JSON.stringify({ input: [message('developer', '预设'), message('user', '你好')] }) });
    const reader = result.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n');
    release();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: done\n\n');
    assert.equal((await reader.read()).done, true);
  } finally { release?.(); gateway.close(); await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }); }
});

test('ChatGPT 与 API 登录保留内置 provider，只覆盖当前会话的传输配置', async () => {
  for (const type of ['chatgpt', 'apiKey']) {
    const client = { request: async method => method === 'config/read' ? { config: { chatgpt_base_url: 'http://127.0.0.1/backend-api/' } } : { account: { type } } };
    const gateway = await presetTransport(client, process.cwd(), '预设');
    try {
      assert.equal(gateway.config.openai_base_url, gateway.url);
      assert.equal(gateway.config['features.enable_request_compression'], false);
    } finally { gateway.close(); }
  }
});
