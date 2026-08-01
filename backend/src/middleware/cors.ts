import cors from 'cors';
import { config } from '../config/env';

const AUTHORIZATION_VERSION_HEADER = 'X-Portal-Authorization-Version';

export const corsConfig = cors({
  origin: config.corsOrigin,
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', AUTHORIZATION_VERSION_HEADER],
  exposedHeaders: [AUTHORIZATION_VERSION_HEADER],
});
