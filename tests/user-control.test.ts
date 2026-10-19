import express from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createAuthenticate } from '../src/modules/auth/auth.middleware';
import { PgAuthRepository } from '../src/modules/auth/auth.repository';
import { TokenService } from '../src/modules/auth/token-service';
import { UsuarioControleService } from '../src/modules/usuarios/usuario-controle.service';
import { usuarioControleSchema } from '../src/modules/usuarios/usuario.schemas';

const auth = { empresaId: '11111111-1111-4111-8111-111111111111', usuarioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', perfil: 'GESTOR' as const };
const config = { jwtAccessSecret: 'test-only-access-secret-at-least-32-chars', jwtRefreshSecret: 'test-only-refresh-secret-at-least-32-chars', jwtAccessExpiresInSeconds: 900, jwtRefreshExpiresInSeconds: 3600 };

describe('controle de usuarios e bloqueio', () => {
  it('consulta estado atual a cada request e recusa JWT ainda valido apos bloqueio', async () => {
    const allowed = vi.fn().mockResolvedValue(true);
    const tokens = new TokenService(config, allowed);
    const app = express();
    app.get('/protected', createAuthenticate(tokens), (_req, res) => { res.sendStatus(204); });
    app.use((error: { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.sendStatus(error.statusCode ?? 500);
    });
    const token = tokens.issueTokens(auth).accessToken;
    expect((await request(app).get('/protected').auth(token, { type: 'bearer' })).status).toBe(204);
    allowed.mockResolvedValue(false);
    expect((await request(app).get('/protected').auth(token, { type: 'bearer' })).status).toBe(401);
    expect(allowed).toHaveBeenCalledTimes(2);
    expect(allowed).toHaveBeenLastCalledWith(auth);
  });

  it('falha fechada quando nao consegue validar o acesso no banco', async () => {
    const tokens = new TokenService(config, async () => { throw new Error('database unavailable'); });
    await expect(tokens.authenticateAccess(tokens.issueTokens(auth).accessToken)).rejects.toThrow('database unavailable');
  });

  it('verifica usuario, empresa, status e perfil no banco sem confiar apenas no JWT', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const repository = new PgAuthRepository({ query } as unknown as Pool);
    expect(await repository.accessAllowed(auth)).toBe(false);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('u.ativo=TRUE AND e.ativo=TRUE'), [auth.usuarioId, auth.empresaId, auth.perfil, 0, false]);
  });

  it('parametriza busca e limita listagem e resumo a empresa autenticada', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ data: [], total: 0, resumo: {}, consultadoEm: new Date() }] });
    const service = new UsuarioControleService({ query } as unknown as Pool);
    const result = await service.list(auth, { pagina: 2, limite: 20, busca: "' OR TRUE --", ativo: false, perfil: 'GERENTE', atividade: 'SEM_ATIVIDADE' });
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain('WHERE u.empresa_id=$1');
    expect(sql).toContain('r.empresa_id=u.empresa_id');
    expect(sql).toContain('empresa_id=u.empresa_id AND usuario_id=u.id');
    expect(sql).not.toContain("' OR TRUE --");
    expect(values).toEqual([auth.empresaId, false, 'GERENTE', "%' OR TRUE --%", false, 20, 20]);
    expect(result.meta).toEqual({ pagina: 2, limite: 20, total: 0, totalPaginas: 0 });
  });

  it('recusa empresa enviada pelo cliente e filtro invalido', () => {
    expect(usuarioControleSchema.safeParse({ empresaId: auth.empresaId }).success).toBe(false);
    expect(usuarioControleSchema.safeParse({ atividade: 'ONLINE', limite: 1000 }).success).toBe(false);
    expect(usuarioControleSchema.parse({ ativo: 'false' }).ativo).toBe(false);
  });
});
