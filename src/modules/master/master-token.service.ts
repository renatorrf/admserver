import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { unauthorized } from '../../shared/errors/app-error';
import type { MasterContext } from './master.types';

const masterPayloadSchema = z.object({
  sub: z.string().uuid(),
  usuario: z.string(),
  deveAlterarSenha: z.boolean(),
  tipo: z.literal('master-access'),
  exp: z.number().int().positive(),
});

export class MasterTokenService {
  readonly expiresInSeconds = 3600;

  constructor(private readonly secret: string) {}

  issue(context: MasterContext): string {
    return jwt.sign({
      sub: context.administradorId,
      usuario: context.usuario,
      deveAlterarSenha: context.deveAlterarSenha,
      tipo: 'master-access',
    }, this.secret, {
      expiresIn: this.expiresInSeconds,
      issuer: 'adm-taxi-platform',
      audience: 'adm-taxi-platform-api',
    });
  }

  verify(token: string): MasterContext {
    try {
      const payload = masterPayloadSchema.parse(jwt.verify(token, this.secret, {
        issuer: 'adm-taxi-platform', audience: 'adm-taxi-platform-api',
      }));
      return {
        administradorId: payload.sub,
        usuario: payload.usuario,
        deveAlterarSenha: payload.deveAlterarSenha,
      };
    } catch {
      throw unauthorized('Sessao master invalida ou expirada.');
    }
  }
}
