import type { CorridaRecord } from './corrida.types';

export function employeeRide(ride: CorridaRecord, employeeId: string): CorridaRecord {
  const own = ride.itinerario?.participantes.find(p => p.funcionarioId === employeeId);
  const pickup = own ? ride.itinerario?.paradas.find(p => p.id === own.embarqueId)
    : ride.paradas?.find(p => p.funcionarioId === employeeId);
  const dropoff = own ? ride.itinerario?.paradas.find(p => p.id === own.desembarqueId) : null;
  const active = ride.itinerario?.paradas.find(p => p.estado !== 'CONCLUIDA');
  const tracking = own ? own.estado === 'EMBARCADO'
    || (own.estado === 'AGUARDANDO' && active?.id === own.embarqueId && active.estado !== 'PENDENTE') : true;
  const underway = ['EM_DESLOCAMENTO', 'AGUARDANDO_PASSAGEIRO', 'EM_CORRIDA'].includes(ride.status);
  const stage = ride.status === 'CANCELADA' ? 'Corrida cancelada' : ride.status === 'FINALIZADA' ? 'Corrida finalizada'
    : own?.estado === 'AGUARDANDO' && underway
    ? !tracking ? 'Em deslocamento' : active?.estado === 'CHEGADA' ? 'Motorista no seu embarque' : 'Motorista a caminho do seu embarque'
    : own?.estado === 'EMBARCADO' ? 'A bordo' : own?.estado === 'DESEMBARCADO' ? 'Desembarque concluido'
      : own?.estado === 'AUSENTE' ? 'Ausencia registrada' : own?.estado === 'CANCELADO' ? 'Participacao cancelada' : undefined;
  // An allowlist prevents future financial/personal fields leaking by default.
  return {
    id: ride.id, empresaId: ride.empresaId, solicitanteUsuarioId: '', centroCustoId: '',
    funcionarioId: employeeId, prestadorId: ride.prestadorId, veiculoId: ride.veiculoId,
    status: own?.estado === 'AGUARDANDO' && underway && !tracking ? 'EM_DESLOCAMENTO' : ride.status,
    acompanhamentoLiberado: tracking && underway, etapaPassageiro: stage,
    tipo: ride.tipo, agendadaPara: ride.agendadaPara,
    solicitadaEm: ride.solicitadaEm, atualizadoEm: ride.atualizadoEm,
    aceitaEm: ride.aceitaEm, embarqueEm: own ? own.embarqueEm ?? null : ride.embarqueEm,
    desembarqueEm: own ? own.desembarqueEm ? new Date(own.desembarqueEm) : null : ride.desembarqueEm,
    finalizadaEm: ride.finalizadaEm, quantidadePassageiros: 1,
    funcionarioNome: own?.funcionarioNome ?? (pickup && 'funcionarioNome' in pickup ? pickup.funcionarioNome : undefined) ?? (ride.funcionarioId === employeeId ? ride.funcionarioNome : undefined),
    origemDescricao: pickup?.descricao ?? (ride.funcionarioId === employeeId ? ride.origemDescricao : null),
    origemLatitude: pickup?.latitude ?? (ride.funcionarioId === employeeId ? ride.origemLatitude : null),
    origemLongitude: pickup?.longitude ?? (ride.funcionarioId === employeeId ? ride.origemLongitude : null),
    destinoDescricao: dropoff?.descricao ?? ride.destinoDescricao,
    destinoLatitude: dropoff?.latitude ?? ride.destinoLatitude, destinoLongitude: dropoff?.longitude ?? ride.destinoLongitude,
    prestadorNome: ride.prestadorNome, prestadorTelefone: ride.prestadorTelefone,
    veiculoPlaca: ride.veiculoPlaca, veiculoDescricao: ride.veiculoDescricao,
    paradas: [], itinerarioVersao: ride.itinerarioVersao,
    itinerario: own && ride.itinerario ? { versao: ride.itinerario.versao, participantes: [{
      funcionarioId: own.funcionarioId, funcionarioNome: own.funcionarioNome, embarqueId: own.embarqueId,
      desembarqueId: own.desembarqueId, estado: own.estado, embarqueEm: own.embarqueEm, desembarqueEm: own.desembarqueEm, motivo: null,
    }],
      paradas: ride.itinerario.paradas.filter(p => p.id === own.embarqueId || p.id === own.desembarqueId) } : null,
  };
}
