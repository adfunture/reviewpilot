import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto mt-24 max-w-md px-4 text-center">
      <h1 className="text-xl font-semibold">Seite nicht gefunden</h1>
      <Link href="/" className="mt-4 inline-block text-sm underline">Zur Übersicht</Link>
    </div>
  );
}
