declare module 'sanitize-html';
declare module 'geoip-lite';
declare module 'jsonwebtoken';
declare module 'bcrypt';
declare module 'cookie-parser';
declare module 'nodemailer';
declare module 'multer';
declare module 'compression';

declare global {
  namespace Express {
    namespace Multer {
      interface File {
        [key: string]: any;
      }
    }
    interface Request {
      file?: any;
      files?: any;
    }
  }
}

export {};
