// G9: rolling last-N observation masking.
// JetBrains "The Complexity Trap" (arXiv 2508.21433): masking ≈ LLM-summarization at lower complexity;
// prefer masking, do NOT stack a summarizer expecting additive gains.

export interface Message {
  role: string
  content: unknown
  type?: string
  toolName?: string
}

export class ObservationMasker {
  constructor(private readonly maxToolResults: number = 20) {}

  mask(messages: Message[]): Message[] {
    const toolIndices: number[] = []
    messages.forEach((m, i) => {
      if (m.role === 'tool' || m.type === 'tool_result') toolIndices.push(i)
    })

    if (toolIndices.length <= this.maxToolResults) return messages

    const maskCount = toolIndices.length - this.maxToolResults
    const masked = new Set(toolIndices.slice(0, maskCount))

    return messages.map((m, i) =>
      masked.has(i) ? { ...m, content: '[masked — observation window]' } : m
    )
  }
}
