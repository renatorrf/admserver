import { EventEmitter } from 'node:events';

import type { CorridaRecord } from '../modules/corridas/corrida.types';
import type { LocalizacaoRecord } from '../modules/localizacoes/localizacao.types';

export interface CorridaRealtimePublisher {
  publishRide(ride: CorridaRecord, event?: CorridaRealtimeEvent): void;
}

export type CorridaRealtimeEvent =
  | 'corrida:criada' | 'corrida:ofertada' | 'corrida:aceita' | 'corrida:status-alterado'
  | 'corrida:finalizada' | 'corrida:cancelada' | 'corrida:valor-alterado';

export type FaturamentoRealtimeEvent = 'faturamento:criado' | 'faturamento:cancelado';
export type FaturamentoRealtimePayload = {
  empresaId: string; faturamentoId: string; prestadorId: string | null;
};

export interface LocalizacaoRealtimePublisher {
  publishLocation(location: LocalizacaoRecord): void;
}

export type RequisitionInvalidation = { empresaId: string; id?: string };
export interface RequisitionRealtimePublisher {
  publishRequisition(payload: RequisitionInvalidation & { solicitanteId: string }): void;
}

export class RealtimeBus implements CorridaRealtimePublisher, LocalizacaoRealtimePublisher {
  private readonly emitter = new EventEmitter();

  publishRide(ride: CorridaRecord, event: CorridaRealtimeEvent = 'corrida:status-alterado'): void {
    this.emitter.emit('ride', ride, event);
  }

  publishBilling(event: FaturamentoRealtimeEvent, payload: FaturamentoRealtimePayload): void {
    this.emitter.emit('billing', event, payload);
  }

  publishLocation(location: LocalizacaoRecord): void {
    this.emitter.emit('location', location);
  }

  publishRequisition(payload: RequisitionInvalidation & { solicitanteId: string }): void {
    this.emitter.emit('requisition', payload);
  }

  onRequisition(listener: (payload: RequisitionInvalidation & { solicitanteId: string }) => void): () => void {
    this.emitter.on('requisition', listener);
    return () => this.emitter.off('requisition', listener);
  }

  onRide(listener: (ride: CorridaRecord, event: CorridaRealtimeEvent) => void): () => void {
    this.emitter.on('ride', listener);
    return () => this.emitter.off('ride', listener);
  }

  onBilling(listener: (event: FaturamentoRealtimeEvent, payload: FaturamentoRealtimePayload) => void): () => void {
    this.emitter.on('billing', listener);
    return () => this.emitter.off('billing', listener);
  }

  onLocation(listener: (location: LocalizacaoRecord) => void): () => void {
    this.emitter.on('location', listener);
    return () => this.emitter.off('location', listener);
  }
}
