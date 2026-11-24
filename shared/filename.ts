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

/** 清理文件名片段中的控制字符、路径分隔符与非法符号，并限制长度。 */
export function sanitizeFilenamePart(value: string | undefined, maxLength = 48): string {
  if (typeof value !== 'string') return ''
  return truncateFilename(
    value
      .replace(/[<>:"/\\|?*\u0000-\u001F\u007F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/g, ''),
    maxLength,
  ).replace(/[. ]+$/g, '')
}
