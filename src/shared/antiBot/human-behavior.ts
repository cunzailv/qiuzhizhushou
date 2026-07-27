export function simulateScroll(): Promise<void> {
  return new Promise((resolve) => {
    const scrollAmount = 100 + Math.random() * 400
    const currentScroll = window.scrollY
    const target = currentScroll + scrollAmount

    const startTime = performance.now()
    const duration = 500 + Math.random() * 1000

    function easeInOut(t: number): number {
      return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
    }

    function step(currentTime: number) {
      const elapsed = currentTime - startTime
      const progress = Math.min(elapsed / duration, 1)
      const eased = easeInOut(progress)

      window.scrollTo(0, currentScroll + (target - currentScroll) * eased)

      if (progress < 1) {
        requestAnimationFrame(step)
      } else {
        resolve()
      }
    }

    requestAnimationFrame(step)
  })
}

export async function simulateTyping(input: HTMLInputElement | HTMLTextAreaElement, text: string): Promise<void> {
  input.focus()
  for (const char of text) {
    input.value += char
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 150))
  }
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

export function randomMouseMove(element: HTMLElement): void {
  const rect = element.getBoundingClientRect()
  const x = rect.left + Math.random() * rect.width
  const y = rect.top + Math.random() * rect.height

  element.dispatchEvent(
    new MouseEvent('mousemove', {
      clientX: x,
      clientY: y,
      bubbles: true,
    })
  )
}
