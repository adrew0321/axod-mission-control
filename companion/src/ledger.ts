// companion/src/ledger.ts
// Local record of where each ingested project came from, so writeback can go
// back to the same folder. JSON map projectId -> { localPath, name, ingestedAt }.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export interface LedgerEntry {
  localPath: string;
  name: string;
  ingestedAt: string;
}
export type Ledger = Record<string, LedgerEntry>;

export function ledgerPath(): string {
  return join(homedir(), '.akira-companion', 'ingest-ledger.json');
}

export async function readLedger(file: string = ledgerPath()): Promise<Ledger> {
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Ledger) : {};
  } catch {
    return {}; // missing or corrupt — start empty
  }
}

export async function upsertLedger(
  projectId: string,
  entry: LedgerEntry,
  file: string = ledgerPath(),
): Promise<void> {
  const ledger = await readLedger(file);
  ledger[projectId] = entry;
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(ledger, null, 2));
  await rename(tmp, file); // atomic replace
}

export async function getLedgerEntry(
  projectId: string,
  file: string = ledgerPath(),
): Promise<LedgerEntry | undefined> {
  return (await readLedger(file))[projectId];
}
