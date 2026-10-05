export function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function nextParam(): string {
  const n = new URLSearchParams(location.search).get("next");
  return n && n.startsWith("/") ? n : "/games";
}
