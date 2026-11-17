import { describe, expect, it } from 'vitest';
import { installationInstructions } from '../src/modules/requisicoes/access-instructions';

describe('Orientacoes de instalacao', () => {
  it('recomenda Safari para iOS, incluindo links abertos pelo WhatsApp', () => {
    const text = installationInstructions('https://admbrasil-taxi.web.app/redefinir-senha');
    expect(text).toContain('iPhone: abra o endereco no Safari');
    expect(text).toContain('Adicionar a Tela de Inicio');
    expect(text).toContain('Se abriu pelo WhatsApp');
    expect(text).toContain('copie o endereco e abra no Safari');
  });
  it('mantem APK como orientacao de instalacao para Android', () => {
    const text = installationInstructions('https://admbrasil-taxi.web.app/redefinir-senha');
    expect(text).toContain('Android: abra o endereco no navegador e selecione Baixar APK Android.');
    expect(text).toContain('https://admbrasil-taxi.web.app/login');
  });
});
