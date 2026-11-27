export const MAX_PARSE_BODY_BYTES = 32 * 1024
export const MAX_PARSE_INPUT_LENGTH = 5000

export function parseRequestBody(input, forceJson = false) {
  if (!forceJson) {
    const form = new globalThis.URLSearchParams({ url: input })
    if (form.toString().length <= MAX_PARSE_BODY_BYTES) return { body: form }
  }
  return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: input }) }
}
