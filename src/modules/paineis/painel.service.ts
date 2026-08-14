import { forbidden } from '../../shared/errors/app-error';
import type { AuthContext } from '../auth/auth.types';
import type { PainelParticipanteRepository } from './painel.repository';
import type { PainelParticipanteQuery } from './painel.schemas';

export class PainelParticipanteService {
  constructor(private readonly repository: PainelParticipanteRepository) {}

  get(auth: AuthContext, query: PainelParticipanteQuery) {
    if (auth.perfil !== 'FUNCIONARIO' && auth.perfil !== 'PRESTADOR') throw forbidden();
    return this.repository.get(auth, query);
  }
}
