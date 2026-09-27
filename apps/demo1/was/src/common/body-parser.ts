import express, { NextFunction, Request, Response } from 'express';
import type { INestApplication } from '@nestjs/common';

const UPLOAD_ROUTE_SUFFIX = '/demo-api/documents/content';
const UPLOAD_PART_ROUTE = /^\/demo-api\/documents\/upload-sessions\/[^/]+\/parts\/[^/]+$/;

export function isRawUploadRoute(req: Pick<Request, 'method' | 'path'>): boolean {
  if (req.method !== 'PUT') {
    return false;
  }
  const path = req.path.toLowerCase().replace(/\/+$/, '');
  return path === UPLOAD_ROUTE_SUFFIX || UPLOAD_PART_ROUTE.test(path);
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
