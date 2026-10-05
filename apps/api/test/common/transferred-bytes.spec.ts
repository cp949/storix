import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolveTransferredBytes } from '../../src/common/transferred-bytes.js';

describe('resolveTransferredBytes', () => {
  // 같은 keep-alive 소켓을 공유하는 요청을 흉내 낸다.
  function fakeExchange(socket: { bytesRead: number; bytesWritten: number }) {
    return { request: { socket }, response: {} };
  }

  it('같은 소켓의 직전 응답 이후 읽고 쓴 바이트를 합한다', () => {
    const socket = { bytesRead: 120, bytesWritten: 300 };
    const first = fakeExchange(socket);
    expect(resolveTransferredBytes(first.request, first.response)).toBe(420);

    socket.bytesRead = 150;
    socket.bytesWritten = 1300;
    const second = fakeExchange(socket);
    expect(resolveTransferredBytes(second.request, second.response)).toBe(30 + 1000);
  });

  it('같은 응답을 여러 번 물어도 처음 계산한 값을 돌려준다', () => {
    const socket = { bytesRead: 10, bytesWritten: 20 };
    const exchange = fakeExchange(socket);
    expect(resolveTransferredBytes(exchange.request, exchange.response)).toBe(30);
    socket.bytesRead = 99;
    expect(resolveTransferredBytes(exchange.request, exchange.response)).toBe(30);
  });

  it('소켓이 없으면 undefined다', () => {
    expect(resolveTransferredBytes({ socket: null }, {})).toBeUndefined();
  });

  describe('실제 HTTP 소켓', () => {
    let server: http.Server;
    let port: number;
    const measured: Array<Promise<number | undefined>> = [];

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        measured.push(
          new Promise((resolve) => res.once('close', () => resolve(resolveTransferredBytes(req, res)))),
        );
        req.resume();
        req.on('end', () => {
          res.setHeader('Content-Length', '1000');
          if (req.method === 'HEAD') res.end();
          else res.end(Buffer.alloc(1000));
        });
      });
      server.listen(0);
      await once(server, 'listening');
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    });

    async function send(method: string, body?: Buffer): Promise<number | undefined> {
      const before = measured.length;
      await new Promise<void>((resolve, reject) => {
        const req = http.request({ port, method, path: '/', headers: { 'Transfer-Encoding': 'chunked' } });
        req.on('response', (res) => {
          res.resume();
          res.on('end', resolve);
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
      });
      while (measured.length === before) await new Promise((resolve) => setImmediate(resolve));
      return measured[before];
    }

    it('Content-Length 없는 chunked 업로드는 업로드 바이트를 포함한다', async () => {
      expect(await send('POST', Buffer.alloc(200_000))).toBeGreaterThan(200_000);
    });

    it('HEAD는 보내지 않은 본문 길이(Content-Length)를 세지 않는다', async () => {
      expect(await send('HEAD')).toBeLessThan(1000);
    });
  });
});
