export interface User {
  id: string;
  email: string;
  username: string;
  role: 'OWNER' | 'SUB_ADMIN' | 'USER' | 'VIEWER';
  accountStatus?: 'ACTIVE' | 'PENDING' | 'DISABLED' | 'BANNED';
  sandboxEnabled?: boolean;
}

export interface AuthResponse {
  user: User;
  accessToken?: string;
  refreshToken?: string;
}

export interface File {
  id: string;
  userId: string;
  path: string;
  size: bigint;
  mimeType?: string;
  visibility: 'PRIVATE' | 'SHARED' | 'PUBLIC';
  createdAt: string;
  updatedAt: string;
}

export interface App {
  id: string;
  userId: string;
  name: string;
  description?: string;
  zipPath: string;
  isPublic: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Metrics {
  id: string;
  timestamp: string;
  cpuUsage: number;
  memoryUsage: number;
  memoryTotal: bigint;
  diskUsage: number;
  diskTotal: bigint;
  networkIn: bigint;
  networkOut: bigint;
  processCount: number;
  loadAverage: number[];
}

export interface ActivityLog {
  id: string;
  userId?: string;
  action: string;
  resource: string;
  resourceId?: string;
  translatedMessage?: string;
  severity: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  createdAt: string;
  metadata?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
}
