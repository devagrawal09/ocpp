export * as CredentialSeal from "./seal.js"

import type { CredentialFact } from "@ocpp/schema/credential-fact"
import { Effect } from "effect"

// AES-GCM through Web Crypto, which every runtime OC++ runs on provides. A key belongs to one credential.
const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64")
const decode = (text: string) => new Uint8Array(Buffer.from(text, "base64"))
const importKey = (key: string) => crypto.subtle.importKey("raw", decode(key), "AES-GCM", false, ["encrypt", "decrypt"])

/** A new random 256-bit key, base64. */
export const generateKey = () => encode(crypto.getRandomValues(new Uint8Array(32)))

/** Encrypts a value as JSON under the key, with a fresh IV. */
export const seal = (key: string, value: unknown) =>
  Effect.promise(async (): Promise<CredentialFact.Sealed> => {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const data = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await importKey(key),
      new TextEncoder().encode(JSON.stringify(value)),
    )
    return { iv: encode(iv), data: encode(new Uint8Array(data)) }
  })

/** Decrypts a sealed value with its key. */
export const open = (key: string, sealed: CredentialFact.Sealed) =>
  Effect.promise(async (): Promise<unknown> => {
    const data = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode(sealed.iv) },
      await importKey(key),
      decode(sealed.data),
    )
    return JSON.parse(new TextDecoder().decode(data))
  })
