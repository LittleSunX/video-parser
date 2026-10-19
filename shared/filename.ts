/** 保持原有 UTF-16 长度上限，避免截断代理对；替换原本就不完整的代理项。 */
export function truncateFilename(value: string, maxLength: number): string {
  let result = ''
  for (const character of value) {
    const code = character.charCodeAt(0)
    const safeCharacter =
      character.length === 1 && code >= 0xd800 && code <= 0xdfff ? '\uFFFD' : character
    if (result.length + safeCharacter.length > maxLength) break
    result += safeCharacter
  }
  return result
}
