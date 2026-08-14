import { Router } from 'express';
import type { Pool } from 'pg';

import { createAuthenticate, authorize } from '../auth/auth.middleware';
import type { TokenService } from '../auth/token-service';
import { AuditRepository } from '../auditoria/audit.repository';
import { createAuditRouter } from '../auditoria/audit.routes';
import { CatalogService } from '../cadastros/catalog.service';
import { createCatalogRouter } from '../cadastros/catalog.routes';
import { centroCustoCreateSchema, centroCustoDefinition, centroCustoListSchema, centroCustoUpdateSchema } from '../centros-custo/centro-custo.catalog';
import { createEmpresaRouter } from '../empresas/empresa.routes';
import { EmpresaService } from '../empresas/empresa.service';
import { funcionarioCreateSchema, funcionarioDefinition, funcionarioListSchema, funcionarioUpdateSchema } from '../funcionarios/funcionario.catalog';
import { createFuncionarioUnificadoRouter } from '../funcionarios/funcionario-unificado.routes';
import { FuncionarioUnificadoService } from '../funcionarios/funcionario-unificado.service';
import { prestadorCreateSchema, prestadorDefinition, prestadorListSchema, prestadorUpdateSchema } from '../prestadores/prestador.catalog';
import { createPrestadorUnificadoRouter } from '../prestadores/prestador-unificado.routes';
import { PrestadorUnificadoService } from '../prestadores/prestador-unificado.service';
import { createUsuarioRouter } from '../usuarios/usuario.routes';
import { UsuarioService } from '../usuarios/usuario.service';
import { veiculoCreateSchema, veiculoDefinition, veiculoListSchema, veiculoUpdateSchema } from '../veiculos/veiculo.catalog';

export function createAdminRouter(pool: Pool, tokens: TokenService): Router {
  const router = Router();
  const audit = new AuditRepository(pool);

  router.use(createAuthenticate(tokens), authorize('GESTOR'));
  router.use('/empresas', createEmpresaRouter(new EmpresaService(pool, audit)));
  router.use('/usuarios', createUsuarioRouter(new UsuarioService(pool, audit)));
  router.use('/cadastros-unificados', createPrestadorUnificadoRouter(new PrestadorUnificadoService(pool, audit)));
  router.use('/cadastros-unificados/funcionarios', createFuncionarioUnificadoRouter(new FuncionarioUnificadoService(pool, audit)));
  router.use('/prestadores', createCatalogRouter(
    new CatalogService(pool, audit, prestadorDefinition),
    { create: prestadorCreateSchema, update: prestadorUpdateSchema, list: prestadorListSchema },
  ));
  router.use('/veiculos', createCatalogRouter(
    new CatalogService(pool, audit, veiculoDefinition),
    { create: veiculoCreateSchema, update: veiculoUpdateSchema, list: veiculoListSchema },
  ));
  router.use('/centros-custo', createCatalogRouter(
    new CatalogService(pool, audit, centroCustoDefinition),
    { create: centroCustoCreateSchema, update: centroCustoUpdateSchema, list: centroCustoListSchema },
  ));
  router.use('/funcionarios', createCatalogRouter(
    new CatalogService(pool, audit, funcionarioDefinition),
    { create: funcionarioCreateSchema, update: funcionarioUpdateSchema, list: funcionarioListSchema },
  ));
  router.use('/auditoria', createAuditRouter(audit));

  return router;
}
