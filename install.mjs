#!/usr/bin/env node
// Copies the extension to ~/.pi/agent/extensions/autodev and registers it in pi settings.

import { createRequire } from 'module'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PI_EXTENSIONS_DIR = path.join(os.homedir(), '.pi', 'agent', 'extensions', 'autodev')
const PI_SETTINGS = path.join(os.homedir(), '.pi', 'settings.json')

async function main() {
  // Copy dist/ to extensions dir
  await fs.mkdir(PI_EXTENSIONS_DIR, { recursive: true })
  await copyDir(path.join(__dirname, 'dist'), PI_EXTENSIONS_DIR)

  // Copy package.json
  await fs.copyFile(
    path.join(__dirname, 'package.json'),
    path.join(PI_EXTENSIONS_DIR, 'package.json')
  )

  // Register in pi settings
  let settings = {}
  try {
    const raw = await fs.readFile(PI_SETTINGS, 'utf-8')
    settings = JSON.parse(raw)
  } catch {
    // settings.json missing or empty — start fresh
  }

  const extPath = path.join(PI_EXTENSIONS_DIR, 'extension', 'index.js')
  const extensions = (settings.extensions ?? [])
  if (!extensions.includes(extPath)) {
    settings.extensions = [...extensions, extPath]
    await fs.mkdir(path.dirname(PI_SETTINGS), { recursive: true })
    await fs.writeFile(PI_SETTINGS, JSON.stringify(settings, null, 2))
    console.log(`[pi-autodev] Registered at ${extPath}`)
  } else {
    console.log('[pi-autodev] Already registered, skipping')
  }
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true })
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath)
    } else {
      await fs.copyFile(srcPath, destPath)
    }
  }
}

main().catch(err => { console.error('[pi-autodev] install failed:', err); process.exit(1) })
