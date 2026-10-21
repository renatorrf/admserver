export const perfisUsuario = ['PRESTADOR', 'FUNCIONARIO', 'GERENTE', 'GESTOR', 'PORTARIA'] as const;
export type PerfilUsuario = (typeof perfisUsuario)[number];

export type AuthContext = {
  contaMotoristaId?: string;
  usuarioId: string;
  empresaId: string;
  perfil: PerfilUsuario;
  senhaVersao?: number;
  deveAlterarSenha?: boolean;
};

export type AuthUserRecord = AuthContext & {
  nome: string;
  email: string;
  senhaHash: string;
  ativo: boolean;
  empresaAtiva: boolean;
};

export type CurrentUser = AuthContext & {
  nome: string;
  email: string;
};

export type LoginCompany = {
  codigoAcesso: string;
  nomeFantasia: string;
};

export type RefreshTokenRecord = {
  id: string;
  usuarioId: string;
  empresaId: string;
  tokenHash: string;
  expiraEm: Date;
};

export type AuthResult = {
  accessToken: string;
  refreshToken: string;
  tokenTipo: 'Bearer';
  expiraEmSegundos: number;
  usuario: CurrentUser;
};
