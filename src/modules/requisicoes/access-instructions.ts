export function installationInstructions(resetUrl: string): string {
  const login = new URL('/login', resetUrl).toString();
  return `Acesse o ADM Taxi: ${login}\n\nInstalacao no celular:\n`
    + 'Android: abra o endereco no navegador e selecione Baixar APK Android.\n'
    + 'iPhone: abra o endereco no Safari, toque em Compartilhar e em Adicionar a Tela de Inicio.\n'
    + 'Depois de entrar, ative as notificacoes em Minha conta para receber os avisos da viagem.\n\nEquipe ADM Taxi.';
}
