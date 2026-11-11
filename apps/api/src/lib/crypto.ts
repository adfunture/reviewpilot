import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { config, sessionSecret } from "../config.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

function key(): Buffer {
  const raw = config().ENCRYPTION_KEY;
  if (!raw) {
    if (config().NODE_ENV === "production") throw new Error("ENCRYPTION_KEY fehlt");
    return Buffer.alloc(32, 7); // nur Entwicklung/Test
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("ENCRYPTION_KEY muss 32 Byte (base64) lang sein");
  return buf;
}

/** AES-256-GCM; Format: v1.<iv>.<tag>.<ciphertext> (base64url) */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decrypt(payload: string): string {
  const [v, iv, tag, ct] = payload.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Unbekanntes Verschlüsselungsformat");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Signierter Token (für Session-Cookie und Abmeldelinks) */
export function sign(value: string, purpose: string): string {
  const mac = createHmac("sha256", sessionSecret()).update(`${purpose}:${value}`).digest("base64url");
  return `${Buffer.from(value).toString("base64url")}.${mac}`;
}

export function unsign(token: string, purpose: string): string | null {
  const [v, mac] = token.split(".");
  if (!v || !mac) return null;
  const value = Buffer.from(v, "base64url").toString("utf8");
  const expected = createHmac("sha256", sessionSecret()).update(`${purpose}:${value}`).digest("base64url");
  return safeEqual(mac, expected) ? value : null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const computed = await scrypt(password, Buffer.from(salt, "base64"), 64);
  return safeEqual(computed.toString("base64"), hash);
}
