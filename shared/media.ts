/** 仅根据明确的图片 MIME 修正后缀；二进制或缺失类型保留原文件名。 */
export function imageFilename(filename: string, contentType: string | null): string {
  const extensions: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
    'image/heic': 'heic',
    'image/heif': 'heif',
  }
  const extension = extensions[contentType?.split(';')[0].trim().toLowerCase() ?? '']
  if (!extension) return filename
  return filename.replace(/\.[^.]+$/, '') + '.' + extension
}
