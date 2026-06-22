import * as fs from 'fs/promises'
import * as path from 'path'

export interface ContractCriteria {
  [key: string]: boolean
}

export class H1Contract {
  private evidenceRead = new Set<string>()
  private contractPath: string

  constructor(cwd: string, milestone: string) {
    this.contractPath = path.join(cwd, '.autodev', `contract.${milestone}.json`)
  }

  async init(criteria: string[]): Promise<void> {
    const initial: ContractCriteria = {}
    for (const c of criteria) initial[c] = false
    await fs.mkdir(path.dirname(this.contractPath), { recursive: true })
    await fs.writeFile(this.contractPath, JSON.stringify(initial, null, 2))
  }

  recordEvidenceRead(criterion: string): void {
    this.evidenceRead.add(criterion)
  }

  canFlip(criterion: string): boolean {
    return this.evidenceRead.has(criterion)
  }

  async flip(criterion: string): Promise<{ ok: boolean; reason?: string }> {
    if (!this.canFlip(criterion)) {
      return { ok: false, reason: `No evidence read for criterion "${criterion}"` }
    }
    const raw = await fs.readFile(this.contractPath, 'utf-8')
    const data: ContractCriteria = JSON.parse(raw)
    data[criterion] = true
    await fs.writeFile(this.contractPath, JSON.stringify(data, null, 2))
    return { ok: true }
  }

  async read(): Promise<ContractCriteria> {
    const raw = await fs.readFile(this.contractPath, 'utf-8')
    return JSON.parse(raw) as ContractCriteria
  }

  async allPassed(): Promise<boolean> {
    const data = await this.read()
    return Object.values(data).every(v => v === true)
  }
}
