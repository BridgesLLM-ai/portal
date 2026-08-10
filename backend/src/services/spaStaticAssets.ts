import express, { type RequestHandler } from 'express';

/**
 * Serve only immutable/static frontend files. SPA HTML deliberately falls
 * through to the server renderer so `/`, `/index.html`, and deep links all
 * receive request-specific branding before the browser paints.
 */
export function createSpaStaticAssetMiddleware(frontendDist: string): RequestHandler {
  const serveFrontendStatic = express.static(frontendDist, { index: false });
  return (req, res, next) => {
    if (req.path === '/index.html') return next();
    return serveFrontendStatic(req, res, next);
  };
}
