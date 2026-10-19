import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { TokenService } from '../src/modules/auth/token-service';
import { funcionarioUnificadoCreateSchema } from '../src/modules/funcionarios/funcionario-unificado.schemas';

const config = { jwtAccessSecret: 'test-only-access-secret-0000000000000000', jwtRefreshSecret: 'test-only-refresh-secret-000000000000000', jwtAccessExpiresInSeconds: 900, jwtRefreshExpiresInSeconds: 3600 };
const tokens = new TokenService(config);
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('conta unica de funcionario', () => {
  it('isola selecao de funcionario de gestor, access e refresh e expira em cinco minutos', () => {
    const token = tokens.issueEmployeeSelection(id, 3);
    expect(tokens.verifyEmployeeSelection(token)).toMatchObject({ sub: id, versao: 3 });
    const decoded = jwt.decode(token) as jwt.JwtPayload;
    expect(decoded.exp! - decoded.iat!).toBe(300);
    expect(() => tokens.verifyAccess(token)).toThrow();
    expect(() => tokens.verifyRefresh(token)).toThrow();
    expect(() => tokens.verifyCompanySelection(token)).toThrow();
    expect(() => tokens.verifyEmployeeSelection(tokens.issueCompanySelection(id, 3))).toThrow();
  });
  it('rejeita token expirado, adulterado e sessao como selecao', () => {
    const expired = jwt.sign({ sub: id, versao: 0, tipo: 'employee-company-selection' }, config.jwtAccessSecret,
      { expiresIn: -1, issuer: 'adm-taxi', audience: 'adm-taxi-employee-selection' });
    expect(() => tokens.verifyEmployeeSelection(expired)).toThrow();
    expect(() => tokens.verifyEmployeeSelection(tokens.issueEmployeeSelection(id, 0) + 'bad')).toThrow();
    expect(() => tokens.verifyEmployeeSelection(tokens.issueTokens({ usuarioId: id, empresaId: id, perfil: 'FUNCIONARIO' }).accessToken)).toThrow();
  });
  it('aceita nova conta ou vinculo sem permitir sobrescrever senha ao vincular', () => {
    const funcionario = { nome: 'Teste', email: 'test@example.test', matricula: 'E1', centroCustoId: id };
    expect(funcionarioUnificadoCreateSchema.safeParse({ funcionario, acesso: { contaId: id } }).success).toBe(true);
    expect(funcionarioUnificadoCreateSchema.safeParse({ funcionario, acesso: { senha: '123456' } }).success).toBe(true);
    expect(funcionarioUnificadoCreateSchema.safeParse({ funcionario, acesso: { contaId: id, senha: '123456' } }).success).toBe(false);
    expect(funcionarioUnificadoCreateSchema.safeParse({ funcionario, acesso: { senha: '12345' } }).success).toBe(false);
    expect(funcionarioUnificadoCreateSchema.safeParse({ funcionario, acesso: {} }).success).toBe(false);
  });
});
