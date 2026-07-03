import type { SessionRecord } from "../../types.js";

type Metadata = SessionRecord["metadata"];

export type MetadataBaseline = {
  metadata: Metadata;
};

const metadataBaselines = new WeakMap<SessionRecord, MetadataBaseline>();

function hasOwn(source: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function cloneMetadata(metadata: Metadata): Metadata {
  return metadata ? { ...metadata } : undefined;
}

function isMetadataEmpty(metadata: Metadata): boolean {
  return metadata === undefined || Object.keys(metadata).length === 0;
}

function metadataHasKey(metadata: Metadata, key: string): metadata is Record<string, string> {
  return metadata !== undefined && hasOwn(metadata, key);
}

function metadataKeyChanged(current: Metadata, baseline: Metadata, key: string): boolean {
  const currentHasKey = metadataHasKey(current, key);
  const baselineHasKey = metadataHasKey(baseline, key);
  if (currentHasKey !== baselineHasKey) {
    return true;
  }
  return currentHasKey && current?.[key] !== baseline?.[key];
}

function changedKeysFromBaseline(current: Metadata, baseline: Metadata): Set<string> {
  const keys = new Set([...Object.keys(current ?? {}), ...Object.keys(baseline ?? {})]);
  return new Set([...keys].filter((key) => metadataKeyChanged(current, baseline, key)));
}

function normalizeMetadata(metadata: Record<string, string>): Metadata {
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function mergeWithoutBaseline(current: Metadata, persisted: Metadata): Metadata {
  const merged = { ...persisted };
  for (const [key, value] of Object.entries(current ?? {})) {
    merged[key] = value;
  }
  return normalizeMetadata(merged);
}

function applyOwnerMetadataChange(merged: Record<string, string>, current: Metadata, key: string) {
  if (metadataHasKey(current, key)) {
    merged[key] = current[key];
    return;
  }
  delete merged[key];
}

export function rememberSessionMetadataBaseline(record: SessionRecord): SessionRecord {
  metadataBaselines.set(record, { metadata: cloneMetadata(record.metadata) });
  return record;
}

export function mergeMetadataForPersist(options: {
  current: Metadata;
  persisted: Metadata;
  baseline?: MetadataBaseline;
}): Metadata {
  if (!options.baseline) {
    return mergeWithoutBaseline(options.current, options.persisted);
  }

  const merged = { ...options.persisted };
  const changedKeys = changedKeysFromBaseline(options.current, options.baseline.metadata);
  for (const key of changedKeys) {
    applyOwnerMetadataChange(merged, options.current, key);
  }
  return normalizeMetadata(merged);
}

export function mergeRecordMetadataForPersist(record: SessionRecord, persisted: Metadata): void {
  const baseline = metadataBaselines.get(record);
  const merged = mergeMetadataForPersist({
    current: record.metadata,
    persisted,
    baseline,
  });

  if (isMetadataEmpty(merged)) {
    record.metadata = undefined;
  } else {
    record.metadata = merged;
  }
}
