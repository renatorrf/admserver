export type MasterContext = {
  administradorId: string;
  usuario: string;
  deveAlterarSenha: boolean;
};

export type MasterRecord = MasterContext & {
  nome: string;
  senhaHash: string;
  ativo: boolean;
  ultimoAcessoEm: Date | null;
  criadoEm: Date;
};

export type MasterPublic = Omit<MasterRecord, 'senhaHash'>;

export type MasterSession = {
  accessToken: string;
  tokenTipo: 'Bearer';
  expiraEmSegundos: number;
  administrador: MasterPublic;
};
