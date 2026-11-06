import * as pdfjsLib from 'pdfjs-dist'

// Use the bundled worker from the local package (not CDN — blocked by extension CSP)
// Vite's ?url import emits the worker as a separate asset and returns its public path
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).href

export async function parsePDF(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise

  let fullText = ''
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    const pageText = content.items
      .map((item) => ('str' in item ? (item as { str: string }).str : ''))
      .join(' ')
    fullText += pageText + '\n'
  }

  return fullText.trim()
}

/**
 * 把 PDF 前若干页渲染为 PNG dataURL。
 * 用于「扫描件 / 图片型 PDF」：这类文件没有文本层，parsePDF 拿不到内容，
 * 只能渲染成图片再交给支持视觉的模型（DeepSeek V4.1 Flash 原生支持图片）读取。
 */
export async function renderPDFPagesToImages(
  file: File,
  maxPages = 2,
  scale = 2,
): Promise<string[]> {
  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
  const images: string[] = []
  const pageCount = Math.min(maxPages, pdf.numPages)

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i)
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    // pdfjs-dist v6 起 RenderParameters 要求显式传入 canvas（canvasContext 仅作兼容）
    await page.render({ canvas, viewport }).promise
    images.push(canvas.toDataURL('image/png'))
  }

  return images
}
