import { Request, Response, NextFunction } from 'express';
import { logRequestError } from '../utils/errorLogger';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public isOperational = true
  ) {
    super(message);
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export function errorHandler(
  err: Error | AppError,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Log all errors to activity (non-blocking)
  const severity = (err instanceof AppError && err.statusCode < 500) ? 'ERROR' : 'CRITICAL' as const;
  logRequestError(err, req, { severity }).catch(() => {});

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.message,
      statusCode: err.statusCode,
    });
    return;
  }

  if (err.constructor?.name === 'ZodError') {
    res.status(400).json({
      error: 'Validation error',
      details: (err as any).errors,
    });
    return;
  }

  // Multer file upload errors (file too large, wrong type, etc.)
  if (err.constructor?.name === 'MulterError') {
    const multerErr = err as any;
    const messages: Record<string, string> = {
      LIMIT_FILE_SIZE: 'File is too large. Maximum size is 5 MB.',
      LIMIT_FILE_COUNT: 'Too many files.',
      LIMIT_FIELD_KEY: 'Field name too long.',
      LIMIT_FIELD_VALUE: 'Field value too long.',
      LIMIT_FIELD_COUNT: 'Too many fields.',
      LIMIT_UNEXPECTED_FILE: 'Unexpected file field.',
      LIMIT_PART_COUNT: 'Too many parts.',
    };
    res.status(413).json({
      error: messages[multerErr.code] || `Upload error: ${multerErr.message}`,
      code: multerErr.code,
    });
    return;
  }

  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
  });
}
