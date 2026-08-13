import type { AuthContext } from '../modules/auth/auth.types';
import type { MasterContext } from '../modules/master/master.types';

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      master?: MasterContext;
      validated?: {
        query?: unknown;
        params?: unknown;
      };
    }
  }
}

export {};
