import { forbidden } from '../../shared/errors/app-error';
import type { AuthContext } from '../auth/auth.types';
import type { DashboardRepository } from './dashboard.repository';

export class DashboardService {
  constructor(private readonly repository: DashboardRepository) {}
  get(auth: AuthContext) {
    if (auth.perfil === 'PRESTADOR') throw forbidden();
    return this.repository.get(auth);
  }
}
