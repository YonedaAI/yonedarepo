export async function sha(content: string) {
  return [
    ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))),
  ]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
