import express, { NextFunction, Request, Response } from 'express';
import type { INestApplication } from '@nestjs/common';

const UPLOAD_ROUTE_SUFFIX = '/demo-api/documents/content';

export function isRawUploadRoute(req: Pick<Request, 'method' | 'path'>): boolean {
  return req.method === 'PUT' && req.path.toLowerCase().replace(/\/+$/, '') === UPLOAD_ROUTE_SUFFIX;
}

export function configureBodyParsers(app: INestApplication): void {
  const jsonParser = express.json();
  const urlencodedParser = express.urlencoded({ extended: true });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (isRawUploadRoute(req)) {
      next();
      return;
    }
    jsonParser(req, res, next);
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (isRawUploadRoute(req)) {
      next();
      return;
    }
    urlencodedParser(req, res, next);
  });
}
