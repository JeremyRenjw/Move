import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChatAttachment, ChatMessage } from '@shared/types'

export class AttachmentStore {
  private root: string

  constructor(userData: string) {
    this.root = path.join(userData, 'attachments')
  }

  async persistMessages(petId: string, messages: ChatMessage[]): Promise<ChatMessage[]> {
    return Promise.all(messages.map(async msg => {
      if (!msg.attachments || msg.attachments.length === 0) return msg
      return { ...msg, attachments: await this.persist(petId, msg.attachments) }
    }))
  }

  async hydrateMessages(messages: ChatMessage[]): Promise<ChatMessage[]> {
    return Promise.all(messages.map(async msg => {
      if (!msg.attachments || msg.attachments.length === 0) return msg
      return { ...msg, attachments: await this.hydrate(msg.attachments) }
    }))
  }

  async persist(petId: string, attachments?: ChatAttachment[]): Promise<ChatAttachment[] | undefined> {
    if (!attachments || attachments.length === 0) return undefined

    const out: ChatAttachment[] = []
    for (const attachment of attachments) {
      if (!attachment.data) {
        out.push(this.withoutData(attachment))
        continue
      }

      const fileName = `${Date.now()}-${randomUUID()}${this.extensionFor(attachment)}`
      const storageId = path.posix.join(this.safeSegment(petId), fileName)
      const filePath = this.fullPath(storageId)
      await fs.mkdir(path.dirname(filePath), { recursive: true })

      const bytes = attachment.type === 'image'
        ? Buffer.from(attachment.data, 'base64')
        : Buffer.from(attachment.data, 'utf-8')
      await fs.writeFile(filePath, bytes)

      out.push({
        type: attachment.type,
        name: attachment.name,
        mime: attachment.mime,
        storageId,
        size: bytes.length,
      })
    }

    return out
  }

  async hydrate(attachments?: ChatAttachment[]): Promise<ChatAttachment[] | undefined> {
    if (!attachments || attachments.length === 0) return undefined

    return Promise.all(attachments.map(async attachment => {
      if (attachment.data || !attachment.storageId) return attachment
      try {
        const bytes = await fs.readFile(this.fullPath(attachment.storageId))
        return {
          ...attachment,
          data: attachment.type === 'image' ? bytes.toString('base64') : bytes.toString('utf-8'),
        }
      } catch {
        return attachment
      }
    }))
  }

  private withoutData(attachment: ChatAttachment): ChatAttachment {
    const { data: _data, ...rest } = attachment
    return rest
  }

  private extensionFor(attachment: ChatAttachment): string {
    const ext = path.extname(attachment.name).toLowerCase()
    if (/^\.[a-z0-9]+$/.test(ext)) return ext
    if (attachment.type === 'image') return '.img'
    return '.txt'
  }

  private safeSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, '_') || 'default'
  }

  private fullPath(storageId: string): string {
    const normalized = path.normalize(storageId)
    if (path.isAbsolute(normalized) || normalized.startsWith('..')) {
      throw new Error('Invalid attachment storage id')
    }
    const filePath = path.join(this.root, normalized)
    const rel = path.relative(this.root, filePath)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('Invalid attachment storage id')
    }
    return filePath
  }
}
