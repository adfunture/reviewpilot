"use client";
import { useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Input, Label } from "@/components/ui";
import { api } from "@/lib/api";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/login", { method: "POST", body: { email, password } });
      window.location.href = "/";
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mt-24 max-w-sm px-4">
      <Card title="ReviewPilot – Anmeldung">
        <form onSubmit={submit} className="space-y-3">
          <label className="block">
            <Label>E-Mail</Label>
            <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label className="block">
            <Label>Passwort</Label>
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          <ErrorText error={error} />
          <Button type="submit" disabled={busy} className="w-full">
            Anmelden
          </Button>
        </form>
      </Card>
    </div>
  );
}
