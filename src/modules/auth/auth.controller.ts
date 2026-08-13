import type { Request, Response } from 'express';

import type { AuthApplication } from './auth.service';
import { requireAuthContext } from './auth.middleware';
import type { LoginInput, RefreshInput } from './auth.schemas';

export class AuthController {
  constructor(private readonly auth: AuthApplication) {}

  companies = async (_request: Request, response: Response): Promise<void> => {
    response.status(200).json({ data: await this.auth.listCompanies() });
  };

  login = async (request: Request, response: Response): Promise<void> => {
    const result = await this.auth.login(request.body as LoginInput);
    response.status(200).json({ data: result });
  };

  refresh = async (request: Request, response: Response): Promise<void> => {
    const result = await this.auth.refresh(request.body as RefreshInput);
    response.status(200).json({ data: result });
  };

  logout = async (request: Request, response: Response): Promise<void> => {
    await this.auth.logout(request.body as RefreshInput);
    response.status(204).send();
  };

  me = async (request: Request, response: Response): Promise<void> => {
    const user = await this.auth.getCurrentUser(requireAuthContext(request));
    response.status(200).json({ data: user });
  };
}
