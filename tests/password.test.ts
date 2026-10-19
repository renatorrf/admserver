import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfig, resetConfigForTests } from '../src/config/env';
import { passwordSchema } from '../src/shared/validation/password';
import { changePasswordSchema, forgotPasswordSchema, resetPasswordSchema } from '../src/modules/auth/password.schemas';
import { TokenService } from '../src/modules/auth/token-service';
import { SmtpPasswordMailer } from '../src/modules/auth/password-mailer';
import nodemailer from 'nodemailer';

const keys = ['SMTP_HOST','SMTP_PORT','SMTP_SECURE','SMTP_USER','SMTP_PASSWORD','SMTP_FROM','PASSWORD_RESET_URL','MASTER_PASSWORD_RESET_URL','PASSWORD_RESET_TTL_MINUTES'];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); resetConfigForTests(); });
function smtpEnv() {
  keys.forEach(k => vi.stubEnv(k, ''));
  Object.entries({ SMTP_HOST: 'smtp.example.test', SMTP_USER: 'test', SMTP_PASSWORD: 'fake',
    SMTP_FROM: 'no-reply@example.test', PASSWORD_RESET_URL: 'https://app.example.test/redefinir-senha' }).forEach(([k,v]) => vi.stubEnv(k,v));
  resetConfigForTests();
}

describe('password policy and email configuration', () => {
  it('accepts 6..128 characters without composition restrictions, never trims passwords', () => {
    expect(passwordSchema.safeParse('12345').success).toBe(false);
    expect(passwordSchema.parse('123456')).toBe('123456');
    expect(passwordSchema.parse(' 1234 ')).toBe(' 1234 ');
    expect(passwordSchema.safeParse('a'.repeat(129)).success).toBe(false);
    expect(changePasswordSchema.safeParse({senhaAtual:'old',novaSenha:'123456'}).success).toBe(true);
  });
  it('scopes recovery by company and rejects extra user/tenant IDs', () => {
    expect(forgotPasswordSchema.parse({empresa:'acme',email:'USER@example.test'})).toEqual({empresa:'ACME',email:'user@example.test'});
    expect(forgotPasswordSchema.safeParse({empresa:'acme',email:'user@example.test',usuarioId:'injected'}).success).toBe(false);
    expect(resetPasswordSchema.safeParse({token:'bad',novaSenha:'123456'}).success).toBe(false);
  });
  it('starts with all email variables empty and refuses partial configuration', () => {
    keys.forEach(k=>vi.stubEnv(k,'')); resetConfigForTests();
    expect(getConfig().mail).toBeUndefined();
    vi.stubEnv('SMTP_HOST','mail.test'); resetConfigForTests();
    expect(()=>getConfig()).toThrow('email incompleta');
  });
  it('uses STARTTLS/587 and 30 minutes by default; supports implicit TLS/465', () => {
    smtpEnv(); expect(getConfig().mail).toMatchObject({port:587,secure:false,resetTtlMinutes:30});
    vi.stubEnv('SMTP_PORT','465'); resetConfigForTests();
    expect(getConfig().mail).toMatchObject({port:465,secure:true});
  });
  it('rejects unsafe reset origins and invalid TTL', () => {
    smtpEnv(); vi.stubEnv('PASSWORD_RESET_URL','http://remote.example.test/redefinir-senha');
    expect(()=>getConfig()).toThrow('HTTPS');
    vi.stubEnv('PASSWORD_RESET_URL','https://app.example.test/redefinir-senha#token');
    expect(()=>getConfig()).toThrow('HTTPS');
    vi.stubEnv('PASSWORD_RESET_URL','https://app.example.test/redefinir-senha');
    vi.stubEnv('PASSWORD_RESET_TTL_MINUTES','0'); expect(()=>getConfig()).toThrow('PASSWORD_RESET_TTL_MINUTES');
  });
  it('requires encrypted SMTP and sends only a recovery link, not a password', async () => {
    smtpEnv(); const sendMail=vi.fn().mockResolvedValue({});
    const create=vi.spyOn(nodemailer,'createTransport').mockReturnValue({sendMail} as unknown as ReturnType<typeof nodemailer.createTransport>);
    await new SmtpPasswordMailer(getConfig().mail!).send('person@example.test','https://app.example.test/redefinir-senha#token=example',30);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({requireTLS:true,disableUrlAccess:true,disableFileAccess:true}));
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({text:expect.stringContaining('#token=example')}));
  });
  it('validates the separate master recovery URL without enabling it implicitly', () => {
    smtpEnv(); expect(getConfig().mail?.masterResetUrl).toBeUndefined();
    vi.stubEnv('MASTER_PASSWORD_RESET_URL', 'http://remote.example.test/master/redefinir-senha'); resetConfigForTests();
    expect(() => getConfig()).toThrow('HTTPS');
    vi.stubEnv('MASTER_PASSWORD_RESET_URL', 'https://app.example.test/master/redefinir-senha'); resetConfigForTests();
    expect(getConfig().mail?.masterResetUrl).toBe('https://app.example.test/master/redefinir-senha');
  });
  it('restricts temporary sessions to password endpoints and includes credential version', async () => {
    const tokens=new TokenService({jwtAccessSecret:'a'.repeat(40),jwtRefreshSecret:'b'.repeat(40),jwtAccessExpiresInSeconds:900,jwtRefreshExpiresInSeconds:3600},async()=>true);
    const auth={usuarioId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',empresaId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',perfil:'GESTOR' as const,senhaVersao:2,deveAlterarSenha:true};
    const issued=tokens.issueTokens(auth);
    await expect(tokens.authenticateAccess(issued.accessToken)).rejects.toMatchObject({code:'TROCA_SENHA_OBRIGATORIA'});
    expect(await tokens.authenticateAccess(issued.accessToken,true)).toEqual(auth);
    expect(tokens.verifyRefresh(issued.refreshToken).senhaVersao).toBe(2);
  });
});
