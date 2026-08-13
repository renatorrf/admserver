import argon2 from 'argon2';

import { unauthorized } from '../../shared/errors/app-error';
import type { AuthRepository } from './auth.repository';
import type { LoginInput, RefreshInput } from './auth.schemas';
import type { AuthContext, AuthResult, AuthUserRecord, CurrentUser, LoginCompany } from './auth.types';
import type { TokenService } from './token-service';

const DUMMY_PASSWORD_HASH = '$argon2id$v=19$m=65536,p=4,t=3$xEaSttu1YczR4JkEnk+M5Q$9N7orLZXeVYLd1tjt6hgesNcwaDXMCorYIyDRzu2pTk';

export interface PasswordVerifier {
  verify(hash: string, plainText: string): Promise<boolean>;
}

export interface AuthApplication {
  listCompanies(): Promise<LoginCompany[]>;
  login(input: LoginInput): Promise<AuthResult>;
  refresh(input: RefreshInput): Promise<AuthResult>;
  logout(input: RefreshInput): Promise<void>;
  getCurrentUser(auth: AuthContext): Promise<CurrentUser>;
}

const defaultPasswordVerifier: PasswordVerifier = {
  verify: (hash, plainText) => argon2.verify(hash, plainText),
};

export class AuthService implements AuthApplication {
  constructor(
    private readonly repository: AuthRepository,
    private readonly tokens: TokenService,
    private readonly passwordVerifier: PasswordVerifier = defaultPasswordVerifier,
    private readonly accessExpiresInSeconds = 900,
  ) {}

  listCompanies(): Promise<LoginCompany[]> {
    return this.repository.listActiveCompanies();
  }

  async login(input: LoginInput): Promise<AuthResult> {
    const user = await this.repository.findByEmail(input.email, input.empresa);
    const passwordMatches = await this.passwordVerifier.verify(user?.senhaHash ?? DUMMY_PASSWORD_HASH, input.senha);
    if (!user || !passwordMatches || !user.ativo || !user.empresaAtiva) {
      throw unauthorized('E-mail ou senha invalidos.');
    }

    const issued = this.tokens.issueTokens(user);
    await this.repository.saveRefreshToken(issued.refreshRecord);
    await this.repository.updateLastAccess(user);
    return this.toAuthResult(user, issued.accessToken, issued.refreshToken);
  }

  async refresh(input: RefreshInput): Promise<AuthResult> {
    const auth = this.tokens.verifyRefresh(input.refreshToken);
    const rotated = await this.repository.rotateRefreshToken(
      this.tokens.hash(input.refreshToken),
      auth,
      (currentUser) => {
        const issued = this.tokens.issueTokens(currentUser);
        return { record: issued.refreshRecord, value: issued };
      },
    );
    if (!rotated) {
      throw unauthorized('Sessao invalida ou expirada.');
    }
    return this.toAuthResult(rotated.user, rotated.value.accessToken, rotated.value.refreshToken);
  }

  async logout(input: RefreshInput): Promise<void> {
    await this.repository.revokeRefreshToken(this.tokens.hash(input.refreshToken));
  }

  async getCurrentUser(auth: AuthContext): Promise<CurrentUser> {
    const user = await this.repository.findById(auth);
    if (!user || !user.ativo || !user.empresaAtiva) {
      throw unauthorized('Sessao invalida ou expirada.');
    }
    return this.toCurrentUser(user);
  }

  private toAuthResult(user: AuthUserRecord, accessToken: string, refreshToken: string): AuthResult {
    return {
      accessToken,
      refreshToken,
      tokenTipo: 'Bearer',
      expiraEmSegundos: this.accessExpiresInSeconds,
      usuario: this.toCurrentUser(user),
    };
  }

  private toCurrentUser(user: AuthUserRecord): CurrentUser {
    return {
      usuarioId: user.usuarioId,
      empresaId: user.empresaId,
      nome: user.nome,
      email: user.email,
      perfil: user.perfil,
    };
  }
}
