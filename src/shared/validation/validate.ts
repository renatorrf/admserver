import type { Request, RequestHandler } from 'express';
import type { ZodType } from 'zod';

export function validateBody(schema: ZodType): RequestHandler {
  return (request, _response, next) => {
    void schema.parseAsync(request.body).then((body: unknown) => {
      request.body = body;
      next();
    }).catch(next);
  };
}

export function validateQuery(schema: ZodType): RequestHandler {
  return (request, _response, next) => {
    void schema.parseAsync(request.query).then((query: unknown) => {
      request.validated = { ...request.validated, query };
      next();
    }).catch(next);
  };
}

export function validateParams(schema: ZodType): RequestHandler {
  return (request, _response, next) => {
    void schema.parseAsync(request.params).then((params: unknown) => {
      request.validated = { ...request.validated, params };
      next();
    }).catch(next);
  };
}

export function getValidatedQuery<T>(request: Request): T {
  return request.validated?.query as T;
}

export function getValidatedParams<T>(request: Request): T {
  return request.validated?.params as T;
}
