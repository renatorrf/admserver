import { forbidden, notFound } from '../../shared/errors/app-error';
import type { AuthContext } from '../auth/auth.types';
import type { OperacaoRepository } from './operacao.repository';
import type { FuncionarioLookupQuery } from './operacao.schemas';

export class OperacaoService {
  constructor(private readonly repository: OperacaoRepository) {}

  listCenters(auth: AuthContext) {
    if (auth.perfil === 'PRESTADOR') throw forbidden();
    return this.repository.listCenters(auth);
  }

  listEmployees(auth: AuthContext, query: FuncionarioLookupQuery) {
    if (auth.perfil === 'PRESTADOR') throw forbidden();
    return this.repository.listEmployees(auth, query);
  }

  async getMyProvider(auth: AuthContext) {
    if (auth.perfil !== 'PRESTADOR') throw forbidden();
    const provider = await this.repository.getMyProvider(auth);
    if (!provider?.ativo) throw notFound('Prestador');
    return provider;
  }

  listMyVehicles(auth: AuthContext) {
    if (auth.perfil !== 'PRESTADOR') throw forbidden();
    return this.repository.listMyVehicles(auth);
  }

  listProviders(auth: AuthContext) {
    if (auth.perfil === 'PRESTADOR') throw forbidden();
    return this.repository.listProviders(auth);
  }

  listRequesters(auth: AuthContext) {
    if (auth.perfil === 'PRESTADOR') throw forbidden();
    return this.repository.listRequesters(auth);
  }
}
