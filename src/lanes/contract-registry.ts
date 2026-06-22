// M4: G18 contract registry — lanes publish shared boundary changes here
// so the integrator can broker-before-merge.

export type BoundaryType = 'interface' | 'type' | 'class' | 'function' | 'enum'

export interface ContractEntry {
  symbol: string
  type: BoundaryType
  laneId: string
  description: string
  publishedAt: string
}

export class ContractRegistry {
  private entries: ContractEntry[] = []

  publish(entry: Omit<ContractEntry, 'publishedAt'>): void {
    this.entries.push({ ...entry, publishedAt: new Date().toISOString() })
  }

  isBrokered(symbol: string): boolean {
    return this.entries.some((e) => e.symbol === symbol)
  }

  getAll(): ContractEntry[] {
    return [...this.entries]
  }

  getBySymbol(symbol: string): ContractEntry | undefined {
    return this.entries.find((e) => e.symbol === symbol)
  }
}
