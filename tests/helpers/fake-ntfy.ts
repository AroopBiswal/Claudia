import { createServer } from 'node:http';

export interface FakeNtfy {
  url: string;
  messages: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

export async function startFakeNtfy(opts?: { token?: string }): Promise<FakeNtfy> {
  const messages: Array<Record<string, unknown>> = [];
  let nextId = 1;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'POST' && url.pathname === '/') {
      if (opts?.token) {
        const auth = req.headers.authorization;
        if (auth !== `Bearer ${opts.token}`) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 401, error: 'unauthorized' }));
          return;
        }
      }

      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 400, error: 'invalid json' }));
          return;
        }

        const record: Record<string, unknown> = {
          ...parsed,
          id: `fake${nextId++}`,
          time: Math.floor(Date.now() / 1000),
          event: 'message',
        };
        messages.push(record);

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(record));
      });
      return;
    }

    const pollMatch = /^\/([^/]+)\/json$/.exec(url.pathname);
    if (req.method === 'GET' && pollMatch && url.searchParams.get('poll') === '1') {
      const topic = pollMatch[1];
      const lines = messages
        .filter((m) => m.topic === topic)
        .map((m) => JSON.stringify(m))
        .join('\n');
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(lines.length > 0 ? `${lines}\n` : '');
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 404, error: 'not found' }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake ntfy server failed to bind to a port');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    messages,
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
