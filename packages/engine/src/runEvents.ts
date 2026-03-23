import { EventEmitter } from "events";

const emitters = new Map<string, EventEmitter>();
const stopRequested = new Set<string>();

export function getEmitter(runId: string): EventEmitter | undefined {
  return emitters.get(runId);
}

export function createEmitter(runId: string): EventEmitter {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(20);
  emitters.set(runId, emitter);
  stopRequested.delete(runId);
  return emitter;
}

export function destroyEmitter(runId: string): void {
  const emitter = emitters.get(runId);
  if (emitter) {
    emitter.removeAllListeners();
    emitters.delete(runId);
  }
  stopRequested.delete(runId);
}

export function requestStop(runId: string): boolean {
  if (!emitters.has(runId)) return false;
  stopRequested.add(runId);
  return true;
}

export function isStopRequested(runId: string): boolean {
  return stopRequested.has(runId);
}
