'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { CodexBackend } = require('../codex-backend');
const { CodexClient, seedItems, PERMISSIONS } = require('../codex-client');

test('预设的 assistant 保持真实角色及 output_text 类型', () => {
  assert.deepEqual(seedItems([{ role: 'user', content: '示例问题' }, { role: 'assistant', content: '示例回答' }]), [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '示例问题' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '示例回答' }] },
  ]);
  assert.equal(PERMISSIONS.workspace.sandbox, 'workspace-write');
  assert.equal(PERMISSIONS.workspace.approvalPolicy, 'on-request');
  assert.equal(PERMISSIONS.readOnly.sandbox, 'read-only');
});

test('真实 Codex → 本地假模型：替换、历史、恢复、编辑及关闭预设', { skip: !process.env.CODEX_WEB_INTEGRATION, timeout: 120000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-web-test-'));
  const project = path.join(temp, 'project'); fs.mkdirSync(project);
  const home = path.join(temp, 'home'); fs.mkdirSync(home);
  const oldHome = process.env.CODEX_HOME;
  const oldKeys = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, CODEX_API_KEY: process.env.CODEX_API_KEY };
  const requests = [];
  const requestHeaders = [];
  const upstream = http.createServer(async (req, res) => {
    let body = ''; for await (const d of req) body += d;
    try {
      const parsed = JSON.parse(body);
      if (!req.url.includes('responses')) { res.writeHead(404); return res.end(); }
      requests.push(parsed);
      requestHeaders.push(req.headers);
    } catch { res.writeHead(404); return res.end(); }
    if (body.includes('HTTP_STREAM_SENTINEL')) await new Promise(resolve => setTimeout(resolve, 200));
    const message = { id: 'msg_' + requests.length, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '测试回复 ' + requests.length, annotations: [] }], phase: 'final_answer' };
    const response = { id: 'resp_' + requests.length, object: 'response', status: 'completed', output: [message], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25, input_tokens_details: { cached_tokens: 0 } } };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    for (const event of [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: message.id, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: message.content[0].text },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response },
    ]) res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
    res.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(home, 'config.toml'), `model = "gpt-6.1-sol"\nmodel_provider = "test_local"\nweb_search = "disabled"\n[features]\napps = false\nmulti_agent = false\n[model_providers.test_local]\nname = "Local test"\nbase_url = "http://127.0.0.1:${upstream.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
  process.env.CODEX_HOME = home;
  const backend = new CodexBackend(path.join(temp, 'data'), 'WEB_TEST_GUIDANCE');
  let sessionId;
  const run = async options => {
    const r = backend.start({ cwd: project, message: 'FIRST_REAL_USER', attachments: [], permissionMode: 'readOnly', ...options });
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('运行超时：' + r.lines.join('\n'))), 45000);
      const check = () => { if (r.done) { clearTimeout(deadline); clearInterval(interval); resolve(); } };
      const interval = setInterval(check, 30); check();
    });
    const events = r.lines.map(x => JSON.parse(x));
    assert.deepEqual(events.filter(x => x.type === 'web_error'), [], r.lines.join('\n'));
    sessionId = r.sessionId;
    assert.ok(events.some(x => x.method === 'item/agentMessage/delta'));
    return r;
  };
  try {
    const preset = { systemField: 'REPLACED_SYSTEM_SENTINEL', seedTurns: [{ role: 'user', content: 'SEED_USER_SENTINEL' }, { role: 'assistant', content: 'SEED_ASSISTANT_SENTINEL' }], historyHead: 'HISTORY_HEAD_SENTINEL' };
    const systemText = request => {
      if (request.instructions) return request.instructions;
      const messages = request.input.filter(x => x.type === 'message' && ['system', 'developer'].includes(x.role));
      // 恢复会话时，Codex 用 model_instructions 明确声明替换旧版基础指令。
      return JSON.stringify(messages.findLast(x => JSON.stringify(x.content).includes('<model_instructions>'))?.content || messages.at(-1)?.content);
    };
    const png = path.join(project, 'test.png');
    fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAIklEQVR4nOzLsQkAAAwCQQnZf+V3BkvB6+8BJU6hhYWeYAAAAP//2x1wRAAAAAZJREFUAwBenQMgeDhLVwAAAABJRU5ErkJggg==', 'base64'));
    await run({ assembled: preset, attachments: [{ path: png, name: 'test.png' }] });
    const firstDeveloperMessages = requests[0].input.filter(x => x.type === 'message' && x.role === 'developer');
    assert.ok(JSON.stringify(firstDeveloperMessages.at(-1)).includes('REPLACED_SYSTEM_SENTINEL'));
    assert.ok(!firstDeveloperMessages.some(x => JSON.stringify(x).includes('You are Codex')));
    assert.equal(firstDeveloperMessages.filter(x => JSON.stringify(x).includes('REPLACED_SYSTEM_SENTINEL')).length, 1);
    const assertPresetPosition = request => {
      const firstUser = request.input.findIndex(x => x.role === 'user');
      assert.ok(firstUser > 0);
      assert.equal(request.input[firstUser - 1].role, 'developer');
      assert.ok(!request.input.slice(firstUser).some(x => x.role === 'developer'));
    };
    assertPresetPosition(requests[0]);
    assert.ok(systemText(requests[0]).includes('REPLACED_SYSTEM_SENTINEL'), JSON.stringify(requests[0].input.map(x=>({type:x.type,role:x.role,content:JSON.stringify(x.content || "").slice(0,100)}))));
    assert.ok(!systemText(requests[0]).includes('You are Codex'));
    assert.ok(requests[0].input.some(x => x.role === 'assistant' && JSON.stringify(x).includes('SEED_ASSISTANT_SENTINEL')));
    assert.ok(JSON.stringify(requests[0].input).includes('HISTORY_HEAD_SENTINEL'));
    assert.ok(JSON.stringify(requests[0].input).includes('input_image'), JSON.stringify(requests[0].input.filter(x=>x.role === 'user')).slice(-1500));
    const history = await backend.history(project, sessionId);
    assert.deepEqual(history.filter(x => x.kind === 'user').map(x => x.text), ['FIRST_REAL_USER']);
    assert.equal(history.find(x => x.kind === 'user').images.length, 1);
    assert.ok(!JSON.stringify(history).includes('SEED_ASSISTANT_SENTINEL'));
    await run({ sessionId, message: 'SECOND_REAL_USER', assembled: { ...preset, systemField: 'UPDATED_SYSTEM_SENTINEL' } });
    assert.ok(systemText(requests[1]).includes('UPDATED_SYSTEM_SENTINEL'), systemText(requests[1]).slice(0,2000));
    assertPresetPosition(requests[1]);
    assert.equal(requests[1].input.filter(x => x.role === 'assistant' && JSON.stringify(x).includes('SEED_ASSISTANT_SENTINEL')).length, 1);
    await run({ sessionId, message: 'THIRD_REAL_USER', assembled: null });
    assert.ok(!systemText(requests[2]).includes('UPDATED_SYSTEM_SENTINEL'));
    assert.ok(systemText(requests[2]).includes('You are Codex'));
    const all = await backend.history(project, sessionId);
    const target = all.filter(x => x.kind === 'user')[1].uuid;
    await run({ sessionId, message: 'EDITED_SECOND_USER', rewindTo: target, assembled: null });
    const edited = await backend.history(project, sessionId);
    assert.deepEqual(edited.filter(x => x.kind === 'user').map(x => x.text), ['FIRST_REAL_USER', 'EDITED_SECOND_USER']);
    await backend.rename(project, sessionId, '集成测试');
    assert.ok((await backend.listSessions(project)).some(s => s.title === '集成测试'));
    // 无示例预设也必须位于最后一条 developer，且连续发送时不重复追加基础指令。
    const previousSession = sessionId;
    const noSeeds = { ...preset, seedTurns: [] };
    await run({ message: 'NO_SEEDS_FIRST', assembled: noSeeds });
    const withoutSeeds = sessionId;
    const noSeedsFirst = requests.at(-1);
    assert.ok(systemText(noSeedsFirst).includes('REPLACED_SYSTEM_SENTINEL'));
    assert.ok(!noSeedsFirst.input.some(x => x.role === 'assistant'));
    await run({ sessionId: withoutSeeds, message: 'NO_SEEDS_SECOND', assembled: noSeeds });
    assert.equal(requests.at(-1).input.filter(x => x.role === 'developer' && JSON.stringify(x).includes('REPLACED_SYSTEM_SENTINEL')).length, 1);
    const noSeedsFirstTurn = (await backend.history(project, withoutSeeds)).find(x => x.kind === 'user').uuid;
    await run({ sessionId: withoutSeeds, message: 'NO_SEEDS_EDITED_FIRST', assembled: noSeeds, rewindTo: noSeedsFirstTurn });
    assert.ok(systemText(requests.at(-1)).includes('REPLACED_SYSTEM_SENTINEL'));
    await run({ sessionId: withoutSeeds, message: 'NO_SEEDS_OFF', assembled: null });
    assert.ok(systemText(requests.at(-1)).includes('You are Codex'));
    await backend.delete(project, withoutSeeds);
    sessionId = previousSession;
    // 内置 OpenAI provider 同样经过网关，API key 仍由 Codex 提供；只使用合成凭据。
    const configFile = path.join(home, 'config.toml');
    const customConfig = fs.readFileSync(configFile, 'utf8');
    fs.writeFileSync(configFile, 'cli_auth_credentials_store = "file"\n' + customConfig);
    process.env.OPENAI_API_KEY = 'LOCAL_TEST_KEY'; process.env.CODEX_API_KEY = 'LOCAL_TEST_KEY';
    const login = new CodexClient({ cwd: project });
    try { await login.ready; await login.request('account/login/start', { type: 'apiKey', apiKey: 'LOCAL_TEST_KEY' }); }
    finally { login.close(); }
    fs.writeFileSync(configFile, `cli_auth_credentials_store = "file"\nmodel = "gpt-6.1-sol"\nopenai_base_url = "http://127.0.0.1:${upstream.address().port}/v1"\nweb_search = "disabled"\n[features]\napps = false\napi_key_model_discovery = false\napi_key_cyber_access_programs = false\n`);
    try {
      await run({ message: 'BUILTIN_PROVIDER', assembled: noSeeds });
      assertPresetPosition(requests.at(-1));
      assert.equal(requestHeaders.at(-1).authorization, 'Bearer LOCAL_TEST_KEY');
      await backend.delete(project, sessionId);
    } finally {
      sessionId = previousSession;
      fs.writeFileSync(configFile, customConfig);
      for (const [key, value] of Object.entries(oldKeys)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
    // 完整经过 HTTP 层：客户端断开后，原任务继续运行，按序号重连补齐。
    const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--cwd', project, '--port', '0', '--no-open'], { windowsHide: true, env: { ...process.env, CODEX_WEB_DATA: path.join(temp, 'http-data') }, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const base = await new Promise((resolve, reject) => {
        let log = ''; const timer = setTimeout(() => reject(new Error('HTTP 启动超时：' + log)), 5000);
        app.stdout.on('data', d => { log += d; const m = log.match(/http:\/\/127\.0\.0\.1:\d+/); if (m) { clearTimeout(timer); resolve(m[0]); } });
        app.on('error', reject);
      });
      const response = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: project, message: 'HTTP_STREAM_SENTINEL', permissionMode: 'readOnly' }) });
      assert.equal(response.status, 200);
      const runId = response.headers.get('X-Run-Id'); await response.body.cancel();
      const busy = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: project, message: '不能并行' }) });
      assert.equal(busy.status, 409);
      const replay = await (await fetch(base + '/api/attach?run=' + runId + '&from=0')).text();
      const lines = replay.trim().split('\n'); const events = lines.map(x=>JSON.parse(x));
      assert.ok(events.some(x=>x.method === 'item/agentMessage/delta'));
      const end = events.find(x=>x.type === 'web_done'); assert.ok(end);
      assert.ok(!events.some(x=>x.type === 'web_error'), replay);
      const suffix = await (await fetch(base + '/api/attach?run=' + runId + '&from=2')).text();
      assert.equal(suffix.trim(), lines.slice(2).join('\n'));
      const deletion = await fetch(base + '/api/session?' + new URLSearchParams({ cwd: project, id: end.sessionId }), { method: 'DELETE' });
      assert.equal(deletion.status, 200);
    } finally { app.kill(); await new Promise(resolve => app.once('exit', resolve)); }
    console.log('已验证真实 Codex 请求中的系统指令、assistant 角色、预设更新和关闭、会话恢复、历史隐藏、回溯与重命名。');
  } finally {
    if (sessionId) await backend.delete(project, sessionId).catch(() => {});
    backend.close();
    if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
    for (const [key, value] of Object.entries(oldKeys)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await new Promise(resolve => upstream.close(resolve));
    // 临时目录只属于本测试，不接触用户真实 Codex 会话。
    await new Promise(resolve => setTimeout(resolve, 1800));
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 4 });
  }
});
