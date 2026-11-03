const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const HEARTBEAT_MS = 30 * 1000;

let wss = null;

// Pings every client so dead connections are dropped and proxies don't close idle ones.
const attach = (server) => {
  wss = new WebSocketServer({ server, path: '/api/ws' });

  wss.on('connection', (socket) => {
    // Clients send this id back as X-Client-Id so their own changes aren't echoed to them.
    socket.clientId = crypto.randomUUID();
    socket.send(JSON.stringify({ type: 'connected', clientId: socket.clientId }));

    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_MS);
  wss.on('close', () => clearInterval(heartbeat));
};

const broadcast = (message, excludeClientId) => {
  if (!wss) return;
  const data = JSON.stringify(message);
  for (const socket of wss.clients) {
    if (socket.readyState === WebSocket.OPEN && socket.clientId !== excludeClientId) socket.send(data);
  }
};

module.exports = { attach, broadcast };
