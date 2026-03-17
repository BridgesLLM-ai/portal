import { Server as SocketIOServer } from 'socket.io';
import { spawn as ptySpawn } from 'node-pty';
import { verifyAccessToken } from '../utils/jwt';
import { prisma } from '../config/database';
import { canUseInteractivePortal, isElevatedRole } from '../utils/authz';

function parseCookies(cookieHeader: string): Record<string, string> {
  return cookieHeader.split(';').reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return acc;
    const key = part.slice(0, idx).trim();
    const value = decodeURIComponent(part.slice(idx + 1).trim());
    acc[key] = value;
    return acc;
  }, {} as Record<string, string>);
}

export function setupTerminalNamespace(io: SocketIOServer) {
  const terminal = io.of('/terminal');

  terminal.use((socket, next) => {
    let token = socket.handshake.auth?.token;

    if (!token || typeof token !== 'string') {
      const cookieHeader = socket.handshake.headers?.cookie || '';
      const cookies = parseCookies(cookieHeader);
      token = cookies.accessToken;
    }

    if (!token || typeof token !== 'string') {
      return next(new Error('Authentication required'));
    }

    const payload = verifyAccessToken(token);
    if (!payload) {
      return next(new Error('Invalid or expired token'));
    }

    prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, email: true, role: true, accountStatus: true, isActive: true },
    } as any).then((user) => {
      if (!user || !canUseInteractivePortal(user.role, (user as any).accountStatus, user.isActive) || !isElevatedRole(user.role)) {
        return next(new Error('Account is not permitted for terminal access'));
      }

      (socket as any).user = { userId: user.id, email: user.email, role: user.role };
      next();
    }).catch((err) => next(err));
  });

  terminal.on('connection', (socket) => {
    console.log(`Terminal connected: ${(socket as any).user?.userId}`);

    const cols = parseInt(socket.handshake.query?.cols as string) || 80;
    const rows = parseInt(socket.handshake.query?.rows as string) || 24;

    let pty: ReturnType<typeof ptySpawn>;

    try {
      {
        // Direct bash — portal runs on host as systemd service
        pty = ptySpawn('bash', ['-l'], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: process.env.HOME || '/root',
          env: {
            ...process.env,
            TERM: 'xterm-256color',
          } as Record<string, string>,
        });
        console.log('Terminal: local bash mode (no SSH key found)');
      }
    } catch (error) {
      console.error('Failed to spawn pty:', error);
      socket.emit('output', '\r\nFailed to start terminal session.\r\n');
      socket.disconnect();
      return;
    }

    pty.onData((data: string) => {
      socket.emit('output', data);
    });

    pty.onExit(({ exitCode }: { exitCode: number }) => {
      socket.emit('output', `\r\nProcess exited with code ${exitCode}\r\n`);
      socket.disconnect();
    });

    socket.on('input', (data: string) => {
      try {
        pty.write(data);
      } catch {
        // pty already closed
      }
    });

    socket.on('resize', (size: { cols: number; rows: number }) => {
      try {
        pty.resize(
          Math.max(1, Math.min(500, size.cols)),
          Math.max(1, Math.min(200, size.rows))
        );
      } catch {
        // ignore
      }
    });

    socket.on('disconnect', () => {
      console.log(`Terminal disconnected: ${(socket as any).user?.userId}`);
      try {
        pty.kill();
      } catch {
        // already dead
      }
    });
  });
}
