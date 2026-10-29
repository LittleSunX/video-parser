import { readFile } from 'node:fs/promises'
import type { ApiVersion } from '@video-parser/backend/runtime'

export type NodeVersion = Readonly<Required<ApiVersion> & { runtime: 'node' }>

export function validateNodeVersion(value: unknown): NodeVersion {
  const invalid = () => {
    throw new Error('Invalid build metadata')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const { runtime, id, tag, timestamp } = value as Record<string, unknown>
  if (
    runtime !== 'node' ||
    typeof id !== 'string' ||
    !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(id) ||
    typeof tag !== 'string' ||
    !/^[\da-f]{40}$/i.test(tag) ||
    typeof timestamp !== 'string' ||
    !Number.isFinite(Date.parse(timestamp)) ||
    new Date(timestamp).toISOString() !== timestamp
  )
    return invalid()
  return Object.freeze({ runtime, id, tag, timestamp })
}

/** Missing, partial or corrupt metadata is fatal; restart never generates a new version. */
export async function loadVersion(path: string | URL): Promise<NodeVersion> {
  try {
    return validateNodeVersion(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    throw new Error('Invalid build metadata')
  }
}
