import { EventEmitter } from "events";

const emitters = new Map<string, EventEmitter>();

export function getEmitter(runId: string): EventEmitter | undefined {
  return emitters.get(runId);
}

export function createEmitter(runId: string): EventEmitter {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(20);
  emitters.set(runId, emitter);
  return emitter;
}

export function destroyEmitter(runId: string): void {
  const emitter = emitters.get(runId);
  if (emitter) {
    emitter.removeAllListeners();
    emitters.delete(runId);
  }
}
