import { EventEmitter } from 'node:events';

import type { CorridaRecord } from '../modules/corridas/corrida.types';
import type { LocalizacaoRecord } from '../modules/localizacoes/localizacao.types';

export interface CorridaRealtimePublisher {
  publishRide(ride: CorridaRecord): void;
}

export interface LocalizacaoRealtimePublisher {
  publishLocation(location: LocalizacaoRecord): void;
}

export class RealtimeBus implements CorridaRealtimePublisher, LocalizacaoRealtimePublisher {
  private readonly emitter = new EventEmitter();

  publishRide(ride: CorridaRecord): void {
    this.emitter.emit('ride', ride);
  }

  publishLocation(location: LocalizacaoRecord): void {
    this.emitter.emit('location', location);
  }

  onRide(listener: (ride: CorridaRecord) => void): () => void {
    this.emitter.on('ride', listener);
    return () => this.emitter.off('ride', listener);
  }

  onLocation(listener: (location: LocalizacaoRecord) => void): () => void {
    this.emitter.on('location', listener);
    return () => this.emitter.off('location', listener);
  }
}
