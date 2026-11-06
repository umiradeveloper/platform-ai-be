// Mock Hermes Agent API server untuk development/testing tanpa Hermes asli.
// Meniru: POST /v1/chat/completions (stream & non-stream), event `hermes.tool.progress`,
// GET /v1/models, GET /v1/capabilities, GET /health.
// Jalankan: node tools/mock-hermes.mjs   (PORT=8642, API_SERVER_KEY=test-hermes-key)
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8642);
const KEY = process.env.API_SERVER_KEY ?? 'test-hermes-key';
const MODEL = process.env.MODEL ?? 'hermes-agent';

const send = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

http
  .createServer(async (req, res) => {
    if (req.url === '/health' || req.url === '/v1/health') return send(res, 200, { status: 'ok' });
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(res, 401, { error: { message: 'Invalid API key' } });
    if (req.method === 'GET' && req.url === '/v1/models') {
      return send(res, 200, { object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'hermes-agent' }] });
    }
    if (req.method === 'GET' && req.url === '/v1/capabilities') {
      return send(res, 200, { object: 'hermes.api_server.capabilities', platform: 'hermes-agent', model: MODEL, auth_type: 'bearer', auth_required: true, chat_completions: true, chat_completions_streaming: true });
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let raw = '';
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      const last = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const reply = `**Hermes (mock)** menerima ${body.messages.length} pesan.\n\nPesan terakhir Anda: _${last.slice(0, 120)}_\n\n\`\`\`ts\nconsole.log('halo dari hermes');\n\`\`\``;
      const id = 'chatcmpl-mock';
      if (!body.stream) {
        return send(res, 200, { id, object: 'chat.completion', model: MODEL, choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 42, completion_tokens: 30, total_tokens: 72 } });
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const chunk = (delta, extra = {}) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let closed = false;
      res.on('close', () => (closed = true));
      chunk({ role: 'assistant' });
      if (/cari|search|web/i.test(last)) {
        // Format sama dengan Hermes asli: running → completed untuk toolCallId yang sama
        const tc = { tool: 'web_search', toolCallId: `toolu_mock_${Date.now()}` };
        res.write(`event: hermes.tool.progress\ndata: ${JSON.stringify({ ...tc, emoji: '🔍', label: last.slice(0, 60), status: 'running' })}\n\n`);
        await sleep(600);
        res.write(`event: hermes.tool.progress\ndata: ${JSON.stringify({ ...tc, status: 'completed' })}\n\n`);
      }
      res.write(': keepalive\n\n');
      for (const piece of reply.match(/.{1,12}/gs)) {
        if (closed) return;
        chunk({ content: piece });
        await sleep(Number(process.env.DELAY_MS ?? 25));
      }
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 42, completion_tokens: 30, total_tokens: 72 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    send(res, 404, { error: { message: 'not found' } });
  })
  .listen(PORT, () => console.log(`Mock Hermes Agent di http://localhost:${PORT}/v1 (key: ${KEY})`));
