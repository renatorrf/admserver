import { forbidden, notFound } from '../../shared/errors/app-error';
import type { AuthContext } from '../auth/auth.types';
import type { OperacaoRepository } from './operacao.repository';
import type { FuncionarioLookupQuery, FuncionarioSearchQuery, PrestadorSearchQuery } from './operacao.schemas';

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

  searchEmployees(auth: AuthContext, query: FuncionarioSearchQuery) {
    if (auth.perfil === 'PRESTADOR') throw forbidden();
    return this.repository.searchEmployees(auth, query);
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

  searchProviders(auth: AuthContext, query: PrestadorSearchQuery) {
    if (auth.perfil === 'PRESTADOR') throw forbidden();
    return this.repository.searchProviders(auth, query);
  }

  listRequesters(auth: AuthContext) {
    if (auth.perfil === 'PRESTADOR') throw forbidden();
    return this.repository.listRequesters(auth);
  }
}
