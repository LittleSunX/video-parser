export const MAX_PARSE_BODY_BYTES: number
export const MAX_PARSE_INPUT_LENGTH: number

export function parseRequestBody(
  input: string,
  forceJson?: boolean,
): { headers?: Record<string, string>; body: string | URLSearchParams }
